exports.exec = function(){
	exports.echo("Hello world!\n");
	exports.echo(require("util").format(exports.request));
	exports.echo("\n");
	exports.end();
};
