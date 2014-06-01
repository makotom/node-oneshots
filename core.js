(function(){
	"use strict";

	var WORKERS_KEEP_ALIVE = 10,	// Unit: seconds
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
								if(!workers[path][i].isActive){
									worker = workers[path][i];
									break;
								}
							}
						})();
					}

					if(worker === null){
						worker = cluster.fork();
						workers[path] = [worker];
					}

					worker.isActive = true;
					worker.lastManaged = new Date();

					return worker;
				},
				idleWorker = function(worker){
					worker.isActive = false;
					worker.lastManaged = new Date();
				},
				cleanupWorkers = function(){
					var path = "", killThreshold = new Date().getTime() - (WORKERS_KEEP_ALIVE * 1000);

					for(path in workers){
						if(workers.hasOwnProperty(path)){
							workers[path].forEach(function(workerInPool, keyInPath){
								if(!workerInPool.isActive && workerInPool.lastManaged.getTime() < killThreshold){
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
					order = new BalancerMessage(httpReq.url);

					worker.send(order);

					worker.on("message", function(workerMes){
						if(workerMes.key !== order.key){
							console.log(workerMes);
							return;
						}

						switch(workerMes.type){
							case "header":
								httpRes.writeHead(workerMes.payload.status, workerMes.payload.headers);
								break;

							case "end":
								httpRes.end();
								idleWorker(worker);
								break;

							case "body":
								httpRes.write(workerMes.payload);
								break;
							default:
								console.log(workerMes);
						}
					});
				});

				setInterval(cleanupWorkers, WORKERS_KEEP_ALIVE * 1000);
			})();
		}else if(cluster.isWorker){ // Child process; worker
			(function(){
				var script = {
					lastModified : null,
					object : null
				},
				fs = require("fs");

				process.on("message", function(request){
					var httpInterface = (function(){
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
					})();

					try{
						httpInterface.header("Content-Type: text/plain; charset=UTF-8");
						httpInterface.echo(request.path + " called\n");

						if(script.lastModified === null || fs.statSync("./node.js").mtime.getTime() > script.lastModified.getTime()){
							script.object = require("./node.js");
							script.object.header = httpInterface.header;
							script.object.echo = httpInterface.echo;
							script.object.end = httpInterface.end;
							script.lastModified = new Date();
						}

						script.object.exec();
					}
					catch(e){
						// TODO: Log to somewhere instead of dumping
						httpInterface.echo(e.toString());
					}
				});
			})();
		}
	})();
})();
