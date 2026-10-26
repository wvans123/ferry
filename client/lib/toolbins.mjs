// fd and ripgrep: the agent's "find files" and "search in files" tools need them.
// pi would download them from GitHub itself, but Ferry runs pi offline, so Ferry puts them in place instead:
// copied from the release zip (vendor/<platform>/), or downloaded once by `ferry install` for a git checkout.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_DIR } from "./config.mjs";

const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";
export const BIN_DIR = join(AGENT_DIR, "bin"); // where pi looks first

// Pinned so the release zip and a git checkout get the same programs
export const TOOLS = [
	{ name: "fd", version: "10.2.0", url: (t) => `https://github.com/sharkdp/fd/releases/download/v10.2.0/fd-v10.2.0-${t}` },
	{ name: "rg", version: "14.1.1", url: (t) => `https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-${t}` },
];

export function platformKey(platform = process.platform, arch = process.arch) {
	const cpu = arch === "arm64" ? "aarch64" : "x86_64";
	if (platform === "win32") return { key: `win32-${arch}`, asset: `${cpu}-pc-windows-msvc.zip` };
	if (platform === "darwin") return { key: `darwin-${arch}`, asset: `${cpu}-apple-darwin.tar.gz` };
	if (platform === "linux") return { key: `linux-${arch}`, asset: `${cpu}-unknown-linux-musl.tar.gz` };
	return null;
}

function onPath(name) {
	const r = spawnSync(name, ["--version"], { stdio: "pipe", windowsHide: true });
	return !r.error;
}

/** "agent" (in pi's bin folder), "system" (on PATH) or "" (missing), for each tool. */
export function toolStatus() {
	return Object.fromEntries(TOOLS.map((t) => [t.name,
		existsSync(join(BIN_DIR, t.name + EXE)) ? "agent" : onPath(t.name) || (t.name === "fd" && onPath("fdfind")) ? "system" : ""]));
}

/** Copy bundled binaries (release zip: <app>/vendor/<platform>/) into pi's bin folder. Returns the names copied. */
export function installBundled(appRoot) {
	const p = platformKey();
	const src = p && join(appRoot, "vendor", p.key);
	if (!src || !existsSync(src)) return [];
	mkdirSync(BIN_DIR, { recursive: true });
	const done = [];
	for (const t of TOOLS) {
		const from = join(src, t.name + EXE);
		const to = join(BIN_DIR, t.name + EXE);
		if (!existsSync(from)) continue;
		if (existsSync(to) && statSync(to).size === statSync(from).size) continue;
		try {
			copyFileSync(from, to);
			if (!WIN) chmodSync(to, 0o755);
			done.push(t.name);
		} catch {
			// in use by another ferry window: the copy already there works
		}
	}
	return done;
}

function findFile(dir, name) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isFile() && e.name === name) return p;
		if (e.isDirectory()) {
			const hit = findFile(p, name);
			if (hit) return hit;
		}
	}
	return null;
}

/** Download the missing tools from GitHub (through the proxy, if one is set). Returns { ok: [...], failed: [...] }. */
export async function downloadMissing() {
	const p = platformKey();
	const result = { ok: [], failed: [] };
	if (!p) return result;
	mkdirSync(BIN_DIR, { recursive: true });
	for (const t of TOOLS) {
		if (existsSync(join(BIN_DIR, t.name + EXE))) continue;
		const tmp = mkdtempSync(join(tmpdir(), `ferry-${t.name}-`));
		try {
			const res = await fetch(t.url(p.asset), { signal: AbortSignal.timeout(120000) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const archive = join(tmp, p.asset);
			writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
			const x = spawnSync(WIN ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar",
				[p.asset.endsWith(".zip") ? "-xf" : "-xzf", archive, "-C", tmp], { stdio: "pipe", windowsHide: true });
			if (x.status !== 0) throw new Error(`could not unpack: ${x.stderr?.toString().trim() || x.error?.message}`);
			const bin = findFile(tmp, t.name + EXE);
			if (!bin) throw new Error("program not found in the download");
			copyFileSync(bin, join(BIN_DIR, t.name + EXE));
			if (!WIN) chmodSync(join(BIN_DIR, t.name + EXE), 0o755);
			result.ok.push(t.name);
		} catch (e) {
			result.failed.push(`${t.name} (${e.cause?.code ?? e.message})`);
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}
	return result;
}
