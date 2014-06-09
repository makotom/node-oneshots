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
			type : messageTypeRegex.test(type) ? type : "unknown",
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

		terminateWorker = function () {
			this.removeAllListeners();
			this.kill();
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
				worker.terminate = terminateWorker;
			}

			worker.isIdle = false;

			return worker;
		},
		idleWorker = function (worker) {
			worker.isIdle = true;
			worker.stopIdling = setTimeout(function () {
				worker.terminate();
			}, CONFIG.workersKeepIdle * 1000);
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
					idleWorker(worker);
				});
			},

			abortWorker = function () {
				worker.terminate();
				setImmediate(scheduleEnd);
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
						break;

					default:
						// console.log(workerMes);
				}
			};

			worker.send(new RequestHeaderMessenger(salt, invoking, req));

			req.on("data", function (bodyChunk) {
				var messageContainer = new Messenger(salt, "body", null), p = 0;

				while (p < bodyChunk.length) {
					messageContainer.payload = bodyChunk.slice(
						p,
						p = p + CONFIG.messageCap < bodyChunk.length ? p + CONFIG.messageCap : bodyChunk.length
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
				worker.terminate();
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
			var salt = request.salt,

			responseHeaders = [],
			isHeaderSent = false,

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

						if (typeof statusTerms[0] !== typeof undefined) {
							messageContainer.payload.reasonPhrase = statusTerms.join(" ").toString();
						}
					} else {
						messageContainer.payload.headers[fieldName] = parts.join(":");
					}
				});

				process.send(messageContainer);
			};

			return {
				request : {
					socket : request.header.socket,
					header : request.header.http,
					env : request.header.env,
					body : Buffer.concat(request.body)
				},

				setHeader : function (expr) {
					responseHeaders.push(expr);
				},

				echo : function (bodyChunk) {
					var messageContainer = new Messenger(salt, "body", null), p = 0;

					if (isHeaderSent === false) {
						flushHeaders();
						isHeaderSent = true;
					}

					while (p < bodyChunk.length) {
						messageContainer.payload = bodyChunk.slice(
							p,
							p = p + CONFIG.messageCap < bodyChunk.length ? p + CONFIG.messageCap : bodyChunk.length
						);
						process.send(messageContainer);
					}
				},
				end : function () {
					if (isHeaderSent === false) {
						flushHeaders();
						isHeaderSent = true;
					}

					process.send(new Messenger(salt, "end"));
				}
			};
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
						body : []
					};
					break;

				case "body":
					if (messenger.salt === request.salt) {
						request.body.push(new Buffer(messenger.payload));
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
