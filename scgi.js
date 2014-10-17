// Copyright (C) 2014 Makoto Mizukami

(function () {
	"use strict";

	var DEFAULTS = {
		timeout : 180 * 1000	// Unit: second
	},

	// Classes
	Server, ClientRequest, ServerResponse,
	// Methods
	createServer,
	// Internal functions
	defaultStatusPhrase, onConnection, onClientData, onClientError, onClientFin, onSocketError, onSocketClose, onSocketTimeout,
	// Internal values
	CRLF = "\r\n", wellknownStatuses = require("./http_status.js").IANAStatuses,

	EE = require("events").EventEmitter, net = require("net"), util = require("util");

	Server = function (requestListener) {
		net.Server.call(this, { allowHalfOpen : true });

		if (typeof requestListener === typeof Function) {
			this.on("request", requestListener);
		}

		this.on("connection", onConnection);
		this.on("clientError", onClientError);
	};
	util.inherits(Server, net.Server);

	Server.prototype.timeout = DEFAULTS.timeout;

	Server.prototype.setTimeout = function (timeoutAfter, callback) {
		this.timeout = timeoutAfter;

		if (callback !== undefined) {
			this.on("timeout", callback);
		}
	};

	ClientRequest = function (socket) {
		EE.call(this);

		this.socket = socket;
		this.params = {};

		this.on("close", this.removeAllListeners);
	};
	util.inherits(ClientRequest, EE);

	ClientRequest.prototype.setTimeout = function (timeoutAfter, callback) {
		this.socket.setTimeout(timeoutAfter);

		if (callback !== undefined) {
			this.socket.on("timeout", callback);
		}
	};

	ServerResponse = function (socket) {
		var headerInfo = {
			fields : {},
			fieldQueue : [],
		};

		EE.call(this);

		this.socket = socket;

		this.setHeader = ServerResponse.prototype.setHeader.bind(this, headerInfo);
		this.flushHeaders = ServerResponse.prototype.flushHeaders.bind(this, headerInfo);

		this.setStatus(200);

		this.on("close", this.removeAllListeners);
		this.on("finish", this.removeAllListeners);
	};
	util.inherits(ServerResponse, EE);

	ServerResponse.prototype.headerFinalized = false;

	ServerResponse.prototype.setStatus = function (sCode, reasonPhrase) {
		this.setHeader(["Status:", sCode.toString(), reasonPhrase !== undefined ? reasonPhrase : defaultStatusPhrase(sCode)].join(" "));
	};

	ServerResponse.prototype.setHeader = function (headerInfo, headerStatement) {
		var fieldName = headerStatement.split(":").shift().toLowerCase(),
		queued = headerInfo.fieldQueue.indexOf(fieldName);

		if (headerInfo.fields[fieldName] !== undefined && queued === -1) {
			return;
		}

		headerInfo.fields[fieldName] = headerStatement.trim();

		if (queued >= 0) {
			headerInfo.fieldQueue.splice(queued, 1);
		}
		headerInfo.fieldQueue.push(fieldName);
	};

	ServerResponse.prototype.flushHeaders = function (headerInfo, finalizeHeader) {
		if (this.socket.writable !== true || this.headerFinalized === true) {
			return;
		}

		if (headerInfo.fieldQueue.length > 0) {
			for (let i = 0; i < headerInfo.fieldQueue.length; i += 1) {
				let field = headerInfo.fieldQueue[i];
				this.socket.write(headerInfo.fields[field] + CRLF);
			}
		}
		headerInfo.fieldQueue = [];

		if (finalizeHeader === true) {
			this.socket.write(CRLF);
			this.headerFinalized = true;
		}
	};

	ServerResponse.prototype.write = function (data) {
		if (this.socket.writable !== true) {
			return;
		}

		this.headerFinalized !== true && this.flushHeaders(true);
		data !== undefined && this.socket.write(data);
	};

	ServerResponse.prototype.end = function (data) {
		this.write(data);

		if (this.socket._writableState.writing === false) {
			this.socket.end();
		} else {
			this.socket.once("drain", this.socket.end);
		}
	};

	defaultStatusPhrase = function (sCode) {
		return wellknownStatuses[sCode] !== undefined ? wellknownStatuses[sCode] : [sCode.toString(), "Unknown Reason"].join(" ");
	};

	createServer = function (requestListener) {
		return new Server(requestListener);
	};

	onConnection = function (socket) {
		var connection = {
			server : this,
			socket : socket,
			req : new ClientRequest(socket),
			res : new ServerResponse(socket),
			clientPhase : 0,
			parserInfo : {}
		};

		socket.setTimeout(this.timeout);

		socket.on("data", onClientData.bind(connection));
		socket.on("error", onSocketError.bind(connection));
		socket.on("end", onClientFin.bind(connection));
		socket.on("close", onSocketClose.bind(connection));
		socket.on("timeout", onSocketTimeout.bind(connection));
	};

	onClientData = function (data) {
		var i = 0;

		if (this.clientPhase === 0) {
			if (this.parserInfo.headerLength === undefined) {
				this.parserInfo.headerLength = 0;
			}

			for (; i < data.length; i += 1) {
				let dataChar = String.fromCharCode(data[i]),
				dataInt = parseInt(dataChar, 10);

				if (isNaN(dataInt)) {
					if (dataChar !== ":" || this.parserInfo.headerLength === 0) {
						this.server.emit("clientError", new Error("Malformed netstring of headers"), this.socket);
						return;
					} else {
						this.clientPhase += 1;
						i += 1;
						break;
					}
				} else {
					this.parserInfo.headerLength = 10 * this.parserInfo.headerLength + dataInt;
				}
			}
		}

		if (this.clientPhase === 1) {
			if (this.parserInfo.parsedHeaderLength === undefined) {
				this.parserInfo.parsedHeaderLength = 0;
				this.parserInfo.headerParsingState = 0;
				this.parserInfo.parsingHeaderPair = ["", ""];
			}

			for (; i < data.length; i += 1) {
				let dataChar = String.fromCharCode(data[i]);

				if (this.parserInfo.parsedHeaderLength === this.parserInfo.headerLength) {
					if (dataChar !== ",") {
						this.server.emit("clientError", new Error("Header section is longer than declared"), this.socket);
					}

					this.clientPhase += 1;
					this.server.emit("request", this.req, this.res);

					this.parserInfo.bodyLength = parseInt(this.req.params.CONTENT_LENGTH, 10);

					i += 1;

					break;
				}

				this.parserInfo.parsedHeaderLength += 1;

				if (dataChar === "\u0000") {
					if (this.parserInfo.headerParsingState === 1) {
						this.req.params[this.parserInfo.parsingHeaderPair[0]] = this.parserInfo.parsingHeaderPair[1];
						this.parserInfo.headerParsingState = 0;
						this.parserInfo.parsingHeaderPair = ["", ""];
					} else {
						this.parserInfo.headerParsingState = 1;
					}
				} else {
					this.parserInfo.parsingHeaderPair[this.parserInfo.headerParsingState] += dataChar;
				}
			}
		}

		if (this.clientPhase === 2) {
			if (this.parserInfo.receivedBodyLength === undefined) {
				this.parserInfo.receivedBodyLength = 0;
			}

			this.parserInfo.receivedBodyLength += data.length - i;

			if (this.parserInfo.receivedBodyLength > this.parserInfo.bodyLength) {
				this.server.emit("clientError", new Error("Body is larger than declared"), this.socket);
				return;
			}

			this.req.emit("data", data.slice(i));

			if (this.parserInfo.receivedBodyLength === this.parserInfo.bodyLength) {
				this.parserInfo.clientPhase += 1;
				this.req.emit("end");
			}
		}
	};

	onClientError = function (e, socket) {
		socket.destroy();
	};

	onClientFin = function () {
		if (this.clientPhase < 3) {
			this.server.emit("clientError", new Error("Unexpected FIN received"), this.socket);
		}
	};

	onSocketError = function (e) {
		this.server.emit("clientError", e, this.socket);
	};

	onSocketClose = function (hadError) {
		this.socket.removeAllListeners();

		this.req.emit("close");
		this.res.emit((hadError === false && this.socket._writableState.ended === true) ? "finish" : "close");
	};

	onSocketTimeout = function () {
		this.server.emit("timeout", this.socket);

		process.nextTick(this.socket.end.bind(this.socket));
		process.nextTick(this.socket.destroy.bind(this.socket));
	};

	// Exporting
	exports.Server = Server;
	exports.ClientRequest = ClientRequest;
	exports.ServerResponse = ServerResponse;
	exports.createServer = createServer;
})();
