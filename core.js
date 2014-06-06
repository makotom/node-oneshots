(function(){
	"use strict";

	var CONFIG = {
		servicePort : 37320,
		workersKeepIdle : 3600,	// Unit: second
		workersTimeout : 60,	// Unit: second
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
			socket : {
				remoteAddress : httpReq.socket.remoteAddress,
				remotePort : httpReq.socket.remotePort,
				localAddress : httpReq.socket.localAddress,
				localPort : httpReq.socket.localPort
			},
			http : {
				httpVersion : httpReq.httpVersion,
				headers : httpReq.headers,
				method : httpReq.method,
				url : require("url").parse(httpReq.url)
			}
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
				for(let i = 0; i < workers[path].length; i += 1){
					if(workers[path][i].isIdle){
						worker = workers[path][i];
						clearTimeout(worker.stopIdling);
						break;
					}
				}
			}

			if(worker === null){
				worker = cluster.fork();
				worker.workFor = path;
				workers[path] = [worker];
			}

			worker.isIdle = false;

			return worker;
		},
		idleWorker = function(worker){
			worker.isIdle = true;
			worker.stopIdling = setTimeout(function(){
				worker.kill();
				workers[worker.workFor].splice(workers[worker.workFor].indexOf(worker), 1);
			}, CONFIG.workersKeepIdle * 1000);
		},
		httpResponder = function(httpReq, httpRes){
			var salt = Math.random(),

			worker = invokeWorker(httpReq.url),

			abortWorker = function(){
				httpRes.end();
				worker.kill();
				workers[worker.workFor].splice(workers[worker.workFor].indexOf(worker), 1);
			},

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

						clearTimeout(worker.timeout);
						worker.timeout = setTimeout(abortWorker, CONFIG.workersTimeout * 1000);

						break;

					case "body":
						httpRes.write(new Buffer(workerMes.payload));
						clearTimeout(worker.timeout);
						worker.timeout = setTimeout(abortWorker, CONFIG.workersTimeout * 1000);
						break;

					case "end":
						httpRes.end();
						worker.removeListener("message", workerMessageReceptor);
						idleWorker(worker);
						clearTimeout(worker.timeout);
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
				worker.timeout = setTimeout(abortWorker, CONFIG.workersTimeout * 1000);
			});
		};

		httpd.listen(CONFIG.servicePort, "::");
		httpd.listen(CONFIG.servicePort, "0.0.0.0");

		httpd.on("request", httpResponder);
	};

	NodePool.prototype.worker = function(){
		var built = null, request = null,

		fs = require("fs"),

		genInstanceInterface = function(request){
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

						{
							let statusTerms = parts.join(":").trim().split(" ");

							messageContainer.payload.statusCode = parseInt(statusTerms[0], 10);

							statusTerms.shift();

							if(typeof statusTerms[0] !== typeof undefined){
								messageContainer.payload.reasonPhrase = statusTerms[0].toString();
							}
						}
					}else{
						messageContainer.payload.headers[parts.shift()] = parts.join(":");
					}
				});

				process.send(messageContainer);
			};

			return {
				request : {
					socket : request.header.socket,
					header : request.header.http,
					body : Buffer.concat(request.body)
				},
				writeHeader : function(expr){
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
			var instanceInterface = genInstanceInterface(request);

			try{
				process.chdir(require("path").dirname(fs.realpathSync(request.header.http.url.pathname)));

				if(built === null || fs.statSync(request.header.http.url.pathname).ctime.getTime() > built.builtAt.getTime()){
					delete require.cache[fs.realpathSync(request.header.http.url.pathname)];
					built = require(request.header.http.url.pathname);
					built.builtAt = new Date();
				}

				instanceInterface.writeHeader("Content-Type: text/html; charset=UTF-8");
				built.exec(instanceInterface);
			}
			catch(e){
				instanceInterface.writeHeader("Status: 500");
				instanceInterface.end();
				console.log(e);
			}
		},
		balancerMessageReceptor = function(messenger){
			switch(messenger.type){
				case "header":
					request = {
						salt : messenger.salt,
						header : messenger.payload,
						body : []
					};
					break;

				case "body":
					if(messenger.salt === request.salt){
						request.body.push(new Buffer(messenger.payload));
					}
					break;

				case "end":
					respondBalancerRequest(request);
					break;
				default:
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
