(function () {
	"use strict";

	var CONFIG = {
		serverUid : "http",
		serverGid : "http",
		listenIPv4 : true,
		listenIPv6 : true,
		servicePort : 37320,
		workersKeepIdle : 3600,	// Unit: second
		workersTimeout : 60,	// Unit: second
		messageCap : 1024 * 16	// Unit: octet
	},

	Messenger = function (salt, type, payload) {
		var messageTypeRegex = /^(?:header|body|end)$/;

		return {
			salt : salt,
			type : messageTypeRegex.test(type) === true ? type : "unknown",
			payload : payload
		};
	},
	RequestHeaderMessenger = function (salt, invoking, req) {
		return new Messenger(salt, "header", {
			invoking : invoking,
			socket : {
				remoteAddress : req.socket.remoteAddress,
				remotePort : req.socket.remotePort,
				localAddress : req.socket.localAddress,
				localPort : req.socket.localPort
			},
			http : {
				version : req.httpVersion,
				method : req.method,
				uri : req.url,
				headers : req.headers
			},
			env : req.cgiParams
		});
	},
	ResponseHeaderMessenger = function (salt) {
		return new Messenger(salt, "header", {
			statusCode : 200,
			reasonPhrase : undefined,
			headers : {}
		});
	},

	NodePool = function () {},

	cluster = require("cluster");

	NodePool.prototype.balancer = function () {
		var server = require("node-fastcgi").createServer(),

		url = require("url"),

		idleWorker = function () {
			var self = this;

			self.isIdle = true;
			self.stopIdling = setTimeout(function () {
				self.kill();
			}, CONFIG.workersKeepIdle * 1000);
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

		responder = function (req, res) {
			var salt = Math.random(),
			requested = url.parse(req.cgiParams.SCRIPT_FILENAME.replace(/^[^:]*:fcgi:/, "fcgi:")),
			invoking = url.parse(requested.pathname).pathname,

			worker = invokeWorker(invoking),

			scheduleEnd = function () {
				if (res.stdout._writableState.buffer.length > 0) {
					res.stdout.on("drain", scheduleEnd);
					return;
				}

				setImmediate(function () {
					res.end();
				});
			},

			abortWorker = function () {
				setImmediate(scheduleEnd);
				worker.kill();
			},

			workerMessageReceptor = function (workerMes) {
				if (workerMes.salt !== salt) {
					// console.log(workerMes);
					return;
				}

				switch (workerMes.type) {
					case "header":
						if (typeof workerMes.payload.reasonPhrase === typeof "") {
							res.writeHead(
								workerMes.payload.statusCode,
								workerMes.payload.reasonPhrase,
								workerMes.payload.headers
							);
						} else {
							res.writeHead(workerMes.payload.statusCode, workerMes.payload.headers);
						}

						clearTimeout(worker.timeout);
						worker.timeout = setTimeout(abortWorker, CONFIG.workersTimeout * 1000);

						break;

					case "body":
						res.write(new Buffer(workerMes.payload));
						clearTimeout(worker.timeout);
						worker.timeout = setTimeout(abortWorker, CONFIG.workersTimeout * 1000);
						break;

					case "end":
						setImmediate(scheduleEnd);
						clearTimeout(worker.timeout);
						worker.removeListener("message", workerMessageReceptor);
						worker.idle();
						break;

					default:
						// console.log(workerMes);
				}
			};

			res.stdout.conn.socket._write = require("./patch_socket.js")._write;

			worker.send(new RequestHeaderMessenger(salt, invoking, req));

			req.on("data", function (bChunk) {
				var messageContainer = new Messenger(salt, "body", null), p = 0;

				while (p < bChunk.length) {
					messageContainer.payload = bChunk.slice(
						p,
						p = p + CONFIG.messageCap < bChunk.length ? p + CONFIG.messageCap : bChunk.length
					);
					worker.send(messageContainer);
				}
			});

			req.on("end", function () {
				worker.send(new Messenger(salt, "end"));
				worker.on("message", workerMessageReceptor);
				worker.timeout = setTimeout(abortWorker, CONFIG.workersTimeout * 1000);
			});

			res.on("close", function () {
				clearTimeout(worker.timeout);
				worker.kill();
			});
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

			responseHeaders = [],
			isHeaderSent = false,

			bCache = {
				chunks : [],
				cachedLength : 0
			},

			flushHeaders = function () {
				var messageContainer = new ResponseHeaderMessenger(salt);

				responseHeaders.forEach(function (expr) {
					var parts = expr.trim().split(":"), fieldName = parts.shift();

					if (parts.length < 1) {
						return;
					}

					if (/^Status$/i.test(fieldName) === true) {
						let statusTerms = parts.join(":").trim().split(" ");

						messageContainer.payload.statusCode = parseInt(statusTerms.shift(), 10);

						if (statusTerms[0] !== undefined) {
							messageContainer.payload.reasonPhrase = statusTerms.join(" ").toString();
						}
					} else {
						messageContainer.payload.headers[fieldName] = parts.join(":");
					}
				});

				process.send(messageContainer);
				isHeaderSent = true;
			};

			ret.request = {
				socket : request.header.socket,
				header : request.header.http,
				env : request.header.env,
				body : Buffer.concat(request.body.chunks, request.body.length)
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
				instanceInterface.setHeader("Status: 500");
				instanceInterface.end();
				// console.log(e);
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
					// console.log(messenger);
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
