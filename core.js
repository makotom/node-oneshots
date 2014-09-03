// Copyright (C) 2014 Makoto Mizukami

(function () {
	"use strict";

	var CONFIG = {
		serverUid : "http",
		serverGid : "http",
		listenIPv4 : true,
		listenIPv6 : true,
		servicePort : 37320,
		workersMaxNum : 64,
		workersKeepIdle : 7200,	// Unit: second
		workersTimeout : 60,	// Unit: second
		messageExpiry : 500,	// Unit: millisecond
		messageCap : 1024 * 32	// Unit: octet
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

	Nodebed = function () {},

	cluster = require("cluster");

	Nodebed.prototype.balancer = function () {
		var server = require("./scgi.js").createServer(),

		url = require("url"),

		idleWorker = function () {
			this.isIdle = true;
			this.stopIdling = setTimeout(this.kill.bind(this), CONFIG.workersKeepIdle * 1000);
		},

		invokeWorker = function (path) {
			var worker = null, numOfActiveWorkers = 0;

			for (let workerId in cluster.workers) {
				numOfActiveWorkers += 1;

				if (cluster.workers[workerId].workFor === path && cluster.workers[workerId].isIdle === true) {
					worker = cluster.workers[workerId];
					clearTimeout(cluster.workers[workerId].stopIdling);
					break;
				}
			}

			if (worker === null) {
				if (numOfActiveWorkers >= CONFIG.workersMaxNum) {
					return null;
				}

				worker = cluster.fork();
				worker.workFor = path;
				worker.idle = idleWorker;
			}

			worker.isIdle = false;

			return worker;
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

					break;

				case "body":
					res.write(new Buffer(workerMes.payload));
					break;

				case "end":
					res.end();
					worker.removeListener("message", this.workerMessageReceiver);
					worker.removeListener("exit", this.workerAbendNotifier);
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

		onWorkerAbend = function () {
			this.res.setStatus(500);
			this.res.end();
		},

		timeoutResponse = function () {
			this.res.setStatus(408);
			this.res.write("Timed out.");
			this.res.end();
			this.worker.kill();
		},

		responder = function (req, res) {
			var salt = Math.random(),
			requested = url.parse(req.params.SCRIPT_FILENAME.replace(/^proxy:scgi:/, "scgi:")),
			invoking = url.parse(requested.pathname).pathname,

			worker = invokeWorker(invoking),

			resources = {
				salt : salt,
				res : res,
				worker : worker
			};

			if (worker === null) {
				res.setStatus(503);
				res.write("No vacancy for your request.");
				res.end();
				return;
			}

			resources.workerMessageReceiver = workerMessageReceptor.bind(resources);
			resources.workerAbendNotifier = onWorkerAbend.bind(resources);

			worker.send(new RequestHeaderMessenger(salt, invoking, req));

			req.on("data", onReqData.bind(resources));
			req.on("end", onReqEnd.bind(resources));
			res.on("close", onResClose.bind(resources));

			worker.on("exit", resources.workerAbendNotifier);

			req.setTimeout(CONFIG.workersTimeout * 1000, timeoutResponse.bind(resources));
		};

		CONFIG.listenIPv4 && server.listen(CONFIG.servicePort, "0.0.0.0");
		CONFIG.listenIPv6 && server.listen(CONFIG.servicePort, "::");

		server.on("request", responder);
	};

	Nodebed.prototype.worker = function () {
		var built = null, request = null,

		fs = require("fs"),

		parseStr = function (str) {
			var ret = {};

			str.toString().split("&").forEach(function (term) {
				var eqSplit = term.split("="),
				fieldName = decodeURIComponent(eqSplit.shift());

				if (fieldName === "") {
					return;
				}

				ret[fieldName] = decodeURIComponent(eqSplit.join("="));
			});

			return ret;
		},

		genInstanceInterface = function (request) {
			var ret = {},

			salt = request.salt,

			responseStatus = NaN,
			responseHeaders = [],
			isHeaderSent = false,

			bCache = {
				chunks : [],
				cachedLength : 0,
				autoFlush : null
			},

			flushHeaders = function () {
				var messageContainer = new ResponseHeaderMessenger(salt, responseHeaders);

				if(! isNaN(responseStatus)) {
					messageContainer.payload.statusCode = responseStatus;
				}

				process.send(messageContainer);
				isHeaderSent = true;
			};

			ret.request = {
				params : request.header.params,
				body : Buffer.concat(request.body.chunks, request.body.length),
				formData : {}
			};

			ret.request.formData.GET = parseStr(request.header.params.QUERY_STRING || "");
			ret.request.formData.POST = parseStr(request.header.params.REQUEST_METHOD.toUpperCase() === "POST" && request.header.params.CONTENT_TYPE.toLowerCase() === "application/x-www-form-urlencoded" ? ret.request.body.toString() : "");

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

				bCache.autoFlush !== null && clearTimeout(bCache.autoFlush);

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
				bCache.autoFlush = null;
			};

			ret.echo = function(data) {
				var toBeCached = null;

				isHeaderSent === false && flushHeaders();

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
				} else if (bCache.autoFlush === null) {
					bCache.autoFlush = setTimeout(ret.flush, CONFIG.messageExpiry);
				}
			};

			ret.end = function () {
				ret.flush();
				process.send(new Messenger(salt, "end"));
			};

			return ret;
		},

		buildRequestedScript = function (invoking) {
			built = require(invoking);
			built.builtAt = new Date();
		},

		respondBalancerRequest = function (request) {
			var instanceInterface = genInstanceInterface(request);

			try {
				process.chdir(require("path").dirname(fs.realpathSync(request.header.invoking)));

				if (built === null) {
					buildRequestedScript(request.header.invoking);
				} else {
					for (let cachedHash in require.cache) {
						let cached = require.cache[cachedHash];

						if (fs.statSync(cached.filename).ctime.getTime() > built.builtAt.getTime()) {
							for (let cachedHash in require.cache) {
								delete require.cache[cachedHash];
							}

							buildRequestedScript(request.header.invoking);

							break;
						}
					}
				}

				instanceInterface.setHeader("Content-Type: text/html; charset=UTF-8");
				built.exec(instanceInterface);
			} catch (e) {
				console.log(e.stack);
				instanceInterface.setStatus(500);
				instanceInterface.echo("Error during script execution.");
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
		new Nodebed().balancer();
	} else if (cluster.isWorker === true) {
		new Nodebed().worker();
	}
})();
