(function () {
	"use strict";

	var CONFIG = {
		serverUid : "http",
		serverGid : "http",
		listenIPv4 : true,
		listenIPv6 : true,
		servicePort : 37320,
		workersKeepIdle : 7200,	// Unit: second
		workersTimeout : 60,	// Unit: second
		messageCap : 1024 * 16	// Unit: octet
	},

	Messenger = function (salt, type, payload) {
		var messageTypeRegex = /^(?:header|body|end)$/;

		this.salt = salt;
		this.type = messageTypeRegex.test(type) === true ? type : "unknown";
		this.payload = payload;
	},
	RequestHeaderMessenger = function (salt, invoking, req) {
		Messenger.call(this, salt, "header", {
			invoking : invoking,
			params : req.params
		});
	},
	ResponseHeaderMessenger = function (salt, headers) {
		Messenger.call(this, salt, "header", {
			statusCode : 200,
			headers : headers
		});
	},

	NodePool = function () {},

	cluster = require("cluster");

	NodePool.prototype.balancer = function () {
		var server = require("./scgi.js").createServer(),

		url = require("url"),

		idleWorker = function () {
			this.isIdle = true;
			this.stopIdling = setTimeout(this.kill.bind(this), CONFIG.workersKeepIdle * 1000);
		},

		invokeWorker = function (path) {
			var worker = null;

			for (let workerId in cluster.workers) {
				if (cluster.workers[workerId].workFor === path && cluster.workers[workerId].isIdle === true) {
					worker = cluster.workers[workerId];
					clearTimeout(cluster.workers[workerId].stopIdling);
					break;
				}
			}

			if (worker === null) {
				worker = cluster.fork();
				worker.workFor = path;
				worker.idle = idleWorker;
			}

			worker.isIdle = false;

			return worker;
		},

		timeoutResponse = function () {
			this.res.setStatus(408);
			this.res.flushHeaders(true);
			this.res.end();
			this.worker.kill();
		},

		workerMessageReceptor = function (workerMes) {
			var res = this.res, worker = this.worker;

			if (workerMes.salt !== this.salt) {
				return;
			}

			switch (workerMes.type) {
				case "header":
					if (! isNaN(workerMes.payload.statusCode)) {
						res.setStatus(workerMes.payload.statusCode);
					}

					workerMes.payload.headers.forEach(function (header) {
						res.setHeader(header);
					});

					res.flushHeaders();

					break;

				case "body":
					res.write(new Buffer(workerMes.payload));
					break;

				case "end":
					res.end();
					worker.removeListener("message", this.workerMessageReceiver);
					worker.idle();
					break;

				default:
					break;
			}
		},

		onReqData = function (bChunk) {
			var messageContainer = new Messenger(this.salt, "body", null), p = 0;

			while (p < bChunk.length) {
				messageContainer.payload = bChunk.slice(
					p,
					p = p + CONFIG.messageCap < bChunk.length ? p + CONFIG.messageCap : bChunk.length
				);
				this.worker.send(messageContainer);
			}
		},

		onReqEnd = function () {
			this.worker.send(new Messenger(this.salt, "end"));
			this.worker.on("message", this.workerMessageReceiver);
		},

		onResClose = function () {
			this.worker.kill();
		},

		responder = function (req, res) {
			var salt = Math.random(),
			requested = url.parse(req.params.SCRIPT_FILENAME.replace(/^[^:]*:scgi:/, "scgi:")),
			invoking = url.parse(requested.pathname).pathname,

			worker = invokeWorker(invoking),

			resources = {
				salt : salt,
				res : res,
				worker : worker
			};

			resources.workerMessageReceiver = workerMessageReceptor.bind(resources);

			worker.send(new RequestHeaderMessenger(salt, invoking, req));

			req.on("data", onReqData.bind(resources));
			req.on("end", onReqEnd.bind(resources));
			res.on("close", onResClose.bind(resources));

			req.setTimeout(CONFIG.workersTimeout * 1000, timeoutResponse.bind(resources));
		};

		CONFIG.listenIPv4 && server.listen(CONFIG.servicePort, "0.0.0.0");
		CONFIG.listenIPv6 && server.listen(CONFIG.servicePort, "::");

		server.on("request", responder);
	};

	NodePool.prototype.worker = function () {
		var built = null, request = null,

		fs = require("fs"),

		genInstanceInterface = function (request) {
			var ret = {},

			salt = request.salt,

			responseStatus = NaN,
			responseHeaders = [],
			isHeaderSent = false,

			bCache = {
				chunks : [],
				cachedLength : 0
			},

			flushHeaders = function () {
				var messageContainer = new ResponseHeaderMessenger(salt, responseHeaders);

				if(! isNaN(responseStatus)) {
					messageContainer.statusCode = responseStatus;
				}

				process.send(messageContainer);
				isHeaderSent = true;
			};

			ret.request = {
				params : request.header.params,
				body : Buffer.concat(request.body.chunks, request.body.length)
			};

			ret.setStatus = function (sCode, reasonPhrase) {
				responseStatus = parseInt(sCode, 10);

				if (reasonPhrase !== undefined) {
					responseHeaders.push(["Status:", sCode.toString(), reasonPhrase].join(" "));
				}
			};

			ret.setHeader = function (expr) {
				responseHeaders.push(expr);
			};

			ret.flush = function () {
				var messageContainer = new Messenger(salt, "body", null),
				bChunk = typeof bCache.chunks[0] === "string" ? bCache.chunks.join("") : Buffer.concat(bCache.chunks, bCache.chachedLength);

				isHeaderSent === false && flushHeaders();

				for (let p = 0; p < bChunk.length;) {
					messageContainer.payload = bChunk.slice(
						p,
						p = p + CONFIG.messageCap < bChunk.length ? p + CONFIG.messageCap : bChunk.length
					);
					process.send(messageContainer);
				}

				bCache.chunks = [];
				bCache.cachedLength = 0;
			};

			ret.echo = function(data) {
				var toBeCached = null;

				if (data === undefined || data === null || data.length === 0) {
					return;
				}

				if (Buffer.isBuffer(data) === true) {
					if (bCache.length > 0 && Buffer.isBuffer(bCache.chunks[0]) !== true) {
						ret.flush();
					}

					toBeCached = data;
				} else {
					if (bCache.length > 0 && typeof bCache.chunks[0] !== typeof "") {
						ret.flush();
					}

					toBeCached = typeof data === typeof "" ? data : data.toString();
				}

				if (bCache.cachedLength + toBeCached.length > CONFIG.messageCap) {
					ret.flush();
				}

				bCache.chunks.push(toBeCached);
				bCache.cachedLength += toBeCached.length;

				if (toBeCached.length > CONFIG.messageCap) {
					ret.flush();
				}
			};

			ret.end = function () {
				isHeaderSent === false && flushHeaders();
				ret.flush();
				process.send(new Messenger(salt, "end"));
			};

			return ret;
		},

		respondBalancerRequest = function (request) {
			var instanceInterface = genInstanceInterface(request);

			try {
				process.chdir(require("path").dirname(fs.realpathSync(request.header.invoking)));

				if (built === null || fs.statSync(request.header.invoking).ctime.getTime() > built.builtAt.getTime()) {
					delete require.cache[fs.realpathSync(request.header.invoking)];
					built = require(request.header.invoking);
					built.builtAt = new Date();
				}

				instanceInterface.setHeader("Content-Type: text/html; charset=UTF-8");
				built.exec(instanceInterface);
			} catch (e) {
				instanceInterface.setStatus(500);
				instanceInterface.end();
				cluster.worker.kill();
			}
		},

		balancerMessageReceptor = function (messenger) {
			switch (messenger.type) {
				case "header":
					request = {
						salt : messenger.salt,
						header : messenger.payload,
						body : {
							length : 0,
							chunks : []
						}
					};
					break;

				case "body":
					if (messenger.salt === request.salt) {
						let newBodyChunk = new Buffer(messenger.payload);

						request.body.chunks.push(newBodyChunk);
						request.body.length += newBodyChunk.length;
					}
					break;

				case "end":
					respondBalancerRequest(request);
					break;
				default:
					break;
			}
		};

		process.on("message", balancerMessageReceptor);
	};

	process.setuid(CONFIG.serverUid) && process.setgid(CONFIG.serverGid);

	if (cluster.isMaster === true) {
		new NodePool().balancer();
	} else if (cluster.isWorker === true) {
		new NodePool().worker();
	}
})();
