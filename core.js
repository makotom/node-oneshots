(function(){
	"use strict";

	var WORKERS_KEEP_ALIVE = 10,	// Unit: seconds
	GW_PORT = 12345;

	// TODO: Check parameter integrity

	(function(){
		var WorkerMessage = function(type, payload){
			var messageTypeRegex = /^(?:header|body|end)$/;

			return {
				type : messageTypeRegex.test(type) ? type : "unknown",
				payload : payload
			};
		},
		cluster = require("cluster"), http = require("http");

		if(cluster.isMaster){	// Parent process; load balancer
			(function(){
				var routes = {}, httpd = http.createServer(),

				invokeWorker = function(path){	// Route incoming requests to workers; create new one if suitable
					var worker = null;

					if(typeof routes[path] === typeof undefined){
						worker = cluster.fork();
						routes[path] = worker;
					}else{
						worker = routes[path];
					}

					worker.lastInvokedTime = new Date();
					return worker;
				},
				cleanupWorkers = function(){
					var path = "", killThreshold = new Date().getTime() - (WORKERS_KEEP_ALIVE * 1000);

					for(path in routes){
						if(routes.hasOwnProperty(path)){
							if(routes[path].lastInvokedTime.getTime() < killThreshold){
								routes[path].kill();
								delete routes[path];
							}
						}
					}
				};

				httpd.listen(GW_PORT, "::");
				httpd.listen(GW_PORT, "0.0.0.0");

				httpd.on("request", function(httpReq, httpRes){
					var worker = invokeWorker(httpReq.url);

					worker.send(httpReq.url);

					worker.on("message", function(workerRes){
						switch(workerRes.type){
							case "header":
								httpRes.writeHead(workerRes.payload.status, workerRes.payload.headers);
								break;

							case "end":
								httpRes.end();
								break;

							case "body":
							default:
								httpRes.write(workerRes.payload);
						}
					});
				});

				setInterval(cleanupWorkers, WORKERS_KEEP_ALIVE * 1000);
			})();
		}else if(cluster.isWorker){ // Child process; worker
			(function(){
				var script = null;

				process.on("message", function(script){
					var httpInterface = (function(){
						var httpResponseHeaders = [], isHeaderSent = false,

						flushHTTPHeaders = function(){
							var formatFieldName = function(fieldName){
								// TODO
								return fieldName;
							},
							messagePayload = { status : 200, headers : { "Content-Type" : "text/html; charset=UTF-8" }};

							httpResponseHeaders.forEach(function(expr){
								var parts = expr.split(":");

								if(/Status/i.test(parts[0])){
									messagePayload.status = parseInt(parts.join(":"), 10);
								}else{
									messagePayload.headers[formatFieldName(parts.shift())] = parts.join(":");
								}
							});

							process.send(new WorkerMessage("header", messagePayload));
						};

						return {
							header : function(expr){
								httpResponseHeaders.push(expr); 
							},
							echo : function(bodyChunk){
								if(!isHeaderSent){
									flushHTTPHeaders();
									isHeaderSent = true;
								}
								process.send(new WorkerMessage("body", bodyChunk));
							}
						};
					})(),
					header = httpInterface.header,
					echo = httpInterface.echo;

					try{
						// TODO: Actual script execution
						header("Content-Type: text/plain; charset=UTF-8");
						echo(script + " called");
					}
					catch(e){
						echo(e.toString());
					}

					process.send(new WorkerMessage("end"));
				});
			})();
		}
	})();
})();
