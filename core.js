(function(){
	"use strict";

	var WORKERS_KEEP_ALIVE = 10,	// Unit: seconds
	WORKERS_TIMEOUT = 5,
	GW_PORT = 12345;

	// TODO: Check parameter integrity

	(function(){
		var BalancerMessage = function(path){
			return {
				path : path.toString(),
				key : Math.random()
			};
		},
		WorkerMessage = function(key, type, payload){
			var messageTypeRegex = /^(?:header|body|end)$/;

			return {
				key : key,
				type : messageTypeRegex.test(type) ? type : "unknown",
				payload : payload
			};
		},
		HTTPHeaderRequest = function(){
			return {
				status : 200,
				headers : {}
			};
		},

		cluster = require("cluster"), http = require("http");

		if(cluster.isMaster){	// Parent process; load balancer
			(function(){
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
								if((!workerInPool.isAlive || workerInPool.isIdle) && workerInPool.lastManaged.getTime() < killThreshold){
									workerInPool.kill();
									workers[path].splice(keyInPath, 1);
								}
							});
						}
					}
				};

				httpd.listen(GW_PORT, "::");
				httpd.listen(GW_PORT, "0.0.0.0");

				httpd.on("request", function(httpReq, httpRes){
					var worker = invokeWorker(httpReq.url),
					workerReq = new BalancerMessage(httpReq.url),

					timeoutWorker = function(){
						httpRes.end();
						worker.kill();
						worker.isActive = false;
					},
					timeoutTimer = setTimeout(timeoutWorker, WORKERS_TIMEOUT * 1000),

					workerMessageReceptor = function(workerMes){
						if(workerMes.key !== workerReq.key){
							console.log(workerMes);
							return;
						}

						switch(workerMes.type){
							case "header":
								httpRes.writeHead(workerMes.payload.status, workerMes.payload.headers);
								clearTimeout(timeoutTimer);
								timeoutTimer = setTimeout(timeoutWorker, WORKERS_TIMEOUT * 1000);
								break;

							case "end":
								httpRes.end();
								worker.removeListener("message", workerMessageReceptor);
								idleWorker(worker);
								clearTimeout(timeoutTimer);
								break;

							case "body":
								httpRes.write(workerMes.payload);
								clearTimeout(timeoutTimer);
								timeoutTimer = setTimeout(timeoutWorker, WORKERS_TIMEOUT * 1000);
								break;

							default:
								console.log(workerMes);
						}
					};

					worker.send(workerReq);
					worker.on("message", workerMessageReceptor);
				});

				setInterval(cleanupWorkers, WORKERS_KEEP_ALIVE * 1000);
			})();
		}else if(cluster.isWorker){ // Child process; worker
			(function(){
				var fs = require("fs"),

				script = null;

				process.on("message", function(request){
					var httpInterface = (function(request){
						var messengerKey = request.key, httpResponseHeaders = [], isHeaderSent = false,

						flushHTTPHeaders = function(){
							var messagePayload = new HTTPHeaderRequest();

							httpResponseHeaders.forEach(function(expr){
								var parts = expr.split(":");

								if(/Status/i.test(parts[0])){
									messagePayload.status = parseInt(parts.join(":"), 10);
								}else{
									messagePayload.headers[parts.shift()] = parts.join(":");
								}
							});

							process.send(new WorkerMessage(messengerKey, "header", messagePayload));
						};

						delete request.key;

						return {
							header : function(expr){
								httpResponseHeaders.push(expr);
							},
							echo : function(bodyChunk){
								if(!isHeaderSent){
									flushHTTPHeaders();
									isHeaderSent = true;
								}
								process.send(new WorkerMessage(messengerKey, "body", bodyChunk));
							},
							end : function(){
								process.send(new WorkerMessage(messengerKey, "end"));
							}
						};
					})(request);

					httpInterface.header("Content-Type: text/plain; charset=UTF-8");
					try{
						if(script === null || fs.statSync("./node.js").mtime.getTime() > script.builtAt.getTime()){
							delete require.cache[fs.realpathSync("./node.js")];
							script = require("./node.js");
							script.builtAt = new Date();
						}

						script.header = httpInterface.header;
						script.echo = httpInterface.echo;
						script.end = httpInterface.end;

						script.exec();
					}
					catch(e){
						console.log(e);;
					}
				});
			})();
		}
	})();
})();
