(function(){
	"use strict";

	var WORKERS_KEEP_ALIVE = 10,	// Unit: second
	WORKERS_TIMEOUT = 30,	// Unit: second
	MESSAGE_CAP = 1024 * 16,	// Unit: octet
	GW_PORT = 12345,

	// TODO: Check parameter integrity

	Messenger = function(salt, type, payload){
		var messageTypeRegex = /^(?:header|body|end)$/;

		return {
			salt : salt,
			type : messageTypeRegex.test(type) ? type : "unknown",
			payload : payload
		};
	},
	HTTPRequestHeaderMessenger = function(salt, httpReq){
		return new Messenger(salt, "header", {
			httpVersion : httpReq.httpVersion,
			headers : httpReq.headers,
			method : httpReq.method,
			url : httpReq.url
		});
	},
	HTTPResponseHeaderMessenger = function(salt){
		return new Messenger(salt, "header", {
			statusCode : 200,
			reasonPhrase : undefined,
			headers : {}
		});
	},

	NodePool = function(){
	},

	cluster = require("cluster"), http = require("http");

	NodePool.prototype.balancer = function(){
		var workers = {}, httpd = http.createServer(),

		invokeWorker = function(path){	// Route incoming requests to workers; create new one if required
			var worker = null;

			if(typeof workers[path] === typeof []){
				(function(){
					var i = NaN;

					for(i = 0; i < workers[path].length; i += 1){
						if(workers[path][i].isIdle){
							worker = workers[path][i];
							break;
						}
					}
				})();
			}

			if(worker === null){
				worker = cluster.fork();
				worker.isActive = true;

				workers[path] = [worker];
			}

			worker.isIdle = false;
			worker.lastManaged = new Date();

			return worker;
		},
		idleWorker = function(worker){
			worker.isIdle = true;
			worker.lastManaged = new Date();
		},
		cleanupWorkers = function(){
			var path = "", killThreshold = new Date().getTime() - (WORKERS_KEEP_ALIVE * 1000);

			for(path in workers){
				if(workers.hasOwnProperty(path)){
					workers[path].forEach(function(workerInPool, keyInPath){
						if((!workerInPool.isAlive || workerInPool.isIdle)){
							if(workerInPool.lastManaged.getTime() < killThreshold){
								workerInPool.kill();
								workers[path].splice(keyInPath, 1);
							}
						}
					});
				}
			}
		},
		httpResponder = function(httpReq, httpRes){
			var salt = Math.random(),

			worker = invokeWorker(httpReq.url),

			timeoutWorker = function(){
				httpRes.end();
				worker.kill();
				worker.isActive = false;
			},
			timeoutTimer = setTimeout(timeoutWorker, WORKERS_TIMEOUT * 1000),

			workerMessageReceptor = function(workerMes){
				if(workerMes.salt !== salt){
					console.log(workerMes);
					return;
				}

				switch(workerMes.type){
					case "header":
						if(typeof workerMes.payload.reasonPhrase === typeof ""){
							httpRes.writeHead(
								workerMes.payload.statusCode,
								workerMes.payload.reasonPhrase,
								workerMes.payload.headers
							);
						}else{
							httpRes.writeHead(workerMes.payload.statusCode, workerMes.payload.headers);
						}

						clearTimeout(timeoutTimer);
						timeoutTimer = setTimeout(timeoutWorker, WORKERS_TIMEOUT * 1000);

						break;

					case "body":
						httpRes.write(new Buffer(workerMes.payload));
						clearTimeout(timeoutTimer);
						timeoutTimer = setTimeout(timeoutWorker, WORKERS_TIMEOUT * 1000);
						break;

					case "end":
						httpRes.end();
						worker.removeListener("message", workerMessageReceptor);
						idleWorker(worker);
						clearTimeout(timeoutTimer);
						break;

					default:
						console.log(workerMes);
				}
			};

			worker.send(new HTTPRequestHeaderMessenger(salt, httpReq));
			httpReq.on("data", function(bodyChunk){
				var messageContainer = new Messenger(salt, "body", null), p = 0;

				while(p < bodyChunk.length){
					messageContainer.payload = bodyChunk.slice(
						p,
						p = p + MESSAGE_CAP < bodyChunk.length ? p + MESSAGE_CAP : bodyChunk.length
					);
					worker.send(messageContainer);
				}
			});
			httpReq.on("end", function(){
				worker.send(new Messenger(salt, "end"));
				worker.on("message", workerMessageReceptor);
			});

		};

		httpd.listen(GW_PORT, "::");
		httpd.listen(GW_PORT, "0.0.0.0");

		httpd.on("request", httpResponder);

		setInterval(cleanupWorkers, WORKERS_KEEP_ALIVE * 1000);
	};

	NodePool.prototype.worker = function(){
		var script = null, request = null,

		fs = require("fs"),

		genHttpInterface = function(request){
			var salt = request.salt, httpResponseHeaders = [], isHeaderSent = false,

			flushHTTPHeaders = function(){
				var messageContainer = new HTTPResponseHeaderMessenger(salt);

				httpResponseHeaders.forEach(function(expr){
					var parts = expr.split(":");

					if(parts.length < 2){
						return;
					}
					if(/^Status$/i.test(parts[0])){
						parts.shift();

						(function(){
							var statusTerms = parts.join(":").trim().split(" ");

							messageContainer.payload.statusCode = parseInt(statusTerms[0], 10);

							statusTerms.shift();

							if(typeof statusTerms[0] !== typeof undefined){
								messageContainer.payload.reasonPhrase = statusTerms[0].toString();
							}
						})();
					}else{
						messageContainer.payload.headers[parts.shift()] = parts.join(":");
					}
				});

				process.send(messageContainer);
			};

			delete request.salt;

			return {
				header : function(expr){
					httpResponseHeaders.push(expr);
				},
				echo : function(bodyChunk){
					var messageContainer = new Messenger(salt, "body", null), p = 0;

					if(!isHeaderSent){
						flushHTTPHeaders();
						isHeaderSent = true;
					}

					while(p < bodyChunk.length){
						messageContainer.payload = bodyChunk.slice(
							p,
							p = p + MESSAGE_CAP < bodyChunk.length ? p + MESSAGE_CAP : bodyChunk.length
						);
						process.send(messageContainer);
					}
				},
				end : function(){
					if(!isHeaderSent){
						flushHTTPHeaders();
						isHeaderSent = true;
					}

					process.send(new Messenger(salt, "end"));
				}
			};
		},
		respondBalancerRequest = function(request){
			var httpInterface = genHttpInterface(request);

			httpInterface.header("Content-Type: text/html; charset=UTF-8");
			try{
				if(script === null || fs.statSync(request.header.url).mtime.getTime() > script.builtAt.getTime()){
					delete require.cache[fs.realpathSync(request.header.url)];
					script = require(request.header.url);
					script.builtAt = new Date();
				}

				script.request = request;
				script.header = httpInterface.header;
				script.echo = httpInterface.echo;
				script.end = httpInterface.end;

				script.exec();
			}
			catch(e){
				httpInterface.header("Status: 500");
				httpInterface.end();
				console.log(e);
			}
		},
		balancerMessageReceptor = function(messenger){
			switch(messenger.type){
				case "header":
					request = {
						salt : messenger.salt,
						header : messenger.payload,
						body : new Buffer(0)
					};
					break;

				case "body":
					if(messenger.salt === request.salt){
						request.body = Buffer.concat([request.body, new Buffer(messenger.payload)]);
					}
					break;

				case "end":
					respondBalancerRequest(request);
					break;
				dafault:
					console.log(messenger);
			}
		};

		process.on("message", balancerMessageReceptor);
	};

	if(cluster.isMaster){
		new NodePool().balancer();
	}else if(cluster.isWorker){
		new NodePool().worker();
	}
})();
