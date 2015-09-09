#!/usr/bin/env node
var minimist = require("minimist");
var pkg = require("./package");
var fs = require("fs");
var urlParse = require("url").parse;
var spawn = require("child_process").spawn;
var execFile = require("child_process").execFile;
var promptSync = require("sync-prompt").prompt;
var mktemp = require("mktemp");

var confDir = process.env.XDG_CONFIG_HOME || (process.env.HOME + "/.config");
var confFile = confDir + "/nij.json";
var conf;
var defaultName = "default";
var defaultEditor = "vi";

/* read/write config fns */

function readConfSync() {
	return !fs.existsSync(confFile) ? {} :
		JSON.parse(fs.readFileSync(confFile));
}

function writeConfSync() {
	if (!fs.existsSync(confDir))
		fs.mkdirSync(confDir);
	fs.writeFileSync(confFile, JSON.stringify(conf, null, 3));
}

/* read/write info fns */

function readFileScp(url, cb) {
	execFile("/usr/bin/scp", ["-q", url, "/dev/stdout"], {
		encoding: "ascii"
	}, cb);
}

function writeFileScp(host, path, data, cb) {
	var child = spawn("ssh", ["-qT", host, "cat > " + path]);
	child.stdin.end(data);
	child.on("close", function (status) {
		cb(status ? new Error("Error writing file: " + status) : null);
	});
}

function readFile(url, cb) {
	var parts = urlParse(url);
	switch (parts.protocol) {
		case "scp:":
			var host = (parts.auth ? parts.auth + "@" : "") + parts.host;
			return readFileScp(host + ":" + parts.path, cb);
		case null:
			return fs.readFile(parts.path, {encoding: "ascii"}, cb);
		default:
			throw new Error("Unknown protocol " + parts.protocol);
	}
}

function writeFile(url, data, cb) {
	var parts = urlParse(url);
	switch (parts.protocol) {
		case "scp:":
			var host = (parts.auth ? parts.auth + "@" : "") + parts.host;
			return writeFileScp(host, parts.path, data, cb);
		case null:
			fs.readFile(parts.path, {encoding: "ascii"}, cb);
			break;
		default:
			throw new Error("Unknown protocol " + parts.protocol);
	}
}

/* Higher-level read/write fns */

function saveInfo(name, info) {
	var item = conf[name];
	info.last_modified = new Date().toISOString();
	var data = JSON.stringify(info, null, 3);
	writeFile(item.path, data, function (err) {
		if (err) {
			console.error("Error writing info");
			throw err;
		}
		/* TODO: auto-ping */
	});
}

function getInfo(name, cb) {
	var item = conf[name];
	if (!item) {
		console.error("No info for name \"" + name + "\"");
		process.exit(1);
	}
	readFile(item.path, function (err, data) {
		var info = JSON.parse(data);
		if (err) {
			console.error("Error reading info");
			throw err;
		}
		cb(info);
	});
}

/* Editing */

function editFile(path, data, cb) {
	spawn(process.env.EDITOR || defaultEditor, [path], {
		stdio: [0, 1, 2]
	}).on("close", onEditorClose);

	function onEditorClose(status) {
		if (status) {
			console.error("Editor exited uncleanly.");
			fs.unlink(path);
			return;
		}

		var newData = fs.readFileSync(path);
		if (newData == data) {
			console.log("Data is unchanged.");
			return;
		}

		var info;
		try {
			info = JSON.parse(newData);
		} catch(e) {
			console.error("Data is not valid JSON.");
			var resp;
			do {
				resp = promptSync("Re-edit? [Y/n]");
				if (/^y/i.test(resp))
					return editFile(path, data, cb);
			} while (!/^n/.test(resp));
			return;
		}

		cb(info);
	}
}

/* Commands */

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
		console.log(conf);
	},

	init: function (argv) {
		console.log(argv);
	},

	del: function (argv) {
		console.log(argv);
	},

	cat: function (argv) {
		var name = argv._[0] || defaultName;
		getInfo(name, console.log.bind(console));
	},

	touch: function (argv) {
		var name = argv._[0] || defaultName;
		getInfo(name, saveInfo.bind(this, name));
	},

	check: function (argv) {
		console.log(argv);
	},

	get: function (argv) {
		console.log(argv);
	},

	edit: function (argv) {
		var name = argv._[0] || defaultName;
		var property = argv._[1];

		getInfo(name, function (info) {
			var name2 = name.replace(/\//g, "-");
			var template = "/tmp/nodeinfo-" + name2 + "-XXXXXXX.json";
			var path = mktemp.createFileSync(template);
			var obj = (property == null) ? info : info[property];
			var data = JSON.stringify(obj, null, 3);
			fs.writeFileSync(path, data);

			editFile(path, data, function (obj) {
				if (property == null)
					info = obj;
				else
					info[property] = obj;
				saveInfo(name, info);
			});
		});
	},

	set: function (argv) {
		var name = argv._[0] || defaultName;
		var property = argv._[1];
		var value = argv._[2];

		if (property == null && value == null) {
			var info = JSON.parse(fs.readFileSync("/dev/stdin"));
			saveInfo(name, info);
			return;
		}

		getInfo(name, function (info) {
			var obj;
			if (value == null) {
				obj = JSON.parse(fs.readFileSync("/dev/stdin"));
			} else try {
				obj = JSON.parse(value);
			} catch(e) {
				obj = value;
			}
			info[property] = obj;
			saveInfo(name, info);
		});
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
	conf = readConfSync();
	commands[cmd](argv);
} else {
	usage();
	process.exit(1);
}

