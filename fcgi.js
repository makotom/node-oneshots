// Copyright (C) 2014 Makoto Mizukami

(function () {
	"use strict";

	var DEFAULTS = {
		timeout : 180 * 1000	// Unit: second
	},

	CONST = {
		FCGIVersion : 1,
		FCGINullReqId : 0,
		FCGIRecordTypes : [
			undefined,
			"FCGI_BEGIN_REQUEST",
			"FCGI_ABORT_REQUEST",
			"FCGI_END_REQUEST",
			"FCGI_PARAMS",
			"FCGI_STDIN",
			"FCGI_STDOUT",
			"FCGI_STDERR",
			"FCGI_DATA",
			"FCGI_GET_VALUES",
			"FCGI_GET_VALUES_RESULT",
			"FCGI_UNKNOWN_TYPE"
		],
		FCGIEndReasons : [
			"FCGI_REQUEST_COMPLETE",
			"FCGI_CANT_MPX_CONN",
			"FCGI_OVERLOADED",
			"FCGI_UNKNOWN_ROLE"
		],
		FCGIRole : 1,
		FCGIHeaderLength : 8,
		FCGIVersionOffset : 0,
		FCGITypeOffset : 1,
		FCGIReqIdOffset : 2,
		FCGIContentLengthOffset : 4,
		FCGIPaddingLengthOffset : 6,
		FCGIRoleOffset : 0,
		FCGIFlagsOffset : 2,
	},

	// Classes
	Server, ClientRequest, ServerResponse,
	// Methods
	createServer,
	// Internal functions
	defaultStatusPhrase, sendFCGIRecord, sendFCGIEndRecord, onConnection, onClientData, onClientError, onClientFin, onSocketError, onSocketClose, onSocketTimeout,
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

	ClientRequest = function (id, socket) {
		EE.call(this);

		this.reqId = id;
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

	ServerResponse = function (id, socket) {
		var headerInfo = {
			fields : {},
			fieldQueue : [],
		};

		EE.call(this);

		this.reqId = id;
		this.socket = socket;
		this.closeSocketOnEnd = false;

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
			headerInfo.fieldQueue.forEach(function (field) {
				sendFCGIRecord(this.socket, "FCGI_STDOUT", this.reqId, new Buffer(headerInfo.fields[field] + CRLF));
			}.bind(this));
		}
		headerInfo.fieldQueue = [];

		if (finalizeHeader === true) {
			sendFCGIRecord(this.socket, "FCGI_STDOUT", this.reqId, new Buffer(CRLF));
			this.headerFinalized = true;
		}
	};

	ServerResponse.prototype.write = function (data) {
		this.headerFinalized !== true && this.flushHeaders(true);
		sendFCGIRecord(this.socket, "FCGI_STDOUT", this.reqId, new Buffer(data));
	};

	ServerResponse.prototype.end = function (data) {
		data !== undefined && this.write(data);
		sendFCGIRecord(this.socket, "FCGI_STDOUT", this.reqId, new Buffer(0));
		sendFCGIEndRecord(this.socket, this.reqId, "FCGI_REQUEST_COMPLETE");

		if (this.closeSocketOnEnd) {
			if (this.socket._writableState.writing === false) {
				this.socket.end();
			} else {
				this.socket.once("drain", this.socket.end);
			}
		}
	};

	createServer = function (requestListener) {
		return new Server(requestListener);
	};

	defaultStatusPhrase = function (sCode) {
		return wellknownStatuses[sCode] !== undefined ? wellknownStatuses[sCode] : [sCode.toString(), "Unknown Reason"].join(" ");
	};

	sendFCGIRecord = function (socket, type, reqId, content) {
		var msgHeader = new Buffer(CONST.FCGIHeaderLength);

		msgHeader.fill(0);
		msgHeader[CONST.FCGIVersionOffset] = CONST.FCGIVersion;
		msgHeader[CONST.FCGITypeOffset] = CONST.FCGIRecordTypes.indexOf(type);
		msgHeader.writeUInt16BE(reqId, CONST.FCGIReqIdOffset);
		msgHeader.writeUInt16BE(content.length, CONST.FCGIContentLengthOffset);
		msgHeader[CONST.FCGIPaddingLengthOffset] = 0;

		if (socket.writable === true) {
			socket.write(Buffer.concat([msgHeader, content], CONST.FCGIHeaderLength + content.length));
		}
	};

	sendFCGIEndRecord = function (socket, reqId, reason) {
		sendFCGIRecord(socket, "FCGI_END_REQUEST", reqId, new Buffer([0, 0, 0, 0, CONST.FCGIEndReasons.indexOf(reason), 0, 0, 0]));
	};

	onConnection = function (socket) {
		var connection = {
			server : this,
			socket : socket,
			clientBuffered : null,
			sessions : []
		};

		socket.setTimeout(this.timeout);

		socket.on("data", onClientData.bind(connection));
		socket.on("error", onSocketError.bind(connection));
		socket.on("end", onClientFin.bind(connection));
		socket.on("close", onSocketClose.bind(connection));
		socket.on("timeout", onSocketTimeout.bind(connection));
	};

	onClientData = function (data) {
		this.clientBuffered = this.clientBuffered !== null ? Buffer.concat([this.clientBuffered, data], this.clientBuffered.length + data.length) : data;

		if (this.clientBuffered.length < CONST.FCGIHeaderLength) {
			return;
		}

		while (this.clientBuffered !== null) {
			let parsingData = this.clientBuffered, msgHeader = {}, msgContent = null;

			msgHeader.version = parsingData[CONST.FCGIVersionOffset];
			msgHeader.type = parsingData[CONST.FCGITypeOffset];
			msgHeader.reqId = parsingData.readUInt16BE(CONST.FCGIReqIdOffset);
			msgHeader.contentLength = parsingData.readUInt16BE(CONST.FCGIContentLengthOffset);
			msgHeader.paddingLength = parsingData[CONST.FCGIPaddingLengthOffset];

			if (parsingData.length < CONST.FCGIHeaderLength + msgHeader.contentLength + msgHeader.paddingLength) {
				this.clientBuffered = parsingData;
				return;
			} else if (parsingData.length > CONST.FCGIHeaderLength + msgHeader.contentLength + msgHeader.paddingLength) {
				this.clientBuffered = parsingData.slice(CONST.FCGIHeaderLength + msgHeader.contentLength + msgHeader.paddingLength);
			} else {
				this.clientBuffered = null;
			}

			if (! CONST.FCGIRecordTypes[msgHeader.type]) {
				sendFCGIRecord(this.socket, "FCGI_UNKNOWN_TYPE", 0, new Buffer([msgHeader.type, 0, 0, 0, 0, 0, 0, 0]));
				continue;
			}

			msgContent = parsingData.slice(CONST.FCGIHeaderLength, CONST.FCGIHeaderLength + msgHeader.contentLength);

			if (msgHeader.reqId === CONST.FCGINullReqId && CONST.FCGIRecordTypes[msgHeader.type] === "FCGI_GET_VALUES") {
				sendFCGIRecord(this.socket, "FCGI_GET_VALUES_RESULT", 0, new Buffer(0));
			} else if (CONST.FCGIRecordTypes[msgHeader.type] === "FCGI_BEGIN_REQUEST") {
				if (this.sessions[msgHeader.reqId] !== undefined) {
					sendFCGIEndRecord(this.socket, msgHeader.reqId, "FCGI_DUPLICATED_REQUEST");
				}

				if (msgContent.readUInt16BE(CONST.FCGIRoleOffset) !== CONST.FCGIRole) {
					sendFCGIEndRecord(this.socket, msgHeader.reqId, "FCGI_UNKNOWN_ROLE");
				}

				this.sessions[msgHeader.reqId] = {
					req : new ClientRequest(msgHeader.reqId, this.socket),
					res : new ServerResponse(msgHeader.reqId, this.socket),
					paramsEnded : false,
					bodyEnded : false,
				};

				if (msgContent[CONST.FCGIFlagsOffset] % 2 === 0) {
					this.sessions[msgHeader.reqId].res.closeSocketOnEnd = true;
				}
			} else {
				let session = this.sessions[msgHeader.reqId];

				if (session === undefined) {
					sendFCGIEndRecord(this.socket, msgHeader.reqId, "FCGI_UNOPENED_REQUEST");
					return;
				}

				switch (CONST.FCGIRecordTypes[msgHeader.type]) {
					case "FCGI_PARAMS":
						if (session.paramsEnded) {
							break;
						}

						if (msgContent.length === 0) {
							this.server.emit("request", session.req, session.res);
							session.paramsEnded = true;
							break;
						}

						for (let p = 0, s = 0, r = [0, 0, "", ""]; p < msgContent.length;) {
							switch (s) {
								case 0:
								case 1:
									r[s] += msgContent[p];

									if (msgContent[p] >= 0x80) {
										r[s] = msgContent.readUInt32BE(p) - 0x80000000;
										p += 4;
									} else {
										r[s] = msgContent[p];
										p += 1;
									}

									break;

								case 2:
								case 3:
									if (r[s % 2] !== 0) {
										r[s] = msgContent.slice(p, p += r[s % 2]).toString();
									}
									break;
							}

							s += 1;

							if (s === 4) {
								session.req.params[r[2]] = r[3];
								s = 0;
								r = [0, 0, "", ""];
							}
						}

						break;

					case "FCGI_STDIN":
					case "FCGI_DATA":
						if (session.bodyEnded) {
							break;
						}

						if (msgContent.length === 0) {
							session.req.emit("end");
							session.dataEnded = true;
						}

						session.req.emit("data", msgContent);

						break;
					case "FCGI_ABORT_REQUEST":
						sendFCGIEndRecord(this.socket, msgHeader.reqId, "FCGI_REQUEST_COMPLETE");
						return;

					default:
						sendFCGIEndRecord(this.socket, msgHeader.reqId, "FCGI_BAD_RECORD");
						return;
				}
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
		var self = this;

		self.socket.removeAllListeners();

		self.sessions.forEach(function (session) {
			session.req.emit("close");
			session.res.emit((hadError === false && self.socket._writableState.ended === true) ? "finish" : "close");
		});
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
