exports.exec = function (IO) {
	IO.setStatus(200, "Hello world!");
	IO.setHeader("Content-Type: text/plain; charset=UTF-8");
	IO.echo("Hello world!\n");
	IO.echo(require("util").format(IO.request));
	IO.echo("\n");
	IO.end();
};
