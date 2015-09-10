#!/usr/bin/env node
var minimist = require("minimist");
var pkg = require("./package");
var fs = require("fs");
var urlParse = require("url").parse;
var childProc = require("child_process");
var promptSync = require("sync-prompt").prompt;
var mktemp = require("mktemp");

var asciiEnc = {encoding: "ascii"};

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
	childProc.execFile("/usr/bin/ssh", ["-qT", host, "cat " + path],
			asciiEnc, function (err, stdout, stderr) {
		if (stderr.length)
			console.error(stderr);
		cb(err, stdout);
	});
}

function writeFileScp(host, path, data, cb) {
	var child = childProc.execFile("/usr/bin/ssh",
		["-qT", host, "cat > " + path]);
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
			return fs.readFile(parts.path, asciiEnc, cb);
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

function saveInfo(name, info, confirm) {
	var item = conf.infos[name];
	info.last_modified = new Date().toISOString();
	var data = JSON.stringify(info, null, 3);

	if (confirm) try {
		console.log("About to write to " + item.path + ":");
		console.log(data);
		if (!promptYesNoSync("Is this ok?"))
			console.log("Cancelling");
	} catch(e) {
		handleEOF(e);
	}

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

/* Initing */

function initInfo(cb) {
	/* populate initial nodeinfo.json data */
	var user = process.env.USER;
	var info = {};
	var contact = {};
	var pgp = {};

	var waiting = [
		childProc.execFile("/usr/bin/awk", [
			"-F:",
			'$1 == "' + user + '" { sub(/,.*/, "", $5); print $5 }',
			"/etc/passwd"
		], asciiEnc, function (err, stdout) {
			if (!err && stdout)
				contact.name = stdout.trim();
			resolve();
		}),

		childProc.exec("git config user.email", asciiEnc,
			function (err, stdout) {
				if (!err)
					contact.email = stdout.trim();
				resolve();
			}
		),

		childProc.execFile("/bin/hostname", asciiEnc, function (err, stdout) {
			if (!err)
				info.hostname = stdout.trim();
			resolve();
		}),

		childProc.exec("gpgconf --list-options gpg", asciiEnc,
			function (err, stdout) {
				if (err)
					return resolve();
				var m = /^keyserver:0:.*?"(.*)$/m.exec(stdout);
				if (m) {
					pgp.keyserver = decodeURIComponent(m[1]);
				}
				m = /^default-key:.*?"([0-9a-fA-F]+)$/m.exec(stdout);
				if (!m)
					return resolve();
				var key = m[1];
				childProc.execFile("/usr/bin/gpg", ["--fingerprint", key],
					asciiEnc, function (err, stdout) {
						m = /Key fingerprint = ([0-9A-F ]+)$/m.exec(stdout);
						if (m) {
							key = m[1].replace(/ /g, "");
						}
						pgp.fingerprint = key;
						resolve();
					}
				);
			}
		),

		childProc.execFile("/sbin/ifconfig", ["tun0"], asciiEnc,
			function (err, stdout) {
				if (!err) {
					var m = /addr: (fc[0-9a-f:]*)/.exec(stdout);
					if (m)
						info.ip = m[1];
				}
				resolve();
			}
		)
	].length;

	/* TODO: connect to admin socket to get node public key */

	function resolve() {
		if (--waiting)
			return;

		if (contact.name || contact.email)
			info.contact = contact;

		if (pgp.keyserver || pgp.fingerprint)
			info.pgp = pgp;

		cb(info);
	}
}

/* Editing */

function editFile(path, data, cb) {
	childProc.spawn(process.env.EDITOR || defaultEditor, [path], {
		stdio: [0, 1, 2]
	}).on("close", onEditorClose);

	function onEditorClose(status) {
		if (status) {
			console.error("Editor exited uncleanly.");
			fs.unlink(path);
			return;
		}

		var newData = fs.readFileSync(path, asciiEnc);
		if (newData == data) {
			/* Data is unchanged. */
			fs.unlink(path);
			return;
		}

		var info;
		if (newData) try {
			info = JSON.parse(newData);
		} catch(e) {
			console.error("Data is not valid JSON.");
			if (promptYesNoSync("Re-edit?"))
				return editFile(path, data, cb);
			else
				return fs.unlink(path);
		}

		fs.unlink(path);
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
	else if (!/^fc[0-9a-f:]*$/.test(info.ip))
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

/* Prompting */

function EOFError() {}
EOFError.prototype = new Error();

function handleEOF(e) {
	if (e instanceof EOFError) {
		process.stdout.write("\n");
		process.exit(130);
	} else {
		throw e;
	}
}

function promptYesNoSync(prompt) {
	var resp;
	do {
		resp = promptSync(prompt + " [Y/n] ");
		if (promptSync.isEOF())
			throw new EOFError();
		if (!resp)
			return true;
		if (/^y/i.test(resp))
			return true;
	} while (!/^n/.test(resp));
	return false;
}

function promptSyncDefault(prompt, value) {
	if (promptSync.isEOF())
		throw new EOFError();
	return value ?
		promptSync(prompt + ": [" + value + "] ") || value :
		promptSync(prompt + ": ") || undefined;
}

function initInteractive(info) {
	info.hostname = promptSyncDefault("Hostname", info.hostname);
	info.ip = promptSyncDefault("cjdns IP", info.ip);

	var contact = info.contact || {};
	if ([
		contact.name = promptSyncDefault("Contact name", contact.name),
		contact.email = promptSyncDefault("Contact email", contact.email),
		contact.irc = promptSyncDefault("IRC", contact.xmpp),
		contact.xmpp = promptSyncDefault("XMPP", contact.xmpp),
		contact.bitmessage = promptSyncDefault("Bitmessage",
			contact.bitmessage)
	].some(Boolean))
		info.contact = contact;

	var pgp = contact.pgp || info.pgp || {};
	if ([
		pgp.fingerprint =
			promptSyncDefault("PGP key fingerprint", pgp.fingerprint),
		pgp.keyserver =
			promptSyncDefault("PGP keyserver", pgp.keyserver)
	].some(Boolean) && !contact.pgp)
		info.pgp = pgp;
}


function findNodeInfoFile() {
	/* Try to find an already-existing nodeinfo.json */
	return [
		process.env.HOME + "/www/nodeinfo.json",
		"/srv/http/nodeinfo.json",
		"/var/www/nodeinfo.json"
	].filter(fs.existsSync)[0];
}

/* Commands */

function checkArg1(name, argv) {
	if (argv._.length || argv.help) {
		console.log("Usage:", binName, name, "[-r <remote>]");
		process.exit(argv.help ? 0 : 1);
	}
}

function usage() {
	console.log([
		"Usage:" + binName + " <command> [<arguments>]",
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
	ls: function (argv) {
		if (argv._.length || argv.help) {
			console.log("Usage:", binName, "ls");
			process.exit(argv.help ? 0 : 1);
		}

		/* List default item */
		var info = conf.infos[defaultName];
		if (info) {
			console.log(defaultName + "\t" + info.path);
			delete conf.infos[defaultName];
		}
		/* List other items */
		for (var name in conf.infos) {
			info = conf.infos[name];
			console.log(name + "\t" + info.path);
		}
	},

	add: function (argv) {
		var name = argv.remote || defaultName;
		var path = argv._[0];
		if (!path || argv.help) {
			console.log("Usage: ", binName, "add [-r <remote>] <path>");
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
		checkArg1("rm", argv);

		var name = argv.remote || defaultName;
		if (!(name in conf.infos)) {
			console.log("'" + name + "' not in config");
			return;
		}
		delete conf.infos[name];
		writeConfSync();
	},

	check: function (argv) {
		checkArg1("check", argv);
		var name = argv.remote || defaultName;
		getInfo(name, checkInfo);
	},

	init: function (argv) {
		checkArg1("init", argv);

		var name = argv.remote || defaultName;
		var item = conf.infos[name];
		var oldPath = item ? item.path : findNodeInfoFile();
		var path;
		try {
			path = promptSyncDefault("Path to nodeinfo.json", oldPath);
		} catch(e) {
			handleEOF(e);
		}
		if (!item) {
			item = conf.infos[name] = {};
		}
		if (path != item.path) {
			item.path = path;
			writeConfSync();
		}
		getInfo(name, function (info) {
			if (!info)
				initInfo(next);
			else
				next(info);
		});

		function next(info) {
			initInteractive(info);
			saveInfo(name, info, true);
		}
	},

	touch: function (argv) {
		checkArg1("touch", argv);
		var name = argv.remote || defaultName;
		getInfo(name, saveInfo.bind(this, name));
	},

	get: function (argv) {
		if (argv._.length > 1 || argv.help) {
			console.log("Usage:", binName, "get [-r <remote>] [<property>]");
			process.exit(argv.help ? 0 : 1);
		}

		var name = argv.remote || defaultName;
		var property = argv._[0];

		getInfo(name, function (info) {
			var obj = (property == null) ? info : info[property];
			var data = JSON.stringify(obj, null, 3);
			console.log(data);
		});
	},

	edit: function (argv) {
		if (argv._.length > 1 || argv.help) {
			console.log("Usage:", binName, "edit [-r <remote>] [<property>]");
			process.exit(argv.help ? 0 : 1);
		}

		var name = argv.remote || defaultName;
		var property = argv._[0];

		getInfo(name, function (info) {
			var name2 = name.replace(/\//g, "-");
			var template = "/tmp/nodeinfo-" + name2 + "-XXXXXXX.json";
			var path = mktemp.createFileSync(template);
			var obj;
			if (property == null) {
				obj = info;
				if (obj.last_modified)
					obj.last_modified += " (auto-updated)";
			} else {
				obj = info[property];
			}
			var data = (obj == null) ? "" : JSON.stringify(obj, null, 3);
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
		if (argv._.length > 2 || argv.help) {
			console.log("Usage:", binName,
				"set [-r <remote>] [<property> [<value>]]");
			process.exit(argv.help ? 0 : 1);
		}

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

