#!/usr/bin/env node
var minimist = require("minimist");
var pkg = require("./package");

function usage() {
	console.log([
		"Usage: " + pkg.name + " <command> [<arguments>]",
		"Commands:",
		"    ls|init|del|cat|touch|check [<name>]",
		"    get|edit [-r <name>] [<property>]",
		"    set [-r <name>] [<property> [<value>]]",
	].join("\n"));
}

var commands = {
	ls: function (argv) {
		if (argv.h) {
			console.log("Usage: " + pkg.name + " ls");
			return;
		}
		console.log("ls");
	}
};

var argv = minimist(process.argv.slice(2), {
	boolean: "h",
	string: "r",
	alias: {
		h: "help",
		r: "remote"
	}
});
var cmd = argv._.shift();
if (Object.hasOwnProperty.call(commands, cmd)) {
	commands[cmd](argv);
} else {
	usage();
	process.exit(1);
}

