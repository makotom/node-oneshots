(function(){
	"use strict";

	var CONFIG = {
		servicePort : 37320,
		workersCleanerInterval : 1800,	// Unit: second
		workersTimeout : 30,	// Unit: second
		messageCap : 1024 * 16	// Unit: octet
	},

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
			url : require("url").parse(httpReq.url)
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

	cluster = require("cluster");

	NodePool.prototype.balancer = function(){
		var workers = {}, httpd = require("http").createServer(),

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
				worker.isAlive = true;

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
			var path = "", killThreshold = new Date().getTime() - (CONFIG.workersCleanerInterval * 1000);

			for(path in workers){
				if(workers.hasOwnProperty(path)){
					workers[path].forEach(function(workerInPool, keyInPath){
						if(!workerInPool.isAlive || workerInPool.isIdle){
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
				worker.isAlive = false;
			},
			timeoutTimer = setTimeout(timeoutWorker, CONFIG.workersTimeout * 1000),

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
						timeoutTimer = setTimeout(timeoutWorker, CONFIG.workersTimeout * 1000);

						break;

					case "body":
						httpRes.write(new Buffer(workerMes.payload));
						clearTimeout(timeoutTimer);
						timeoutTimer = setTimeout(timeoutWorker, CONFIG.workersTimeout * 1000);
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
						p = p + CONFIG.messageCap < bodyChunk.length ? p + CONFIG.messageCap : bodyChunk.length
					);
					worker.send(messageContainer);
				}
			});
			httpReq.on("end", function(){
				worker.send(new Messenger(salt, "end"));
				worker.on("message", workerMessageReceptor);
			});

		};

		httpd.listen(CONFIG.servicePort, "::");
		httpd.listen(CONFIG.servicePort, "0.0.0.0");

		httpd.on("request", httpResponder);

		setInterval(cleanupWorkers, CONFIG.workersCleanerInterval * 1000);
	};

	NodePool.prototype.worker = function(){
		var built = null, request = null,

		fs = require("fs"),

		genResponseInterface = function(request){
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
							p = p + CONFIG.messageCap < bodyChunk.length ? p + CONFIG.messageCap : bodyChunk.length
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
			var responseInterface = genResponseInterface(request), script = null;

			responseInterface.header("Content-Type: text/html; charset=UTF-8");

			try{
				if(built === null || fs.statSync(request.header.url.pathname).mtime.getTime() > built.builtAt.getTime()){
					delete require.cache[fs.realpathSync(request.header.url.pathname)];
					built = require(request.header.url.pathname);
					built.builtAt = new Date();
				}

				script = built;
				script.request = request;
				script.header = responseInterface.header;
				script.echo = responseInterface.echo;
				script.end = responseInterface.end;

				script.exec();
			}
			catch(e){
				responseInterface.header("Status: 500");
				responseInterface.end();
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
