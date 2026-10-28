// MCP servers: where Ferry finds them, importing them from other apps, and a project's own servers.
//
//   <FERRY_HOME>/agent/mcp.json     yours, every project (pi reads this file; `ferry mcp add` and `ferry mcp import` write it)
//   <project>/.ferry/mcp.json       the project's, e.g. committed for the team
//   <project>/.mcp.json             the same, in Claude Code's format and place
// A project's servers start programs on this computer, so Ferry asks once before using them (and again when the
// file changes). Inside ferry, /mcp shows every server, whether it is connected, and its tools.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AGENT_DIR } from "./config.mjs";
import { projectKeyDir } from "./permissions.mjs";

export const USER_MCP = () => join(AGENT_DIR, "mcp.json");
export const projectMcpFiles = (cwd) => [join(cwd, ".ferry", "mcp.json"), join(cwd, ".mcp.json")];

/** Other apps' MCP settings that `ferry mcp import` knows: [name, file]. */
export function otherApps() {
	const home = homedir();
	const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
	const claudeDesktop = process.platform === "win32" ? join(appData, "Claude", "claude_desktop_config.json")
		: process.platform === "darwin" ? join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json")
		: join(home, ".config", "Claude", "claude_desktop_config.json");
	const vscode = process.platform === "win32" ? join(appData, "Code", "User", "mcp.json")
		: process.platform === "darwin" ? join(home, "Library", "Application Support", "Code", "User", "mcp.json")
		: join(home, ".config", "Code", "User", "mcp.json");
	return [
		["claude-desktop", claudeDesktop],
		["claude-code", join(home, ".claude.json")],
		["cursor", join(home, ".cursor", "mcp.json")],
		["vscode", vscode],
		["windsurf", join(home, ".codeium", "windsurf", "mcp_config.json")],
	];
}

const strip = (t) => t.replace(/^﻿/, "");

/**
 * The servers in one file: { "mcpServers": {...} } (Claude Desktop, Cursor, pi), { "servers": {...} } (VS Code),
 * or Claude Code's ~/.claude.json (its own servers plus those it keeps for the folder `cwd`).
 */
export function serversIn(file, cwd = process.cwd()) {
	const json = JSON.parse(strip(readFileSync(file, "utf8")));
	const out = { ...(json.mcpServers ?? json.servers ?? {}) };
	if (json.projects && typeof json.projects === "object") { // Claude Code
		const want = resolve(cwd).replace(/\\/g, "/").toLowerCase();
		for (const [path, p] of Object.entries(json.projects)) {
			if (resolve(path).replace(/\\/g, "/").toLowerCase() === want) Object.assign(out, p?.mcpServers ?? {});
		}
	}
	return out;
}

/** One entry in the shape pi accepts, or { skip: why }. */
export function convert(entry) {
	if (!entry || typeof entry !== "object") return { skip: "not an object" };
	const type = entry.type;
	if (type === "sse") return { skip: "uses the old SSE transport; give its streamable HTTP address instead" };
	const keep = ["command", "args", "env", "cwd", "url", "headers", "enabled", "timeout", "description", "exposure", "toolExposure"];
	const out = Object.fromEntries(keep.filter((k) => entry[k] !== undefined).map((k) => [k, entry[k]]));
	if (entry.disabled === true) out.enabled = false; // Cursor, Windsurf
	if (out.url && type && type !== "http" && type !== "streamable-http") return { skip: `unknown type "${type}"` };
	if (!out.command && !out.url) return { skip: "has neither a command nor a url" };
	if (out.env) out.env = Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, String(v)]));
	return { config: out };
}

const cleanName = (n) => String(n).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "server";

function readJson(file) {
	try {
		return JSON.parse(strip(readFileSync(file, "utf8")));
	} catch {
		return {};
	}
}

/**
 * Copy servers into your mcp.json. sources: [[label, file]]. Existing names are kept unless force.
 * Returns { added: [[name, label]], skipped: [[name, why]], file }.
 */
export function importServers(sources, { force = false, cwd = process.cwd() } = {}) {
	const file = USER_MCP();
	const cur = readJson(file);
	const servers = { ...(cur.mcpServers ?? {}) };
	const added = [];
	const skipped = [];
	for (const [label, from] of sources) {
		let found;
		try {
			found = serversIn(from, cwd);
		} catch (e) {
			skipped.push([label, `cannot read ${from}: ${e.message}`]);
			continue;
		}
		for (const [raw, entry] of Object.entries(found)) {
			const name = cleanName(raw);
			const c = convert(entry);
			if (c.skip) skipped.push([name, c.skip]);
			else if (servers[name] && !force) skipped.push([name, "already in your mcp.json (--force replaces it)"]);
			else {
				servers[name] = c.config;
				added.push([name, label]);
			}
		}
	}
	if (added.length) {
		mkdirSync(AGENT_DIR, { recursive: true });
		writeFileSync(file, JSON.stringify({ ...cur, mcpServers: servers }, null, 2), "utf8");
	}
	return { added, skipped, file };
}

const describe = (c) => (c.url ? c.url : [c.command, ...(c.args ?? [])].join(" ")) + (c.enabled === false ? "  (off)" : "");

/** Text for `ferry mcp list`: every server Ferry would use here, by file. */
export function listText(cwd = process.cwd()) {
	const lines = [];
	for (const [label, file] of [["Yours (every project)", USER_MCP()], ...projectMcpFiles(cwd).map((f) => ["This project", f])]) {
		if (!existsSync(file)) {
			if (label.startsWith("Yours")) lines.push(`${label}: ${file}\n  (no file yet)`);
			continue;
		}
		let servers;
		try {
			servers = serversIn(file, cwd);
		} catch (e) {
			lines.push(`${label}: ${file}\n  cannot read it: ${e.message}`);
			continue;
		}
		const names = Object.keys(servers);
		lines.push(`${label}: ${file}`);
		lines.push(...(names.length ? names.map((n) => `  ${n.padEnd(20)} ${describe(servers[n])}`) : ["  (none)"]));
	}
	const apps = otherApps().filter(([, f]) => existsSync(f));
	if (apps.length) lines.push("", `Other apps with MCP settings (ferry mcp import <name> copies them): ${apps.map(([n]) => n).join(", ")}`);
	lines.push("", "Inside ferry, /mcp shows which servers are connected and their tools.");
	return lines.join("\n");
}

/** A project's own servers (.ferry/mcp.json, .mcp.json): used after you allow them once. */
export function createProjectMcp() {
	return (pi) => {
		pi.on("session_start", async (_e, ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			const servers = {};
			const texts = [];
			for (const f of projectMcpFiles(cwd)) {
				if (!existsSync(f)) continue;
				try {
					Object.assign(servers, serversIn(f, cwd));
					texts.push(readFileSync(f, "utf8"));
				} catch (e) {
					if (ctx.hasUI) ctx.ui.notify(`Cannot read ${f}: ${e.message}`, "warning");
				}
			}
			const own = readJson(USER_MCP()).mcpServers ?? {};
			const usable = Object.entries(servers).map(([n, e]) => [cleanName(n), convert(e)])
				.filter(([n, c]) => c.config && !own[n]); // your own file wins over a project's server of the same name
			if (!usable.length) return;
			const hash = createHash("sha256").update(texts.join("\n")).digest("hex");
			const trustFile = join(projectKeyDir(cwd), "mcp-trust.json");
			if (readJson(trustFile).hash !== hash) {
				if (!ctx.hasUI) return;
				const list = usable.map(([n, c]) => `  ${n}: ${describe(c.config)}`).join("\n");
				const ok = await ctx.ui.select(`This project brings MCP servers (programs Ferry starts, or addresses it connects to):\n${list}\n\nUse them?`,
					["Use them (asked again if the file changes)", "Not now"]);
				if (!ok?.startsWith("Use")) return;
				mkdirSync(projectKeyDir(cwd), { recursive: true });
				writeFileSync(trustFile, JSON.stringify({ hash }), "utf8");
			}
			for (const [n, c] of usable) pi.registerMcpServer(n, { ...c.config, ...(c.config.cwd ? {} : c.config.command ? { cwd } : {}) });
		});
	};
}
