// Everything about this computer: finding Python, running a private Ferry server, installing and updating Ferry.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	rmSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FERRY_HOME, saveConfig } from "./config.mjs";
import { downloadMissing, installBundled, toolStatus } from "./toolbins.mjs";

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

/** Where installed versions live: %LOCALAPPDATA%\Ferry on Windows, ~/.local/share/ferry elsewhere. */
function installBase() {
	if (process.env.FERRY_INSTALL_DIR) return { dir: process.env.FERRY_INSTALL_DIR, cmdDir: null };
	if (WIN) return { dir: join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Ferry"), cmdDir: "%LOCALAPPDATA%\\Ferry" };
	return { dir: join(homedir(), ".local", "share", "ferry"), cmdDir: null };
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
			cpSync(join(APP_ROOT, name), join(dest, name), { recursive: true });
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

	// the server half, into the Python that is already there
	const py = clientOnly ? null : findPython({}, false);
	if (clientOnly) {
		say("  server    skipped (--client-only): use a server on another machine with ferry login");
	} else if (!py) {
		say("  server    SKIPPED: no Python 3.11+ found (python / py -3). Install Python from python.org with\n" +
			"            \"Add python.exe to PATH\" ticked, then run ferry install again. Until then you can only use\n" +
			"            a server on another machine (ferry login).");
	} else {
		const wheels = join(dest, "wheels");
		const args = existsSync(wheels)
			? ["-m", "pip", "install", "--disable-pip-version-check", "--no-index", "--find-links", wheels, "--upgrade", "ferry-server"]
			: ["-m", "pip", "install", "--disable-pip-version-check", "--upgrade", join(dest, "server")];
		say(`  server    ${py.join(" ")} ${args.join(" ")}`);
		const r = spawnSync(py[0], [...py.slice(1), ...args], { stdio: "inherit", windowsHide: true });
		if (r.status !== 0) {
			say("  server    FAILED (see pip output above)");
			process.exitCode = 1;
		} else {
			saveConfig({ python: py });
		}
	}

	// the `ferry` command: a tiny launcher that always runs the current version
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "current.txt"), dest, "utf8");
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
export async function update(version, repo, zipArg) {
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
			const asset = (rel.assets ?? []).find((a) => /^ferry-windows-.*\.zip$/.test(a.name));
			if (!asset) throw new Error(`release ${latest} has no ferry-windows-*.zip`);
			console.log(`Downloading ${asset.name} (${Math.round(asset.size / 1e6)} MB)`);
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
			? spawnSync("tar", ["-xf", zip, "-C", out], { stdio: "inherit" })
			: spawnSync(py[0], [...py.slice(1), "-m", "zipfile", "-e", zip, out], { stdio: "inherit" });
		if (x.status !== 0) throw new Error(`could not unpack ${zip}`);
		const root = [out, ...readdirSync(out).map((n) => join(out, n))].find((d) => existsSync(join(d, "client", "bin", "ferry.mjs")));
		if (!root) throw new Error(`${zip} does not look like a Ferry package`);
		const r = spawnSync(process.execPath, [join(root, "client", "bin", "ferry.mjs"), "install"], { stdio: "inherit" });
		if (r.status === 0) console.log(`\nUpdated from ${version}. Restart any open ferry windows.`);
		if (r.status !== 0) throw new Error("install step failed");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}
