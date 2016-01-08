#!/usr/bin/env node
var minimist = require("minimist");
var pkg = require("./package");
var fs = require("fs");
var urlParse = require("url").parse;
var childProc = require("child_process");
var promptSync = require("readline-sync").prompt;
var mktemp = require("mktemp");
var minimatch = require("minimatch");

var encoding = {encoding: "utf8"};

var confDir = process.env.XDG_CONFIG_HOME || (process.env.HOME + "/.config");
var confFile = confDir + "/nij.json";
var conf;
var binName = pkg.name;
var defaultEditor = "vi";

var validContinents=['AS', 'SA', 'NA', 'AF', 'EU', 'AN', 'OC'];

/* read/write config fns */

function readConfSync() {
	conf = !fs.existsSync(confFile) ? {} :
		JSON.parse(fs.readFileSync(confFile, encoding));
	if (!conf.infos)
		conf.infos = {};
	return conf;
}

function writeConfSync() {
	if (!fs.existsSync(confDir))
		fs.mkdirSync(confDir);
	fs.writeFileSync(confFile, JSON.stringify(conf, null, 3), encoding);
}

function filterRemotes(names) {
	var all = Object.keys(conf.infos);
	return !names.length ? all :
		minimatch.match(all, "+(" + names.join("|") + ")");
}

/* read/write info fns */

function readFileScp(host, path, cb) {
	childProc.execFile("/usr/bin/ssh", ["-qT", host, "cat " + path],
			encoding, function (err, stdout, stderr) {
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
			return fs.readFile(parts.path, encoding, cb);
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
			return fs.writeFile(parts.path, data, encoding, cb);
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
		console.error("No info. Run '" + binName + " init'");
		process.exit(1);
	}

	readFile(item.path, function (err, data) {
		if (err) {
			if (err.code == "SIGINT") {
				console.error("Interrupted");
				process.exit(1);
			} else if (err.code == "ENOENT") {
				return cb(null);
			} else {
				console.error("Error reading info");
				throw err;
			}
		}
		if (!data)
			return cb(null);
		var info = JSON.parse(data);
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
		], encoding, function (err, stdout) {
			if (!err && stdout)
				contact.name = stdout.trim();
			resolve();
		}),

		childProc.exec("git config user.email", encoding,
			function (err, stdout) {
				if (!err)
					contact.email = stdout.trim();
				resolve();
			}
		),

		childProc.execFile("/bin/hostname", encoding, function (err, stdout) {
			if (!err)
				info.hostname = stdout.trim();
			resolve();
		}),

		childProc.exec("gpgconf --list-options gpg", encoding,
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
					encoding, function (err, stdout) {
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

		childProc.execFile("/sbin/ifconfig", ["tun0"], encoding,
			function (err, stdout) {
				if (err)
					return resolve();
				var m = /addr: (fc[0-9a-f:]*)/.exec(stdout);
				if (!m)
					return resolve();
				info.ip = m[1];

				getKey(info.ip, function (key) {
					if (key)
						info.key = key;
					resolve();
				});
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

/* Get public key of currently-running cjdroute */
function getKey(ip, cb) {
	var Cjdns;
	try {
		Cjdns = require("/opt/cjdns/contrib/nodejs/cjdnsadmin/cjdnsadmin");
	} catch(e) {
		return cb(null);
	}
	childProc.execFile("/bin/pidof", ["cjdroute"], function (err) {
		if (err)
			cb(null);
		else if (fs.existsSync(process.env.HOME + '/.cjdnsadmin'))
			Cjdns.connectWithAdminInfo(next);
		else
			Cjdns.connectAsAnon(next);
	});

	function next(cjdns) {
		cjdns.NodeStore_nodeForAddr(ip, function (err, resp) {
			cb(resp && resp.result && resp.result.key);
			cjdns.disconnect();
		});
	}
}

/* Editing */

function editFiles(dataByPath, namesByPath, cb, infos) {
	var paths = Object.keys(dataByPath);
	childProc.spawn(process.env.EDITOR || defaultEditor, paths, {
		stdio: [0, 1, 2]
	}).on("close", onEditorClose);

	function onEditorClose(status) {
		if (status)
			return cb("Editor exited uncleanly.");

		/* List files with invalid JSON */
		var invalids = {};
		var invalidNames = [];
		if (!infos) infos = {};

		for (var path in dataByPath) {
			var oldData = dataByPath[path];
			var newData = fs.readFileSync(path, encoding);
			if (newData == oldData) {
				/* Data is unchanged. */
				continue;
			}

			var info;
			if (newData) try {
				info = JSON.parse(newData);
				infos[path] = info;
			} catch(e) {
				invalids[path] = oldData;
				invalidNames.push(namesByPath[path]);
			}
		}

		if (invalidNames.length) {
			if (invalidNames.length == 1)
				console.error("Data is not valid JSON.");
			else
				console.error("Invalid JSON in:", invalidNames.join(", "));
			if (promptYesNoSync("Re-edit?"))
				editFiles(invalids, namesByPath, cb, infos);
		} else {
			cb(null, infos);
		}
	}
}

/* Validation */

function checkService(warn, srv, i) {
	if (!srv.name)
		warn("Service", i, "missing name");
	var uris = srv.uris;
	if (uris) {
		if (srv.uri)
			warn("Service", i, "has both uri and uris");
		if (typeof uris != "object")
			warn("Service", i, "has invalid uris");
	} else if (!srv.uri)
		warn("Service", i, "missing uri/uris");
}

function checkInfo(warn, info) {
	/* TODO: use a JSON schema validator */
	if (!info) {
		warn("Info is empty");
		return;
	}

	if (!info.key)
		warn("Missing key");
	else if (!/[0-9a-z]{52}\.k/.test(info.key))
		warn("Invalid key");

	if (!info.hostname)
		warn("Missing hostname");

	if (!info.ip)
		warn("Missing ip");
	else if (!/^fc[0-9a-f:]*$/.test(info.ip))
		warn("Invalid ip");

	var contact = info.contact;
	if (!contact)
		warn("Missing contact");
	else {
		if (typeof contact == "object" && !contact.name && !contact.email)
			warn("Missing contact name/email");
	}

	var pgp = contact && contact.pgp || info.pgp;
	if (!pgp)
		warn("Missing pgp");
	else {
		if (!pgp.fingerprint)
			warn("Missing pgp fingerprint");
		if (!pgp.keyserver && !pgp.full)
			warn("Missing pgp keyserver/url");
	}

	var location = info.location;
	if (!location)
		warn("Missing location");
	else {
		// longitude, latitude, and altitude are unlikely to be used
		// maybe we don't even want to warn in their cases?
		if (!location.longitude)
			warn("Missing longitude");
		if (!location.latitude)
			warn("Missing latitude");
		if (!location.altitude)
			warn("Missing altitude");

		var continent = location.continent;
		if (!continent)
			warn("Missing continent");
		else if (validContinents.indexOf(continent.toUpperCase()) == -1)
			warn("Invalid Continent code");

		if (!location.region)
			warn("Missing region");
		if (!location.municipality)
			warn("Missing municipality");
		if (!location.uri)
			warn("Missing meshlocal uri");
	}

	var services = info.services;
	if (services) {
		if (typeof services != "object")
			warn("Invalid services");
		else if (services[0])
			services.forEach(checkService.bind(this, warn));
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
	info.key = promptSyncDefault("cjdns public key", info.key);

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

	var loc = info.location || {};
	if ([
		loc.longitude = promptSyncDefault("Longitude", loc.longitude),
		loc.latitude = promptSyncDefault("Latitude", loc.latitude),
		loc.altitude = promptSyncDefault("Altitude (m)", loc.altitude),
		loc.continent = promptSyncDefault("Continent",
			(console.log("Valid continent codes include %s", validContinents),
				loc.continent)),
		loc.region = promptSyncDefault("Region", loc.region),
		loc.municipality = promptSyncDefault("Municipality", loc.municipality),
		loc.uri = promptSyncDefault("Meshlocal uri", loc.uri)
	].some(Boolean)) {
		info.location = loc;

		// Try to coerce values to numbers
		if (!isNaN(loc.longitude))
			loc.longitude = +loc.longitude;
		if (!isNaN(loc.latitude))
			loc.latitude = +loc.latitude;
		if (!isNaN(loc.altitude))
			loc.altitude = +loc.altitude;
	}
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

function usage() {
	console.log([
		"Usage: " + binName + " <command> [<arguments>]",
		"Commands for managing:",
		"    ls",
		"    add <name> <path>",
		"    rm <name>...",
		"    rename <old> <new>",
		"    check [<name>...]",
		"Commands for editing:",
		"    init [<name>]",
		"    touch [<name>...]",
		"    cat [<name>...]",
		"    put <name>",
		"    edit [<name>...]",
	].join("\n"));
}

var commands = {
	ls: function (argv) {
		if (argv._.length || argv.help) {
			console.log("Usage:", binName, "ls");
			return argv.help ? 0 : 1;
		}

		for (var name in conf.infos) {
			var info = conf.infos[name];
			console.log(name + "\t" + info.path);
		}
	},

	add: function (argv) {
		var name = argv._.shift();
		var path = argv._.shift();
		if (!name || !path || argv._.length || argv.help) {
			console.log("Usage:", binName, "add <name> <path>");
			return argv.help ? 0 : 1;
		}

		if (conf.infos[name]) {
			console.error("Remote", name, "already exists");
			return 1;
		}

		conf.infos[name] = {
			path: path
		};
		writeConfSync();
	},

	rm: function (argv) {
		var names = argv._;
		if (!names.length || argv.help) {
			console.log("Usage:", binName, "rm <name>...");
			return argv.help ? 0 : 1;
		}

		var remotes = filterRemotes(names);
		if (!remotes.length) {
			console.error("No remote", names.join(", "));
			return 1;
		}

		remotes.forEach(function (name) {
			delete conf.infos[name];
		});
		writeConfSync();
	},

	rename: function (argv) {
		var from = argv._.shift();
		var to = argv._.shift();
		if (argv._.length || argv.help) {
			console.log("Usage:", binName, "rename <old> <new>");
			return argv.help ? 0 : 1;
		}

		if (!conf.infos[from]) {
			console.error("Remote", from, "doesn't exist");
			return 1;
		}

		if (conf.infos[to]) {
			console.error("Remote", to, "already exists");
			return 1;
		}

		conf.infos[to] = conf.infos[from];
		delete conf.infos[from];
		writeConfSync();
	},

	check: function (argv) {
		if (argv.help) {
			console.log("Usage:", binName, "check [<name>]...");
			return argv.help ? 0 : 1;
		}

		var names = filterRemotes(argv._);
		var waiting = names.length;
		var warnings = 0;

		names.forEach(function (name) {
			getInfo(name, function (info) {
				checkInfo(function (msg) {
					warnings++;
					console.log(name + ": " + msg);
				}, info);
				if (!--waiting)
					done();
			});
		});
		function done() {
			if (warnings)
				process.exit(1);
		}
	},

	init: function (argv) {
		var name = argv._.shift();
		if (argv._.length || argv.help) {
			console.log("Usage:", binName, "init [<name>]");
			return argv.help ? 0 : 1;
		}

		if (!name) try {
			name = promptSyncDefault("Node name (for nij use)", "local");
		} catch(e) {
			handleEOF(e);
		}

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
		if (argv.help) {
			console.log("Usage:", binName, "touch [<name>]...");
			return;
		}

		filterRemotes(argv._).forEach(function (name) {
			getInfo(name, saveInfo.bind(this, name));
		});
	},

	cat: function (argv) {
		if (argv.help) {
			console.log("Usage:", binName, "cat [<name>...]");
			return;
		}

		filterRemotes(argv._).forEach(function (name) {
			getInfo(name, function (info) {
				var data = JSON.stringify(info, null, 3);
				console.log(data);
			});
		});
	},

	put: function (argv) {
		var name = argv._.shift();
		if (argv._.length || argv.help) {
			console.log("Usage:", binName, "put <name>");
			return argv.help ? 0 : 1;
		}

		var data = fs.readFileSync("/dev/stdin", encoding);
		var info;
		try {
			info = JSON.parse(data);
		} catch(e) {
			console.log("Data is not valid JSON.");
			return 1;
		}
		saveInfo(name, info);
	},

	edit: function (argv) {
		if (argv.help) {
			console.log("Usage:", binName, "edit [<name>...]");
			return;
		}

		var names = filterRemotes(argv._);
		var waiting = names.length;
		/* store original data for comparison after editing */
		var namesByPath = {};
		var dataByPath = {};

		names.forEach(function (name) {
			getInfo(name, function (info) {
				var name2 = name.replace(/\//g, "-");
				var template = "/tmp/nodeinfo-" + name2 + "-XXXXXXX.json";
				var path = mktemp.createFileSync(template);
				namesByPath[path] = name;
				var data;
				if (info == null) {
					data = "";
				} else {
					if (info.last_modified)
						info.last_modified += " (auto-updated)";
					data = JSON.stringify(info, null, 3);
					fs.writeFileSync(path, data, encoding);
				}
				dataByPath[path] = data;
				if (!--waiting) next();
			});
		});

		function next() {
			editFiles(dataByPath, namesByPath, function (err, infos) {
				Object.keys(dataByPath).forEach(fs.unlink);
				if (err)
					return console.error(err);
				for (var path in infos) {
					var info = infos[path];
					var name = namesByPath[path];
					checkInfo(function (msg) {
						console.log(name + ": " + msg);
					}, info);
					saveInfo(name, info);
				}
			});
		}
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
	var ret = commands[cmd](argv);
	if (ret != null)
		process.exit(ret);
} else {
	usage();
	process.exit(1);
}

