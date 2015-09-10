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
var binName = pkg.name;
var defaultName = "default";
var defaultEditor = "vi";

/* read/write config fns */

function readConfSync() {
	conf = !fs.existsSync(confFile) ? {} :
		JSON.parse(fs.readFileSync(confFile));
	if (!conf.infos)
		conf.infos = {};
	return conf;
}

function writeConfSync() {
	if (!fs.existsSync(confDir))
		fs.mkdirSync(confDir);
	fs.writeFileSync(confFile, JSON.stringify(conf, null, 3));
}

/* read/write info fns */

function readFileScp(host, path, cb) {
	execFile("/usr/bin/ssh", ["-qT", host, "cat " + path], {
		encoding: "ascii"
	}, function (err, stdout, stderr) {
		if (stderr.length)
			console.error(stderr);
		cb(err, stdout);
	});
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
			return readFileScp(host, parts.path.substr(1), cb);
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
			return writeFileScp(host, parts.path.substr(1), data, cb);
		case null:
			return fs.writeFile(parts.path, data, cb);
		default:
			throw new Error("Unknown protocol " + parts.protocol);
	}
}

/* Higher-level read/write fns */

function saveInfo(name, info) {
	var item = conf.infos[name];
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
	var item = conf.infos[name];
	if (!item) {
		if (name == defaultName) {
			console.error("No info. Run '" + binName + " init'");
		} else {
			console.error("No info for '" + name + "'");
		}
		process.exit(1);
	}
	readFile(item.path, function (err, data) {
		if (!data)
			return cb(null);
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
			/* Data is unchanged. */
			return;
		}

		var info;
		try {
			info = JSON.parse(newData);
		} catch(e) {
			console.error("Data is not valid JSON.");
			var resp;
			do {
				resp = promptSync("Re-edit? [Y/n] ");
				if (/^y/i.test(resp))
					return editFile(path, data, cb);
			} while (!/^n/.test(resp));
			return;
		}

		cb(info);
	}
}

/* Validation */

function checkService(srv, i) {
	if (!srv.name)
		console.log("Service", i, "missing name");
	var uris = srv.uris;
	if (uris) {
		if (srv.uri)
			console.log("Service", i, "has both uri and uris");
		if (typeof uris != "object")
			console.log("Service", i, "has invalid uris");
	} else if (!srv.uri)
		console.log("Service", i, "missing uri/uris");
}

function checkInfo(info) {
	/* TODO: use a JSON schema validator */
	if (!info.key)
		console.log("Missing key");
	else if (!/[0-9a-z]{52}\.k/.test(info.key))
		console.log("Invalid key");

	if (!info.hostname)
		console.log("Missing hostname");

	if (!info.ip)
		console.log("Missing ip");
	else if (!/^fc[0-9a-f]{,37}/.test(info.ip))
		console.log("Invalid ip");

	var contact = info.contact;
	if (!contact)
		console.log("Missing contact");
	else {
		if (typeof contact == "object" && !contact.name && !contact.email)
			console.log("Missing contact name/email");
	}

	var pgp = contact && contact.pgp || info.pgp;
	if (!pgp)
		console.log("Missing pgp");
	else {
		if (!pgp.fingerprint)
			console.log("Missing pgp fingerprint");
		if (!pgp.keyserver && !pgp.full)
			console.log("Missing pgp keyserver/url");
	}

	var services = services;
	if (services) {
		if (typeof services != "object")
			console.log("Invalid services");
		else if (services[0])
			services.forEach(checkService);
	}
}

/* Commands */

function usage() {
	console.log([
		"Usage: " + binName + " <command> [<arguments>]",
		"Commands for managing:",
		"    ls",
		"    init",
		"    add <path>",
		"    rm",
		"    check",
		"Commands for editing:",
		"    touch",
		"    get [<property>]",
		"    set [<property> [<value>]]",
		"    edit [<property>]",
		"Options:",
		"    -r <name>       remote name",
	].join("\n"));
}

var commands = {
	ls: function () {
		for (var name in conf.infos) {
			var info = conf.infos[name];
			console.log(name + "\t" + info.path);
		}
	},

	init: function (argv) {
		var name = argv.remote || defaultName;
		var info = conf.infos[name] || {
		};
		/* TODO */
		conf.infos[name] = info;
	},

	add: function (argv) {
		var name = argv.remote || defaultName;
		var path = argv._[0];
		if (!path || argv.help) {
			console.log("Usage: " + binName + " add [-r <remote>] <path>");
			process.exit(argv.help ? 0 : 1);
		}

		if (conf.infos[name]) {
			console.error("Remote", name, "already exists");
			process.exit(1);
		}

		conf.infos[name] = {
			path: path
		};
		writeConfSync();
	},

	rm: function (argv) {
		var name = argv.remote || defaultName;
		if (!(name in conf.infos)) {
			console.log("'" + name + "' not in config");
			return;
		}
		delete conf.infos[name];
		writeConfSync();
	},

	check: function (argv) {
		var name = argv.remote || defaultName;
		getInfo(name, checkInfo);
	},

	touch: function (argv) {
		var name = argv.remote || defaultName;
		getInfo(name, saveInfo.bind(this, name));
	},

	get: function (argv) {
		var name = argv.remote || defaultName;
		var property = argv._[0];

		getInfo(name, function (info) {
			var obj = (property == null) ? info : info[property];
			var data = JSON.stringify(obj, null, 3);
			console.log(data);
		});
	},

	edit: function (argv) {
		var name = argv.remote || defaultName;
		var property = argv._[0];

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
		var name = argv.remote || defaultName;
		var property = argv._[0];
		var value = argv._[1];

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

