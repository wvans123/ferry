// Memory that lasts across conversations, kept on this computer (like Claude Code's auto memory).
//
//   <FERRY_HOME>/memory/user/                    follows you into every project (your preferences, your corrections)
//   <FERRY_HOME>/memory/projects/<name>-<hash>/  one folder per project folder (decisions, conventions, where things are)
//
// A third scope, global, lives on the Ferry server when its admin page has global memory on: shared by every
// computer you log in from (your preferences, your terms). The two folders above stay on this computer.
//
// Each folder has MEMORY.md, an index with one line per memory, and one Markdown file per memory.
// Only the two indexes go into the system prompt; the model reads a memory when its line looks relevant.
// The model writes memories with the `memory` tool, which can touch nothing outside these folders.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { FERRY_HOME, serverHeaders } from "./config.mjs";

export const MEMORY_ROOT = join(FERRY_HOME, "memory");
const INDEX = "MEMORY.md";
const INDEX_MAX_LINES = 200; // like Claude Code: only the start of a long index is loaded
const INDEX_MAX_BYTES = 16 * 1024;
const MEMORY_MAX_BYTES = 16 * 1024;

export function projectDir(cwd) {
	const name = basename(cwd).replace(/[^\w.-]+/g, "_").slice(0, 40) || "root";
	const hash = createHash("sha256").update(cwd.toLowerCase()).digest("hex").slice(0, 8);
	return join(MEMORY_ROOT, "projects", `${name}-${hash}`);
}

/** In a Paperclip team, each member also has a memory of its own (the project memory is the team's shared one). */
const teamMember = () => (process.env.PAPERCLIP_AGENT_ID ?? "").replace(/[^\w-]+/g, "").slice(0, 64);

export function scopeDir(scope, cwd) {
	if (scope === "role" && teamMember()) return join(projectDir(cwd), "roles", teamMember());
	return scope === "user" ? join(MEMORY_ROOT, "user") : projectDir(cwd);
}

const slug = (s) => String(s ?? "").trim().toLowerCase().replace(/\.md$/, "").replace(/[^\p{L}\p{N}_-]+/gu, "-")
	.replace(/^-+|-+$/g, "").slice(0, 60);

function readIndex(dir) {
	try {
		return readFileSync(join(dir, INDEX), "utf8");
	} catch {
		return "";
	}
}

/** The index as the model sees it: at most 200 lines and 16 KB. */
export function loadIndex(dir) {
	let text = readIndex(dir).trim();
	if (!text) return "";
	const lines = text.split(/\r?\n/);
	if (lines.length > INDEX_MAX_LINES) text = `${lines.slice(0, INDEX_MAX_LINES).join("\n")}\n(index cut at ${INDEX_MAX_LINES} lines)`;
	if (Buffer.byteLength(text) > INDEX_MAX_BYTES) text = `${text.slice(0, INDEX_MAX_BYTES)}\n(index cut at 16 KB)`;
	return text;
}

function writeIndexLine(dir, name, description) {
	const line = `- [${name}](${name}.md): ${description.replace(/\s+/g, " ").trim()}`;
	const lines = readIndex(dir).split(/\r?\n/).filter((l) => l.trim());
	const at = lines.findIndex((l) => l.startsWith(`- [${name}](`));
	if (at >= 0) lines[at] = line;
	else lines.push(line);
	writeFileSync(join(dir, INDEX), `${lines.join("\n")}\n`, "utf8");
}

function dropIndexLine(dir, name) {
	const lines = readIndex(dir).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith(`- [${name}](`));
	writeFileSync(join(dir, INDEX), lines.length ? `${lines.join("\n")}\n` : "", "utf8");
}

const GUIDE = `You have a memory that lasts across conversations. It is stored on the user's computer as Markdown files.
There are two scopes:
- user: about the user, in every project: their role, preferences, how they want you to work, corrections they gave you.
- project: about this project folder: decisions and their reasons, conventions, where things live, known pitfalls.

Only the index of each scope is shown below. When an index line looks relevant to the task, read that memory with
the memory tool (action "read") before relying on it.

Save a memory (action "save") when:
- the user asks you to remember something, or corrects how you work ("don't do X", "always Y");
- you learn a fact about the user or the project that will matter in later conversations and is not written in the
  code, the git history or the project's AGENTS.md;
- you worked something out with real effort (a non-obvious build step, the cause of a confusing failure).
Do not save: things anyone can read from the code, temporary details of the current task, secrets, passwords, keys,
or personal data about other people. Keep each memory short and specific. Update an existing memory (same name)
instead of adding a near-duplicate, and delete memories that turn out to be wrong. When the user asks you to forget
something, delete it.

Memories can be out of date. If one disagrees with the code or with what the user says now, trust the code and the
user, and fix the memory. Rules in AGENTS.md and the user's current instructions take priority over memories.`;

// ---------- global scope: on the Ferry server ----------

const global = { enabled: false, index: "", at: 0 };
const GLOBAL_TTL = 5 * 60_000;

async function serverJson(cfg, method, path, body) {
	const res = await fetch(`${cfg.server}${path}`, { method, redirect: "manual", signal: AbortSignal.timeout(8000),
		headers: serverHeaders(cfg, body ? { "Content-Type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined });
	const json = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
	if (!res.ok || !json) throw new Error(json?.error?.message ?? `the Ferry server answered HTTP ${res.status}`);
	return json;
}

/** Whether the server keeps a global memory, and its index; looked up at most every 5 minutes. */
export async function refreshGlobal(cfg, force = false) {
	if (!cfg?.server || cfg.globalMemory === false) return global;
	if (!force && Date.now() - global.at < GLOBAL_TTL) return global;
	try {
		const r = await serverJson(cfg, "GET", "/v1/ferry/memory");
		global.enabled = Boolean(r.enabled);
		global.index = String(r.index ?? "");
	} catch {
		// an older server, or not reachable right now: keep what we had
	}
	global.at = Date.now();
	return global;
}

async function runGlobal(cfg, params) {
	const name = slug(params.name);
	const text = (t) => ({ content: [{ type: "text", text: t }], details: { action: params.action, scope: "global", name } });
	const g = await refreshGlobal(cfg, true);
	if (!g.enabled) throw new Error("Global memory is off on the Ferry server (its admin page: 设备和手机). Use the user scope instead.");
	if (params.action === "list" || (params.action === "read" && !name)) return text(g.index || "(no global memories yet)");
	if (!name) throw new Error("name is required");
	const path = `/v1/ferry/memory/${encodeURIComponent(name)}`;
	if (params.action === "read") return text((await serverJson(cfg, "GET", path)).content);
	if (params.action === "delete") {
		await serverJson(cfg, "DELETE", path);
		await refreshGlobal(cfg, true);
		return text(`Deleted global memory "${name}".`);
	}
	if (params.action === "save") {
		const content = String(params.content ?? "").trim();
		if (!content) throw new Error("content is required");
		const r = await serverJson(cfg, "PUT", path, { description: String(params.description ?? "").trim(), content });
		await refreshGlobal(cfg, true);
		return text(`Saved global memory "${r.name}" (on the Ferry server, for all your computers).`);
	}
	throw new Error(`unknown action ${params.action}`);
}

const GLOBAL_GUIDE = `
There is also a global scope, kept on the user's Ferry server and shared by every computer they use Ferry on. Use it
only for things about the user that should follow them everywhere (preferences, how they want you to work, terms
they use). Never put content from their work there (code, documents, company or project details, names of people):
that belongs in the project scope, which stays on this computer. When a memory fits both user and global, prefer global.`;

/** The system prompt section: what memory is, plus the indexes. */
export function memorySection(cwd, g = global) {
	const user = loadIndex(scopeDir("user", cwd));
	const project = loadIndex(scopeDir("project", cwd));
	const team = teamMember() ? `

You are one member of a team. The project memory is shared by the whole team: save there what every member should
know. A third scope, role, is yours alone: how you do your part of the work, what you learned doing it.

Your own (role) memory index:
${loadIndex(scopeDir("role", cwd)) || "(empty)"}` : "";
	const glob = g.enabled ? `${GLOBAL_GUIDE}

Global memory index (on the Ferry server, all computers):
${g.index || "(empty)"}
` : "";
	return `${GUIDE}
${glob}
User memory index (this computer):
${user || "(empty)"}

Project memory index (${basename(cwd)}):
${project || "(empty)"}${team}`;
}

const Params = Type.Object({
	action: StringEnum(["save", "read", "delete", "list"], {
		description: "save: create or replace a memory; read: show one memory (or the index without name); delete; list: both indexes",
	}),
	scope: Type.Optional(StringEnum(["user", "project", "role", "global"], {
		description: "user: every project on this computer; project: this folder only (in a team: shared by all members); " +
			"role: yours alone, only in a team; global: on the Ferry server, every computer of the user (only if it is on). Default project." })),
	name: Type.Optional(Type.String({ description: "Short file name, e.g. test-database or prefers-chinese-replies" })),
	description: Type.Optional(Type.String({ description: "save: one line for the index, saying when this memory is useful" })),
	content: Type.Optional(Type.String({ description: "save: the memory itself, in Markdown. Keep it short." })),
});

function runMemory(params, cwd) {
	const scope = params.scope === "user" ? "user" : params.scope === "role" && teamMember() ? "role" : "project";
	const dir = scopeDir(scope, cwd);
	const name = slug(params.name);
	const text = (t) => ({ content: [{ type: "text", text: t }], details: { action: params.action, scope, name } });

	if (params.action === "list") {
		return text(`User memory:\n${loadIndex(scopeDir("user", cwd)) || "(empty)"}\n\nProject memory:\n${loadIndex(scopeDir("project", cwd)) || "(empty)"}` +
			(teamMember() ? `\n\nYour own (role) memory:\n${loadIndex(scopeDir("role", cwd)) || "(empty)"}` : ""));
	}
	if (params.action === "read") {
		if (!name) return text(loadIndex(dir) || `(no ${scope} memories yet)`);
		const file = join(dir, `${name}.md`);
		if (!existsSync(file)) throw new Error(`No ${scope} memory named "${name}". Index:\n${loadIndex(dir) || "(empty)"}`);
		return text(readFileSync(file, "utf8"));
	}
	if (!name) throw new Error("name is required");
	if (params.action === "delete") {
		rmSync(join(dir, `${name}.md`), { force: true });
		dropIndexLine(dir, name);
		return text(`Deleted ${scope} memory "${name}".`);
	}
	if (params.action === "save") {
		const content = String(params.content ?? "").trim();
		const description = String(params.description ?? "").trim() || content.split("\n")[0].slice(0, 120);
		if (!content) throw new Error("content is required");
		if (Buffer.byteLength(content) > MEMORY_MAX_BYTES) throw new Error("A memory must be under 16 KB: keep only what matters later");
		mkdirSync(dir, { recursive: true });
		if (scope === "project") writeFileSync(join(dir, ".folder"), cwd, "utf8"); // which folder this is, for people
		writeFileSync(join(dir, `${name}.md`), `${content}\n`, "utf8");
		writeIndexLine(dir, name, description);
		return text(`Saved ${scope} memory "${name}".`);
	}
	throw new Error(`unknown action ${params.action}`);
}

/** Text for /memory: where the files are and what is in the indexes. */
export function describeMemory(cwd) {
	const u = scopeDir("user", cwd);
	const p = scopeDir("project", cwd);
	const count = (d) => (existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md") && f !== INDEX).length : 0);
	return [
		`User memory (${count(u)}): ${u}`,
		loadIndex(u) || "  (empty)",
		"",
		`Project memory (${count(p)}): ${p}`,
		loadIndex(p) || "  (empty)",
		"",
		"They are plain Markdown files: edit or delete them in any editor. Ask the agent to remember or forget something,",
		'or turn memory off with: ferry config set memory false',
	].join("\n");
}

const tell = (ctx, text) => (ctx.hasUI ? ctx.ui.notify(text, "info") : process.stdout.write(`${text}\n`));

export function createMemory(cfg) {
	return (pi) => {
		if (cfg.memory === false) return;
		pi.registerTool({
			name: "memory",
			label: "Memory",
			description: "Read and write your memory that lasts across conversations (user scope and project scope). " +
				"Only the indexes are in your instructions; read a memory before relying on it.",
			promptSnippet: "Save, read and delete memories that last across conversations",
			parameters: Params,
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
			async execute(_id, params, _signal, _onUpdate, ctx) {
				if (params.scope === "global") return runGlobal(cfg, params);
				const r = runMemory(params, ctx?.cwd ?? process.cwd());
				if (params.action === "list" && global.enabled) {
					r.content[0].text += `\n\nGlobal memory (Ferry server):\n${global.index || "(empty)"}`;
				}
				return r;
			},
		});
		pi.on("before_agent_start", async (event, ctx) => {
			await refreshGlobal(cfg);
			event.systemPromptOptions.sections.ferry_memory = memorySection(ctx?.cwd ?? process.cwd());
		});
		pi.registerCommand("memory", {
			description: "Show what Ferry remembers; /memory <text> saves a note (for this project; /memory user <text>: all projects here; /memory global <text>: all your computers)",
			handler: async (args, ctx) => {
				const cwd = ctx.cwd ?? process.cwd();
				let text = String(args ?? "").trim();
				if (!text) {
					const g = await refreshGlobal(cfg, true);
					return tell(ctx, describeMemory(cwd) + (g.enabled ? `\n\nGlobal memory (on the Ferry server, all your computers; /memory global <text> saves one):\n${g.index || "  (empty)"}` : ""), "info");
				}
				let scope = "project";
				if (/^(user|global)\s+/i.test(text)) {
					scope = /^global/i.test(text) ? "global" : "user";
					text = text.replace(/^\S+\s+/, "");
				}
				const name = slug(text.split(/\s+/).slice(0, 6).join("-")) || `note-${Date.now()}`;
				const params = { action: "save", scope, name, description: text.slice(0, 120), content: text };
				try {
					const r = scope === "global" ? await runGlobal(cfg, params) : runMemory(params, cwd);
					tell(ctx, r.content[0].text, "info");
				} catch (e) {
					tell(ctx, e.message, "info");
				}
			},
		});
	};
}

export { runMemory as _runMemory, runGlobal as _runGlobal };
