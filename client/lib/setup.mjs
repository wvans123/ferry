// Everything about this computer: finding Python, running a private Ferry server, installing and updating Ferry.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FERRY_HOME, loadConfig, saveConfig } from "./config.mjs";
import { downloadMissing, installBundled, tarCommand, toolStatus } from "./toolbins.mjs";

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WIN = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Python ----------

function pythonCandidates(cfg) {
	const c = [];
	if (process.env.FERRY_PYTHON) c.push([process.env.FERRY_PYTHON]);
	if (Array.isArray(cfg?.python) && cfg.python.length) c.push(cfg.python);
	c.push(...(WIN ? [["python"], ["py", "-3"], ["python3"]] : [["python3"], ["python"]]));
	return c;
}

function runPy(py, code) {
	return spawnSync(py[0], [...py.slice(1), "-c", code], { encoding: "utf8", timeout: 30000, windowsHide: true });
}

/** A Python that can run the Ferry server (withServer) or at least install it (3.11 or newer). */
export function findPython(cfg, withServer = true) {
	const code = withServer ? "import ferry_server" : "import sys; assert sys.version_info >= (3, 11)";
	for (const py of pythonCandidates(cfg)) {
		if (runPy(py, code).status === 0) return py;
	}
	return null;
}

/**
 * Every Python 3.11+ on this computer that can be found, each once (by its own path): FERRY_PYTHON, the one saved
 * in the settings, python / py -3 / python3 on the PATH, and on Windows every Python the launcher knows (py -0p).
 * A desktop icon may start the server with another Python than the one first on the PATH; this finds that one too.
 */
export function allPythons(cfg = {}) {
	const cands = pythonCandidates(cfg);
	if (WIN) {
		const r = spawnSync("py", ["-0p"], { encoding: "utf8", timeout: 15000, windowsHide: true });
		for (const line of (r.stdout ?? "").split(/\r?\n/)) {
			const m = /([A-Za-z]:\\.*?pythonw?\.exe)\s*$/i.exec(line);
			if (m) cands.push([m[1]]);
		}
	}
	const seen = new Set();
	const out = [];
	for (const py of cands) {
		const r = runPy(py, "import os, sys; print(sys.executable); print(os.path.realpath(sys.executable)); " +
			"print(sys.version_info >= (3, 11))");
		const [exe = "", real = "", ok = ""] = r.status === 0 ? r.stdout.trim().split(/\r?\n/) : [];
		if (ok.trim() !== "True" || !exe || seen.has(real.trim().toLowerCase())) continue;
		seen.add(real.trim().toLowerCase());
		out.push(exe.trim());
	}
	return out;
}

/** The Ferry server version installed in this Python ("" for none), and whether it is a normal install (in
 * site-packages) rather than one run from a source folder (pip install -e, a developer's checkout). */
export function serverIn(exe) {
	const r = runPy([exe], "import ferry_server; print(ferry_server.__version__); print(ferry_server.__file__)");
	if (r.status !== 0) return { version: "", installed: false };
	const [version = "", file = ""] = r.stdout.trim().split(/\r?\n/);
	return { version: version.trim(), installed: /[\\/](site|dist)-packages[\\/]/i.test(file) };
}

async function serverHealth(port) {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
		return r.ok ? await r.json() : null;
	} catch {
		return null;
	}
}

/**
 * After an upgrade: a Ferry server of an older version still running on this computer is replaced by the new one,
 * started the way the desktop icon does (pythonw -m ferry_server --background stops the old one with the admin key).
 * Returns a line for the install output, or "" when no server runs here.
 */
export async function restartLocalServer(version, exe, port = process.env.FERRY_PORT ?? 8787) {
	const h = await serverHealth(port);
	if (!h?.version) return "";
	if (h.version === version) return `running ${version} on port ${port}`;
	const w = WIN ? join(dirname(exe), "pythonw.exe") : exe;
	const child = spawn(existsSync(w) ? w : exe, ["-m", "ferry_server", "--background"],
		{ detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, FERRY_PORT: String(port) } });
	child.unref();
	for (let i = 0; i < 60; i++) {
		await sleep(500);
		if ((await serverHealth(port))?.version === version) return `restarted: ${h.version} -> ${version} on port ${port}`;
	}
	return `a Ferry server ${h.version} still runs on port ${port}: stop it on its admin page (设置 > 停止服务端), then start it again`;
}

// ---------- a private Ferry server for this ferry process ----------

function freePort() {
	return new Promise((res, rej) => {
		const s = createServer();
		s.once("error", rej);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => res(port));
		});
	});
}

/**
 * Start ferry-server on a free port for as long as this ferry process runs and return { url, token }.
 * Every ferry window gets its own, so closing one window never breaks another.
 */
export async function startLocalServer(cfg, healthy) {
	const py = findPython(cfg);
	if (!py) {
		throw new Error("the Ferry server is not installed for Python on this computer.\n" +
			"  Install Ferry with:  ferry install   (from the unpacked Ferry folder, see INSTALL-WINDOWS.md)\n" +
			"  Or use a Ferry server on another machine:  ferry login <server-url> <token>");
	}
	const port = await freePort();
	const token = randomBytes(24).toString("base64url");
	mkdirSync(FERRY_HOME, { recursive: true });
	const logPath = join(FERRY_HOME, "server.log");
	const log = openSync(logPath, "a");
	writeSync(log, `\n--- ${new Date().toISOString()} ferry-server started by ferry (pid ${process.pid}) on port ${port}\n`);
	const child = spawn(py[0], [...py.slice(1), "-m", "ferry_server"], {
		stdio: ["ignore", log, log],
		windowsHide: true,
		env: { ...process.env, FERRY_PORT: String(port), FERRY_TOKEN: token, FERRY_NO_DISCOVERY: "1" },
	});
	child.unref(); // never keep ferry running just because the server is
	process.on("exit", () => {
		try {
			child.kill();
		} catch {
			// already gone
		}
	});
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => process.exit(130));
	const url = `http://127.0.0.1:${port}`;
	for (let i = 0; i < 150; i++) {
		await sleep(200);
		if (child.exitCode !== null) throw new Error(`ferry-server stopped right after starting; see ${logPath}`);
		if (await healthy(url)) return { url, token };
	}
	throw new Error(`ferry-server did not come up within 30 s; see ${logPath}`);
}

// ---------- install / update ----------

const DEP_DIRS = ["node_modules", "vendor", "wheels"]; // big, and the same from one version to the next most of the time

/**
 * Copy a folder by hard links where the drive allows (instant, no extra space; nothing in these folders is ever
 * changed in place), else by copying. Used for the dependencies a new version takes over from the installed one.
 */
export function linkTree(src, dst) {
	mkdirSync(dst, { recursive: true });
	for (const name of readdirSync(src)) {
		const from = join(src, name);
		const to = join(dst, name);
		const st = lstatSync(from);
		if (st.isDirectory()) linkTree(from, to);
		else if (st.isSymbolicLink()) {
			try {
				symlinkSync(readlinkSync(from), to);
			} catch {
				// a link that cannot be made (Windows without the right): skip it, npm's .bin links are not needed
			}
		} else if (!existsSync(to)) {
			try {
				linkSync(from, to);
			} catch {
				copyFileSync(from, to);
			}
		}
	}
}

/** deps.json of an installed copy or an unpacked package: what its dependencies are made of (scripts/build_bundle.py). */
export function readDeps(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, "deps.json"), "utf8"));
	} catch {
		return null;
	}
}

export const sameDeps = (a, b) => !!a && !!b && ["node", "python", "tools"].every((k) => a[k] && a[k] === b[k]);

/**
 * A small package (Ferry's own code only) unpacked at root: take the dependencies over from the installed copy, which
 * must have the same ones. Returns false when root is a full package.
 */
export function completeSmallPackage(root, installed = APP_ROOT) {
	if (!existsSync(join(root, "small-package.json"))) return false;
	const theirs = readDeps(root);
	const mine = readDeps(installed);
	if (!sameDeps(mine, theirs)) {
		throw new Error(`this is a small update package for a Ferry with the same dependencies as ${theirs?.version ?? "it"}, ` +
			`but this Ferry (${mine?.version ?? "an older install"}) has others: use the full ferry-windows zip`);
	}
	const own = existsSync(join(root, "wheels")) ? new Set(readdirSync(join(root, "wheels"))) : new Set();
	for (const d of DEP_DIRS) if (existsSync(join(installed, d))) linkTree(join(installed, d), join(root, d));
	for (const w of existsSync(join(root, "wheels")) ? readdirSync(join(root, "wheels")) : []) {
		if (w.startsWith("ferry_server-") && !own.has(w)) rmSync(join(root, "wheels", w)); // the old server: not again
	}
	rmSync(join(root, "small-package.json"));
	return true;
}

/** Where installed versions live: %LOCALAPPDATA%\Ferry on Windows, ~/.local/share/ferry elsewhere. */
function installBase() {
	if (process.env.FERRY_INSTALL_DIR) return { dir: process.env.FERRY_INSTALL_DIR, cmdDir: null };
	if (WIN) return { dir: join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Ferry"), cmdDir: "%LOCALAPPDATA%\\Ferry" };
	return { dir: join(homedir(), ".local", "share", "ferry"), cmdDir: null };
}

/** The folder this copy was installed into (…\\versions\\<v> under it), or "" for a git checkout / unpacked zip. */
function installedHere() {
	const here = resolve(APP_ROOT, "..", "..");
	return basename(resolve(APP_ROOT, "..")) === "versions" && existsSync(join(here, "current.txt")) ? here : "";
}

const onPath = (dir) => (process.env.PATH ?? process.env.Path ?? "").split(delimiter)
	.some((p) => p && resolve(p).toLowerCase() === resolve(dir).toLowerCase());

/** Folder for the `ferry` command: one already on PATH (npm's global folder on Windows) when possible. */
function binDir() {
	if (process.env.FERRY_BIN_DIR) return process.env.FERRY_BIN_DIR;
	const cands = WIN ? [process.env.APPDATA && join(process.env.APPDATA, "npm"), dirname(process.execPath)]
		: [join(homedir(), ".local", "bin")];
	return cands.find((d) => d && existsSync(d) && onPath(d)) ?? cands.find(Boolean);
}

/**
 * `ferry install`, run from an unpacked Ferry folder (a release zip or a git checkout):
 * copy it to the install folder, install the server into the normal Python (no venv), add the `ferry` command.
 */
export async function install(version, clientOnly = !!process.env.FERRY_CLIENT_ONLY) {
	const { dir, cmdDir } = installBase();
	const dest = join(dir, "versions", version);
	const say = (m) => console.log(m);
	say(`Installing Ferry ${version}`);
	if (resolve(APP_ROOT) !== resolve(dest)) {
		rmSync(dest, { recursive: true, force: true });
		mkdirSync(dest, { recursive: true });
		for (const name of readdirSync(APP_ROOT)) {
			if (name.startsWith(".") || ["data", "dist", "__pycache__"].includes(name)) continue;
			if (DEP_DIRS.includes(name)) linkTree(join(APP_ROOT, name), join(dest, name));
			else cpSync(join(APP_ROOT, name), join(dest, name), { recursive: true });
		}
	}
	say(`  files     ${dest}`);

	// fd and ripgrep for the agent's file search tools: from the release zip, else from GitHub (git checkout)
	installBundled(dest);
	let missing = Object.entries(toolStatus()).filter(([, s]) => !s).map(([n]) => n);
	if (missing.length && !process.env.FERRY_NO_TOOL_DOWNLOAD) {
		say(`  tools     downloading ${missing.join(", ")} from GitHub...`);
		const r = await downloadMissing();
		if (r.failed.length) say(`  tools     could not download ${r.failed.join(", ")}`);
		missing = Object.entries(toolStatus()).filter(([, s]) => !s).map(([n]) => n);
	}
	say(missing.length
		? `  tools     ${missing.join(" and ")} missing: file search is slower. Use the release zip (it includes them).`
		: "  tools     fd and rg ready");

	// the server half, into the Python that is already there: every Python that has a Ferry server gets the new one
	// (a desktop icon may use another Python than the first on the PATH); none yet: the first Python 3.11+
	const wheels = join(dest, "wheels");
	const carries = existsSync(wheels) || existsSync(join(dest, "server", "pyproject.toml"));
	const pythons = carries ? allPythons(loadConfig()) : [];
	const had = pythons.map((exe) => ({ exe, ...serverIn(exe) }));
	// servers installed the normal way are upgraded (also on a --client-only install, where a server was added by
	// hand); one run from a source folder is a developer's and left alone; no server yet: the first Python, unless
	// --client-only
	const targets = had.some((p) => p.installed) ? had.filter((p) => p.installed) : clientOnly ? [] : had.slice(0, 1);
	for (const p of had.filter((x) => x.version && !x.installed)) say(`  server    ${p.version} in ${p.exe} runs from a source folder: left alone`);
	if (!carries) {
		say("  server    not in this package");
	} else if (!targets.length) {
		say(clientOnly ? "  server    skipped (--client-only): use a server on another machine with ferry login"
			: "  server    SKIPPED: no Python 3.11+ found (python / py -3). Install Python from python.org with\n" +
			"            \"Add python.exe to PATH\" ticked, then run ferry install again. Until then you can only use\n" +
			"            a server on another machine (ferry login).");
	} else {
		const args = existsSync(wheels)
			? ["-m", "pip", "install", "--disable-pip-version-check", "--no-index", "--find-links", wheels, "--upgrade", "ferry-server"]
			: ["-m", "pip", "install", "--disable-pip-version-check", "--upgrade", join(dest, "server")];
		const done = [];
		for (const t of targets) {
			const r = spawnSync(t.exe, args, { stdio: ["ignore", "ignore", "inherit"], windowsHide: true });
			const now = serverIn(t.exe).version;
			if (r.status === 0 && now) done.push(t.exe);
			say(`  server    ${r.status === 0 ? `${t.version ? `${t.version} -> ` : ""}${now}` : "FAILED (see pip output above)"}  in ${t.exe}`);
			if (r.status !== 0) process.exitCode = 1;
		}
		if (done.length) {
			saveConfig({ python: [done[0]] });
			const line = await restartLocalServer(version, done[0]);
			if (line) say(`  server    ${line}`);
		}
	}

	// the `ferry` command: a tiny launcher that always runs the current version
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "current.txt"), dest, "utf8");
	// how it was installed, so `ferry update` can do the same again (a git checkout: pull it and install from it)
	let prev = {};
	try {
		prev = JSON.parse(readFileSync(join(dir, "install.json"), "utf8"));
	} catch {
		// first install
	}
	const source = existsSync(join(APP_ROOT, ".git")) ? APP_ROOT : prev.source && existsSync(join(prev.source, ".git")) && !process.env.FERRY_FROM_ZIP ? prev.source : "";
	writeFileSync(join(dir, "install.json"), JSON.stringify({ source, clientOnly: !!clientOnly }, null, 2), "utf8");
	writeFileSync(join(dir, "launcher.mjs"), [
		"// Runs the Ferry version named in current.txt (written by ferry install / ferry update)",
		'import { readFileSync } from "node:fs";',
		'import { dirname, join } from "node:path";',
		'import { fileURLToPath, pathToFileURL } from "node:url";',
		'const here = dirname(fileURLToPath(import.meta.url));',
		'const app = readFileSync(join(here, "current.txt"), "utf8").trim();',
		'await import(pathToFileURL(join(app, "client", "bin", "ferry.mjs")).href);',
		"",
	].join("\n"), "utf8");
	const bin = binDir();
	mkdirSync(bin, { recursive: true });
	if (WIN) {
		// %LOCALAPPDATA% is expanded by cmd, so a non-ASCII user name never ends up inside the .cmd file
		const launcher = cmdDir ? `${cmdDir}\\launcher.mjs` : join(dir, "launcher.mjs");
		writeFileSync(join(bin, "ferry.cmd"), `@node "${launcher}" %*\r\n`, "utf8");
		// Git Bash (the agent's shell, and "!ferry check" inside ferry) does not run .cmd files by their bare name
		const shLauncher = cmdDir ? "$LOCALAPPDATA/Ferry/launcher.mjs" : join(dir, "launcher.mjs").replace(/\\/g, "/");
		writeFileSync(join(bin, "ferry"), `#!/bin/sh\nexec node "${shLauncher}" "$@"\n`, "utf8");
	} else {
		writeFileSync(join(bin, "ferry"), `#!/bin/sh\nexec node "${join(dir, "launcher.mjs")}" "$@"\n`, { mode: 0o755 });
	}
	say(`  command   ${join(bin, WIN ? "ferry.cmd" : "ferry")}`);

	// keep this version and the one before it
	try {
		const vers = readdirSync(join(dir, "versions")).filter((v) => v !== version).sort((a, b) => (newer(a, b) ? 1 : -1));
		for (const v of vers.slice(0, -1)) rmSync(join(dir, "versions", v), { recursive: true, force: true });
	} catch {
		// an old version still in use; it goes next time
	}

	if (!onPath(bin)) {
		say(`\nOne more thing: ${bin} is not on PATH yet. Add it once (Windows: Settings > search "environment variables" >\n` +
			`Edit environment variables for your account > Path > New), then open a new window.`);
	}
	say(`\nDone. Open a NEW cmd window, go to a project folder and run:  ferry`);
}

function newer(a, b) {
	const p = (v) => v.replace(/^v/, "").split(".").map((x) => parseInt(x, 10) || 0);
	const [x, y] = [p(a), p(b)];
	for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
	return false;
}

/** `ferry update [file.zip]`: get the latest release from GitHub (or use a zip you downloaded) and install it. */
/** Installed from a git checkout (git clone, npm ci, ferry install): git pull, npm ci, and install from it again. */
function updateCheckout(checkout, info, env) {
	const run = (cmd, args) => {
		console.log(`> ${cmd} ${args.join(" ")}   (in ${checkout})`);
		const r = spawnSync(cmd, args, { cwd: checkout, stdio: "inherit", shell: WIN, env });
		if (r.status !== 0) throw new Error(`"${cmd} ${args.join(" ")}" failed in ${checkout}`);
	};
	const head = () => spawnSync("git", ["rev-parse", "HEAD"], { cwd: checkout, encoding: "utf8", shell: WIN }).stdout?.trim();
	const before = head();
	run("git", ["pull", "--ff-only"]);
	if (before && before === head() && existsSync(join(checkout, "node_modules"))) {
		const v = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).version;
		if (resolve(APP_ROOT) === resolve(checkout) || resolve(APP_ROOT).endsWith(v)) return console.log(`Ferry ${v} is the latest version.`);
	}
	run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"]);
	if (resolve(APP_ROOT) !== resolve(checkout)) { // the ferry command runs an installed copy: install the new one
		run(process.execPath, [join(checkout, "client", "bin", "ferry.mjs"), "install", ...(info.clientOnly ? ["--client-only"] : [])]);
	}
	const v = JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).version;
	console.log(`\nUpdated to ${v}. Restart any open ferry windows.`);
}

/** The version current.txt points at (the folder name under versions), or "". */
function installedVersion(env) {
	try {
		const dir = env.FERRY_INSTALL_DIR || installBase().dir;
		return basename(readFileSync(join(dir, "current.txt"), "utf8").trim());
	} catch {
		return "";
	}
}

const packageVersion = (root) => {
	try {
		return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "";
	} catch {
		return "";
	}
};

export async function update(version, repo, zipArg) {
	// install the new version where this one is (e.g. D:\ferry\app), not in the default folder
	const here = installedHere();
	const defaultDir = installBase().dir;
	const env = here && resolve(here).toLowerCase() !== resolve(defaultDir).toLowerCase() ? { ...process.env, FERRY_INSTALL_DIR: here } : { ...process.env };
	let info = {};
	try {
		info = JSON.parse(readFileSync(join(here || defaultDir, "install.json"), "utf8"));
	} catch {
		// installed by an older Ferry
	}
	// `ferry update --release` (or a release feed set with FERRY_UPDATE_URL): the release zip even for a git checkout
	const release = zipArg === "--release" || !!process.env.FERRY_UPDATE_URL;
	if (zipArg === "--release") zipArg = undefined;
	const checkout = existsSync(join(APP_ROOT, ".git")) ? APP_ROOT : info.source && existsSync(join(info.source, ".git")) ? info.source : "";
	if (!zipArg && checkout && !release) return updateCheckout(checkout, info, env);
	if (info.clientOnly) env.FERRY_CLIENT_ONLY = "1";
	env.FERRY_FROM_ZIP = "1";
	let zip = zipArg && resolve(zipArg);
	const tmp = mkdtempSync(join(tmpdir(), "ferry-update-"));
	try {
		if (!zip) {
			const api = process.env.FERRY_UPDATE_URL ?? `https://api.github.com/repos/${repo}/releases/latest`;
			console.log(`Checking ${api}`);
			const r = await fetch(api, { headers: { "User-Agent": `ferry/${version}`, Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(20000) });
			if (!r.ok) throw new Error(`HTTP ${r.status} from ${api}${r.status === 404 ? " (no release published yet?)" : ""}`);
			const rel = await r.json();
			const latest = rel.tag_name ?? "";
			if (!newer(latest, version)) {
				console.log(`Ferry ${version} is the latest version.`);
				return;
			}
			const full = (rel.assets ?? []).find((a) => /^ferry-windows-.*\.zip$/.test(a.name));
			const app = (rel.assets ?? []).find((a) => /^ferry-app-.*\.zip$/.test(a.name));
			const depsAsset = (rel.assets ?? []).find((a) => /^ferry-deps-.*\.json$/.test(a.name));
			// the dependencies did not change (most releases): Ferry's own code is enough, the rest stays as installed
			let small = false;
			if (app && depsAsset && readDeps(APP_ROOT)) {
				const theirs = await fetch(depsAsset.browser_download_url, { headers: { "User-Agent": `ferry/${version}` },
					signal: AbortSignal.timeout(20000) }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
				small = sameDeps(readDeps(APP_ROOT), theirs);
			}
			const asset = small ? app : full;
			if (!asset) throw new Error(`release ${latest} has no ferry-windows-*.zip`);
			console.log(small ? `Downloading ${asset.name} (${Math.max(1, Math.round(asset.size / 1e3))} KB: Ferry's own code; ` +
				"its dependencies have not changed and stay as they are)" : `Downloading ${asset.name} (${Math.round(asset.size / 1e6)} MB)`);
			const d = await fetch(asset.browser_download_url, { headers: { "User-Agent": `ferry/${version}` }, signal: AbortSignal.timeout(600000) });
			if (!d.ok) throw new Error(`download failed: HTTP ${d.status}`);
			zip = join(tmp, asset.name);
			writeFileSync(zip, Buffer.from(await d.arrayBuffer()));
		}
		const out = join(tmp, "x");
		mkdirSync(out);
		// tar ships with Windows 10 and 11 and reads zip files; elsewhere use Python's zipfile
		const py = findPython({}, false);
		const x = WIN || !py
			? spawnSync(tarCommand(), ["-xf", zip, "-C", out], { stdio: "inherit" })
			: spawnSync(py[0], [...py.slice(1), "-m", "zipfile", "-e", zip, out], { stdio: "inherit" });
		if (x.status !== 0) throw new Error(`could not unpack ${zip}`);
		const root = [out, ...readdirSync(out).map((n) => join(out, n))].find((d) => existsSync(join(d, "client", "bin", "ferry.mjs")));
		if (!root) throw new Error(`${zip} does not look like a Ferry package`);
		if (completeSmallPackage(root)) console.log("Small package: the dependencies are taken over from the installed version.");
		const r = spawnSync(process.execPath, [join(root, "client", "bin", "ferry.mjs"), "install"], { stdio: "inherit", env });
		if (r.status !== 0 && installedVersion(env) === packageVersion(root)) {
			// the install got done, and something failed or crashed at the very end (seen with Node on Windows):
			// the new version is in place all the same
			console.log(`\n(The install step ended with exit code ${r.status ?? r.signal}, after the new version was in place; ` +
				"anything it reported above may need a look.)");
			r.status = 0;
		}
		if (r.status === 0) {
			console.log(`\nUpdated from ${version}. Restart any open ferry windows.`);
			const h = await serverHealth(process.env.FERRY_PORT ?? 8787);
			const now = packageVersion(root);
			if (h?.version && h.version !== now) console.log(`A Ferry server ${h.version} is still running on this computer: ` +
				"stop it (admin page > 设置 > 停止服务端) and start it again with the Ferry Server icon.");
		}
		if (r.status !== 0) throw new Error("install step failed");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}
