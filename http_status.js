// Copyright (C) 2014 Makoto Mizukami

(function () {
	var registered = exports.IANAStatuses = [];

	// See http://www.iana.org/assignments/http-status-codes/http-status-codes.xhtml

	registered[100] = "Continue";
	registered[101] = "Switching Protocols";
	registered[102] = "Processing";
	registered[200] = "OK";
	registered[201] = "Created";
	registered[202] = "Accepted";
	registered[203] = "Non-Authoritative Information";
	registered[204] = "No Content";
	registered[205] = "Reset Content";
	registered[206] = "Partial Content";
	registered[207] = "Multi-Status";
	registered[208] = "Already Reported";
	registered[226] = "IM Used";
	registered[300] = "Multiple Choices";
	registered[301] = "Moved Permanently";
	registered[302] = "Found";
	registered[303] = "See Other";
	registered[304] = "Not Modified";
	registered[305] = "Use Proxy";
	registered[306] = "(Unused)";
	registered[307] = "Temporary Redirect";
	registered[308] = "Permanent Redirect";
	registered[400] = "Bad Request";
	registered[401] = "Unauthorized";
	registered[402] = "Payment Required";
	registered[403] = "Forbidden";
	registered[404] = "Not Found";
	registered[405] = "Method Not Allowed";
	registered[406] = "Not Acceptable";
	registered[407] = "Proxy Authentication Required";
	registered[408] = "Request Timeout";
	registered[409] = "Conflict";
	registered[410] = "Gone";
	registered[411] = "Length Required";
	registered[412] = "Precondition Failed";
	registered[413] = "Payload Too Large";
	registered[414] = "URI Too Long";
	registered[415] = "Unsupported Media Type";
	registered[416] = "Requested Range Not Satisfiable";
	registered[417] = "Expectation Failed";
	registered[418] = "I'm a teapot";
	registered[422] = "Unprocessable Entity";
	registered[423] = "Locked";
	registered[424] = "Failed Dependency";
	registered[426] = "Upgrade Required";
	registered[428] = "Precondition Required";
	registered[429] = "Too Many Requests";
	registered[431] = "Request Header Fields Too Large";
	registered[500] = "Internal Server Error";
	registered[501] = "Not Implemented";
	registered[502] = "Bad Gateway";
	registered[503] = "Service Unavailable";
	registered[504] = "Gateway Timeout";
	registered[505] = "HTTP Version Not Supported";
	registered[506] = "Variant Also Negotiates (Experimental)";
	registered[507] = "Insufficient Storage";
	registered[508] = "Loop Detected";
	registered[510] = "Not Extended";
	registered[511] = "Network Authentication Required";
})();
