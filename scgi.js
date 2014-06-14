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
	defaultStatusPhrase, onConnection, onClientData, onClientError, onClientFin, onSocketTimeout, onSocketError, onSocketClose,
	// Internal values
	CRLF = "\r\n", statusPhrases = [],

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
	};
	util.inherits(ClientRequest, EE);
	ClientRequest.prototype.setTimeout = function (timeoutAfter, callback) {
		if (callback !== undefined) {
			this.socket.on("timeout", callback);
		}
	};

	ServerResponse = function (socket) {
		EE.call(this);

		this.socket = socket;
		this.headers = [];
		this.inBody = false;

		this.setStatus(200);
	};
	util.inherits(ServerResponse, EE);
	ServerResponse.prototype.setStatus = function (sCode, reasonPhrase) {
		this.headers.push(["Status:", sCode.toString(), reasonPhrase !== undefined ? reasonPhrase : defaultStatusPhrase(sCode)].join(" "));
	};
	ServerResponse.prototype.setHeader = function (headerStatement) {
		this.headers.push(headerStatement.trim());
	};
	ServerResponse.prototype.flushHeaders = function () {
		if (this.socket.writable !== true) {
			return;
		}

		if (this.headers.length > 0 && this.inBody === false) {
			this.socket.write(this.headers.join(CRLF) + CRLF);
		}
		this.headers = [];
	};
	ServerResponse.prototype.write = function (data) {
		if (this.socket.writable !== true) {
			return;
		}

		if (this.inBody === false) {
			this.flushHeaders();
			this.socket.write(CRLF);
		}
		this.inBody = true;

		this.socket.write(data);
	};
	ServerResponse.prototype.end = function () {
		if (this.socket._writableState.writing === false) {
			this.socket.end();
		} else {
			this.socket.once("drain", this.socket.end);
		}
	};

	defaultStatusPhrase = function (sCode) {
		return statusPhrases[sCode] !== undefined ? statusPhrases[sCode] : [sCode.toString(), "Unknown Reason"].join(" ");
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
		socket.on("end", onClientFin.bind(connection));
		socket.on("close", onSocketClose.bind(connection));
		socket.on("error", onSocketError.bind(connection));
		socket.on("timeout", onSocketTimeout);
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
			this.server.emit("clientError", e, this.socket);
		}
	};

	onSocketError = function (e) {
		this.server.emit("clientError", e, this.socket);
	};

	onSocketTimeout = function () {
		this.socket.end();
		this.socket.destroy();
	};

	onSocketClose = function () {
		this.socket.removeAllListeners();

		if (this.socket._writableState.ended === false) {
			this.req.emit("close");
			this.res.emit("close");
		}
	};

	statusPhrases[100] = "Continue";
	statusPhrases[101] = "Switching Protocols";
	statusPhrases[102] = "Processing";	// RFC 2518, obsoleted by RFC 4918
	statusPhrases[200] = "OK";
	statusPhrases[201] = "Created";
	statusPhrases[202] = "Accepted";
	statusPhrases[203] = "Non-Authoritative Information";
	statusPhrases[204] = "No Content";
	statusPhrases[205] = "Reset Content";
	statusPhrases[206] = "Partial Content";
	statusPhrases[207] = "Multi-Status";	// RFC 4918
	statusPhrases[300] = "Multiple Choices";
	statusPhrases[301] = "Moved Permanently";
	statusPhrases[302] = "Moved Temporarily";
	statusPhrases[303] = "See Other";
	statusPhrases[304] = "Not Modified";
	statusPhrases[305] = "Use Proxy";
	statusPhrases[307] = "Temporary Redirect";
	statusPhrases[400] = "Bad Request";
	statusPhrases[401] = "Unauthorized";
	statusPhrases[402] = "Payment Required";
	statusPhrases[403] = "Forbidden";
	statusPhrases[404] = "Not Found";
	statusPhrases[405] = "Method Not Allowed";
	statusPhrases[406] = "Not Acceptable";
	statusPhrases[407] = "Proxy Authentication Required";
	statusPhrases[408] = "Request Time-out";
	statusPhrases[409] = "Conflict";
	statusPhrases[410] = "Gone";
	statusPhrases[411] = "Length Required";
	statusPhrases[412] = "Precondition Failed";
	statusPhrases[413] = "Request Entity Too Large";
	statusPhrases[414] = "Request-URI Too Large";
	statusPhrases[415] = "Unsupported Media Type";
	statusPhrases[416] = "Requested Range Not Satisfiable";
	statusPhrases[417] = "Expectation Failed";
	statusPhrases[418] = "I'm a teapot";	// RFC 2324
	statusPhrases[422] = "Unprocessable Entity";	// RFC 4918
	statusPhrases[423] = "Locked";	// RFC 4918
	statusPhrases[424] = "Failed Dependency";	// RFC 4918
	statusPhrases[425] = "Unordered Collection";	// RFC 4918
	statusPhrases[426] = "Upgrade Required";	// RFC 2817
	statusPhrases[428] = "Precondition Required";	// RFC 6585
	statusPhrases[429] = "Too Many Requests";	// RFC 6585
	statusPhrases[431] = "Request Header Fields Too Large";// RFC 6585
	statusPhrases[500] = "Internal Server Error";
	statusPhrases[501] = "Not Implemented";
	statusPhrases[502] = "Bad Gateway";
	statusPhrases[503] = "Service Unavailable";
	statusPhrases[504] = "Gateway Time-out";
	statusPhrases[505] = "HTTP Version Not Supported";
	statusPhrases[506] = "Variant Also Negotiates";	// RFC 2295
	statusPhrases[507] = "Insufficient Storage";	// RFC 4918
	statusPhrases[509] = "Bandwidth Limit Exceeded";
	statusPhrases[510] = "Not Extended";	// RFC 2774
	statusPhrases[511] = "Network Authentication Required"	// RFC 6585

	// Exporting
	exports.Server = Server;
	exports.ClientRequest = ClientRequest;
	exports.ServerResponse = ServerResponse;
	exports.createServer = createServer;
})();
