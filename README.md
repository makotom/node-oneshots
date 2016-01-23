nodebed
=======

**nodebed** is a server-side JavaScript scriptlet server for Node.js. It works as a FastCGI process manager, like PHP-FPM, and it brokers FastCGI connections and helps interactions with scripts running as child processes. Advantages nodebed provides are:

* that it abstracts FastCGI and SCGI communication with an easy-to-use interface,
* that it lets small JavaScript programmes be invoked efficiently; it caches JIT results, and
* that it hosts multiple scripts under one server using only one listening socket, without forcing hosted scripts blocking each other by adopting multi-process model.

The software is tested on Apache 2.4 and IIS 8.5 (with the attached forwarder.py).

File descriptions
-----------------

* core.js: main script
* fcgi.js: abstraction of FCGI (loaded inside core.js)
* scgi.js: abstraction of SCGI (loaded inside core.js)
* http_status.js: List of known HTTP status codes (loaded inside core.js)
* forwarder.py: bridge for IIS and core.js - write stdin input to TCP socket and read TCP socket for stdout output
* nodebed.service: configuration file to work as a daemon on systemd
* sample.njs: sample script for nodebed showcasing how it works
* LICENCE: licence terms
* README.md: this file

Usage
-----

[TODO]: Write usage instruction.

---
Copyright (C) 2014-2016 Makoto Mizukami
