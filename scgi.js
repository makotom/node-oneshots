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

		if (requestListener !== undefined) {
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
			inBody : false
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
		var socket = this.socket;

		if (socket.writable !== true || headerInfo.inBody === true) {
			return;
		}

		if (headerInfo.fieldQueue.length > 0) {
			headerInfo.fieldQueue.forEach(function (field) {
				socket.write(headerInfo.fields[field] + CRLF);
			});
		}
		headerInfo.fieldQueue = [];

		if (finalizeHeader === true) {
			socket.write(CRLF);
			headerInfo.inBody = true;
		}
	};
	ServerResponse.prototype.write = function (data) {
		if (this.socket.writable !== true) {
			return;
		}

		this.flushHeaders(true);
		this.socket.write(data);
	};
	ServerResponse.prototype.end = function (data) {
		data !== undefined && this.write(data);

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
			reqDraft : {},
			req : new ClientRequest(socket),
			res : new ServerResponse(socket),
			clientPhase : 0
		};

		socket.setTimeout(this.timeout);

		socket.on("data", onClientData.bind(connection));
		socket.on("error", onSocketError.bind(connection));
		socket.on("end", onClientFin.bind(connection));
		socket.on("close", onSocketClose.bind(connection));
		socket.on("timeout", onSocketTimeout.bind(connection));
	};

	onClientData = function (data) {
		var reqDraft = this.reqDraft,
		i = 0, dataChar = "";


		if (this.clientPhase === 0) {	// Beginning
			if (reqDraft.headerLengthStr === undefined) {
				reqDraft.headerLengthStr = "";
			}

			for (; i < data.length; i += 1) {
				dataChar = String.fromCharCode(data[i]);

				if (isNaN(parseInt(dataChar, 10))) {
					if (dataChar !== ":" || reqDraft.headerLengthStr.length < 1) {
						this.server.emit("clientError", new Error("Malformed netstring of headers"), this.socket);
						return;
					} else {
						reqDraft.headerLength = parseInt(reqDraft.headerLengthStr, 10);
						this.clientPhase += 1;
						i += 1;
						break;
					}
				}

				reqDraft.headerLengthStr += dataChar;
			}
		}

		if (this.clientPhase === 1) {	// Midst header
			if (reqDraft.parsedHeaderLength === undefined) {
				reqDraft.parsedHeaderLength = 0;
				reqDraft.headerState = 0;
				reqDraft.headerParserStack = ["", ""];
			}

			for (; i < data.length; i += 1) {
				dataChar = String.fromCharCode(data[i]);

				if (reqDraft.parsedHeaderLength === reqDraft.headerLength) {
					if (dataChar !== ",") {
						this.server.emit("clientError", new Error("Header section is longer than declared"), this.socket);
					}

					this.clientPhase += 1;
					this.server.emit("request", this.req, this.res);

					reqDraft.bodyLength = parseInt(this.req.params.CONTENT_LENGTH, 10);
					process.nextTick(onClientData.bind(this, data.slice(i + 1)));

					return;
				}

				reqDraft.parsedHeaderLength += 1;

				if (dataChar === "\u0000") {
					if (reqDraft.headerState === 1) {
						this.req.params[reqDraft.headerParserStack[0]] = reqDraft.headerParserStack[1];
						reqDraft.headerParserStack = ["", ""];
					}

					reqDraft.headerState ^= 1;
					continue;
				}

				reqDraft.headerParserStack[reqDraft.headerState] += dataChar;
			}
		}

		if (this.clientPhase === 2) {
			if (reqDraft.bodyReceivedLength === undefined) {
				reqDraft.bodyReceivedLength = 0;
			}

			reqDraft.bodyReceivedLength += data.length;

			if (reqDraft.bodyReceivedLength > reqDraft.bodyLength) {
				this.server.emit("clientError", new Error("Body is larger than declared"), this.socket);
				return;
			}

			this.req.emit("data", data);

			if (reqDraft.bodyReceivedLength === reqDraft.bodyLength) {
				reqDraft.clientPhase += 1;
				this.req.emit("end");
			}
		}
	};

	onClientError = function (e, socket) {
		socket.destroy();
	};

	onClientFin = function () {
		if (this.clientPhase < 2) {
			this.server.emit("clientError", new Error("Client FIN before request completes"), this.socket);
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
