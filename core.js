// Copyright (C) 2014 Makoto Mizukami

(function () {
	"use strict";

	var CONFIG = {
		serverUid : "http",
		serverGid : "http",
		serviceAddr : ["0.0.0.0", "::"],
		servicePort : 37320,
		workersMaxNum : 64,
		workersKeepIdle : 7200,	// Unit: second
		workersTimeout : 60,	// Unit: second
		messageExpiry : 500,	// Unit: millisecond
		messageCap : 1024 * 32	// Unit: octet
	},

	Messenger = function (nonce, type, payload) {
		var messageTypeRegex = /^(?:header|body|end)$/;

		this.nonce = nonce;
		this.type = messageTypeRegex.test(type) === true ? type : "unknown";
		this.payload = payload;
	},

	RequestHeaderMessenger = function (nonce, invoking, req) {
		Messenger.call(this, nonce, "header", {
			invoking : invoking,
			params : req.params
		});
	},

	ResponseHeaderMessenger = function (nonce, headers) {
		Messenger.call(this, nonce, "header", {
			statusCode : 200,
			headers : headers
		});
	},

	Nodebed = function () {},

	cluster = require("cluster");

	Nodebed.prototype.balancer = function () {
		var server = require("./fcgi.js").createServer(),

		url = require("url"),

		idleWorker = function () {
			this.isIdle = true;
			this.stopIdling = setTimeout(this.kill.bind(this), CONFIG.workersKeepIdle * 1000);
			this.visitedAt = new Date();
		},

		invokeWorker = function (path) {
			var worker = null, oldestIdleWorker = null, numOfActiveWorkers = 0;

			for (let workerId in cluster.workers) {
				if (cluster.workers.hasOwnProperty(workerId)) {
					numOfActiveWorkers += 1;

					if (cluster.workers[workerId].isIdle === true) {
						if (cluster.workers[workerId].workFor === path) {
							worker = cluster.workers[workerId];
							clearTimeout(cluster.workers[workerId].stopIdling);
							break;
						} else if (oldestIdleWorker === null || cluster.workers[workerId].visitedAt.getTime() < oldestIdleWorker.visitedAt.getTime()) {
							oldestIdleWorker = cluster.workers[workerId];
						}
					}
				}
			}

			if (worker === null) {
				if (numOfActiveWorkers >= CONFIG.workersMaxNum) {
					if (oldestIdleWorker) {
						oldestIdleWorker.kill();
					} else {
						return null;
					}
				}

				worker = cluster.fork();
				worker.workFor = path;
				worker.idle = idleWorker;
			}

			worker.isIdle = false;
			worker.visitedAt = new Date();

			return worker;
		},

		workerMessageReceptor = function (workerMes) {
			if (workerMes.nonce !== this.nonce) {
				return;
			}

			switch (workerMes.type) {
				case "header":
					if (! isNaN(workerMes.payload.statusCode)) {
						this.res.setStatus(workerMes.payload.statusCode);
					}

					for (let i = 0; i < workerMes.payload.headers.length; i += 1) {
						this.res.setHeader(workerMes.payload.headers[i]);
					}

					break;

				case "body":
					this.res.write(new Buffer(workerMes.payload));
					break;

				case "end":
					this.res.end();
					this.worker.removeListener("message", this.workerMessageReceiver);
					clearTimeout(this.timer);
					this.worker.removeListener("exit", this.workerAbendNotifier);
					this.worker.idle();
					break;

				default:
					break;
			}
		},

		onReqData = function (bChunk) {
			var messageContainer = new Messenger(this.nonce, "body", null), p = 0;

			while (p < bChunk.length) {
				messageContainer.payload = bChunk.slice(
					p,
					p = p + CONFIG.messageCap < bChunk.length ? p + CONFIG.messageCap : bChunk.length
				);
				this.worker.send(messageContainer);
			}
		},

		onReqEnd = function () {
			this.worker.send(new Messenger(this.nonce, "end"));
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
			var nonce = Math.random(),
			requested = url.parse(req.params.SCRIPT_FILENAME.replace(/^proxy:fcgi:/, "fcgi:")),
			invoking = url.parse(requested.pathname).pathname,

			worker = invokeWorker(invoking),

			resources = {
				nonce : nonce,
				res : res,
				worker : worker,
			};

			if (worker === null) {
				res.setStatus(503);
				res.write("No vacancy for your request.");
				res.end();
				return;
			}

			resources.workerMessageReceiver = workerMessageReceptor.bind(resources);
			resources.workerAbendNotifier = onWorkerAbend.bind(resources);

			worker.send(new RequestHeaderMessenger(nonce, invoking, req));

			req.on("data", onReqData.bind(resources));
			req.on("end", onReqEnd.bind(resources));
			res.on("close", onResClose.bind(resources));

			worker.on("exit", resources.workerAbendNotifier);

			resources.timer = setTimeout(timeoutResponse.bind(resources), CONFIG.workersTimeout * 1000);
		};

		CONFIG.serviceAddr.forEach(function (addr) {
			server.listen(CONFIG.servicePort, addr);
		});

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

			nonce = request.nonce,

			responseStatus = NaN,
			responseHeaders = [],
			isHeaderSent = false,

			bCache = {
				chunks : [],
				cachedLength : 0,
				autoFlush : null
			},

			flushHeaders = function () {
				var messageContainer = new ResponseHeaderMessenger(nonce, responseHeaders);

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
				var messageContainer = new Messenger(nonce, "body", null),
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
				process.send(new Messenger(nonce, "end"));
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
						if (require.cache.hasOwnProperty(cachedHash)) {
							let cached = require.cache[cachedHash];

							if (fs.statSync(cached.filename).ctime.getTime() > built.builtAt.getTime()) {
								for (let cachedHash in require.cache) {
									if (require.cache.hasOwnProperty(cachedHash)) {
										delete require.cache[cachedHash];
									}
								}

								buildRequestedScript(request.header.invoking);

								break;
							}
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
						nonce : messenger.nonce,
						header : messenger.payload,
						body : {
							length : 0,
							chunks : []
						}
					};
					break;

				case "body":
					if (messenger.nonce === request.nonce) {
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

	CONFIG.serverGid && process.setgid(CONFIG.serverGid);
	CONFIG.serverUid && process.setuid(CONFIG.serverUid);

	if (cluster.isMaster === true) {
		new Nodebed().balancer();
	} else if (cluster.isWorker === true) {
		new Nodebed().worker();
	}
})();
