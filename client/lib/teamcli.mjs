// `ferry team`: set up Ferry members in a Paperclip team from the command line.
// Everything here can also be done in Paperclip's web page; this only saves the clicking and gets the settings right
// (the pi adapter, the legacy runner so the command is honoured, ferry as the command, a Ferry model).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { readModelsCache } from "./config.mjs";

const ROLES = ["ceo", "cto", "cmo", "cfo", "security", "engineer", "designer", "pm", "qa", "devops", "researcher", "general"];

function parse(args) {
	const opts = {};
	const pos = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a.startsWith("--")) {
			const [k, v] = a.slice(2).split("=", 2);
			opts[k] = v ?? (args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true);
		} else pos.push(a);
	}
	return { opts, pos };
}

/** The ferry command Paperclip should start: on PATH (ferry.cmd on Windows), or --command. */
export function findFerry(env = process.env, platform = process.platform) {
	const names = platform === "win32" ? ["ferry.cmd", "ferry.exe", "ferry.bat"] : ["ferry"];
	for (const dir of String(env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter)) {
		for (const n of names) {
			const f = join(dir, n);
			if (dir && existsSync(f)) return f;
		}
	}
	return "";
}

export function teamCli(args, { ferry } = {}) {
	return run(args).catch((e) => {
		console.error(`ferry team: ${e.message}`);
		process.exitCode = 1;
	});
}

// ferry team init: the lead splits the goal and hands parts to the others; everyone writes into the project folder
const DEFAULT_TEAM = [
	["Lead", { role: "ceo", title: "负责人", about: "把目标拆成几步，用 team 工具把调研、分析、写作派给 Researcher、Analyst、Writer（create 时 wait: true），" +
		"等他们做完再检查结果、补漏，最后汇总成交付物，写明放在哪。自己不做大段调研。" }],
	["Researcher", { role: "researcher", title: "调研", about: "查资料、找数据和来源，结果写成 research/ 下的 Markdown，每条写明出处；做完把任务标为 done，留言说明文件在哪。" }],
	["Analyst", { role: "general", title: "方案分析", about: "根据 research/ 里的资料比较方案的利弊、风险和成本，写 analysis.md；有缺的资料就给 Researcher 建任务。" }],
	["Writer", { role: "general", title: "汇报撰写", about: "根据 research/ 和 analysis.md 写汇报：Word 或 PPT（用 office 工具），放在 deliverables/ 下；写完标为 done。" }],
];

export const PAPERCLIP_VERSION = "2026.1023.0"; // the version Ferry was tested with; --version latest for the newest
// Paperclip's statistics and announcements fetched from the internet: off, this is a work computer
export const QUIET_ENV = { PAPERCLIP_TELEMETRY_DISABLED: "1", DO_NOT_TRACK: "1", PAPERCLIP_ANNOUNCEMENTS_ENABLED: "false" };

/** Node.js new enough for Paperclip (24.11 or later)? */
export function nodeOk(version = process.version) {
	const [maj, min] = version.replace(/^v/, "").split(".").map(Number);
	return maj > 24 || (maj === 24 && min >= 11);
}

/** `ferry team start`: Paperclip on this computer, set up the first time, in this window (Ctrl+C stops it). */
function start(opts) {
	if (!nodeOk()) {
		console.error(`Paperclip needs Node.js 24.11 or newer; this is ${process.version}. Install the current Node.js LTS ` +
			"(https://nodejs.org, or your company's software center), then run ferry team start again. Ferry works on it too.");
		process.exitCode = 1;
		return;
	}
	const version = String(opts.version ?? PAPERCLIP_VERSION);
	const configured = existsSync(join(homedir(), ".paperclip", "instances", "default", "config.json"));
	const args = ["-y", `paperclipai@${version}`, ...(configured ? ["run"] : ["onboard", "--yes"])];
	console.log(configured ? "Starting Paperclip (the team board) at http://127.0.0.1:3100 . Keep this window open; Ctrl+C stops it."
		: "Setting up Paperclip the first time (downloads it from npm, about a minute), then starting it at http://127.0.0.1:3100 .");
	const child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", args, {
		stdio: "inherit", env: { ...process.env, ...QUIET_ENV }, shell: process.platform === "win32" });
	return new Promise((done) => child.on("exit", (code) => {
		process.exitCode = code ?? 0;
		done();
	}));
}

async function run(args) {
	const [sub = "", ...more] = args;
	const { opts, pos } = parse(more);
	if (sub === "start") return start(opts);
	const base = String(opts.url ?? process.env.PAPERCLIP_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
	const api = async (method, path, body) => {
		let res;
		try {
			res = await fetch(`${base}/api${path}`, { method, headers: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
		} catch (e) {
			throw new Error(`cannot reach Paperclip at ${base} (${e.cause?.code ?? e.message}). Start it first: npx paperclipai run`);
		}
		const text = await res.text();
		let json = null;
		try {
			json = JSON.parse(text);
		} catch {
			// not JSON
		}
		if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${json?.error ?? text.slice(0, 300)}`);
		return json;
	};
	const list = (x) => (Array.isArray(x) ? x : x?.items ?? x?.data ?? []);
	const company = async (create = false) => {
		const all = list(await api("GET", "/companies"));
		if (opts.company) {
			const c = all.find((x) => x.id === opts.company || x.name?.toLowerCase() === String(opts.company).toLowerCase());
			if (c) return c;
			if (!create) throw new Error(`no company "${opts.company}". Companies: ${all.map((x) => x.name).join(", ") || "none"}`);
			return api("POST", "/companies", { name: String(opts.company) });
		}
		if (all.length === 1) return all[0];
		if (all.length > 1) throw new Error(`several companies (${all.map((x) => x.name).join(", ")}): say which with --company`);
		if (!create) throw new Error("no company yet: add a member first (ferry team add), or create one in the Paperclip page");
		const name = basename(process.cwd()) || "My team";
		console.log(`No company yet: creating "${name}".`);
		return api("POST", "/companies", { name });
	};
	const agentsOf = async (c) => list(await api("GET", `/companies/${c.id}/agents`));
	const byName = (agents, n) => agents.find((a) => [a.id, a.name, a.urlKey].some((v) => v && String(v).toLowerCase() === String(n).toLowerCase()));

	if (sub === "init") { // a ready-made team: a lead and three members
		for (const [name, o] of DEFAULT_TEAM) {
			const c = await company(true);
			if (byName(await agentsOf(c), name)) {
				console.log(`${name} is on the team already.`);
				continue;
			}
			await add(name, { ...opts, ...o });
		}
		console.log(`\nThe team is ready. Give the lead a goal:\n  ferry team goal "调研三种方案，比较利弊，写一份汇报 PPT"\nthen watch it at ${base}`);
		return;
	}
	if (sub === "goal") { // a task for the lead, who splits it up
		const title = pos.join(" ").trim();
		if (!title) throw new Error('usage: ferry team goal "<what should be done>"');
		const c = await company();
		const lead = (await agentsOf(c)).find((a) => a.role === "ceo");
		if (!lead) throw new Error("the team has no lead yet: ferry team init");
		const t = await api("POST", `/companies/${c.id}/issues`, { title, description: opts.text ? String(opts.text) : "",
			status: "todo", assigneeAgentId: lead.id });
		console.log(`${t.identifier ?? t.id}: "${title}" for ${lead.name}. Follow it at ${base}`);
		return;
	}
	if (sub === "add") return add(pos[0], opts);

	async function add(name, opts) {
		if (!name) throw new Error('usage: ferry team add <name> [--title "..."] [--about "..."] [--boss <name>] ...');
		const c = await company(true);
		const agents = await agentsOf(c);
		if (byName(agents, name)) throw new Error(`${name} is already on the team`);
		const command = String(opts.command ?? findFerry());
		if (!command) throw new Error("ferry is not on PATH (run ferry install), or give the full path with --command");
		const model = String(opts.model ?? `ferry/${(readModelsCache() ?? [{ id: "auto" }])[0].id}`);
		const role = ROLES.includes(String(opts.role)) ? String(opts.role) : agents.length ? "general" : "ceo";
		const boss = opts.boss ? byName(agents, opts.boss) : role === "ceo" ? null : agents.find((a) => a.role === "ceo");
		if (opts.boss && !boss) throw new Error(`no member called ${opts.boss}`);
		const folder = resolve(String(opts.folder ?? process.cwd()));
		const instructions = opts.instructions ? readFileSync(String(opts.instructions), "utf8")
			: opts.about ? `# ${name}\n\n${opts.about}\n` : "";
		const a = await api("POST", `/companies/${c.id}/agents`, {
			name, role, title: opts.title ? String(opts.title) : null, capabilities: opts.about ? String(opts.about) : null,
			reportsTo: boss?.id ?? null,
			adapterType: "pi_local", runner: "legacy",
			adapterConfig: { command, model, cwd: folder, timeoutSec: 0, graceSec: 20 },
			...(instructions ? { instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": instructions } } } : {}),
		});
		console.log(`Added ${a.name} (${role}${boss ? `, reports to ${boss.name}` : ""}) to ${c.name}.
  runs:   ${command} with model ${model}
  folder: ${folder}
Paperclip checks the new member once (a short "hello" through your Ferry server). See it at ${base}`);
	}
	if (sub === "task") {
		const title = pos[0];
		if (!title || !opts.to) throw new Error('usage: ferry team task "<title>" --to <name> [--text "..."]');
		const c = await company();
		const who = byName(await agentsOf(c), opts.to);
		if (!who) throw new Error(`no member called ${opts.to}`);
		const t = await api("POST", `/companies/${c.id}/issues`, { title, description: opts.text ? String(opts.text) : "",
			status: "todo", assigneeAgentId: who.id });
		console.log(`${t.identifier ?? t.id}: "${title}" for ${who.name}. Follow it at ${base}`);
		return;
	}
	if (sub === "status" || sub === "") {
		let c;
		try {
			c = await company();
		} catch (e) {
			if (sub === "status") throw e;
			console.log(`${usage(base)}\n\n(${e.message})`);
			return;
		}
		const agents = await agentsOf(c);
		const issues = list(await api("GET", `/companies/${c.id}/issues`).catch(() => []));
		const open = issues.filter((i) => !["done", "cancelled"].includes(i.status));
		console.log(`${c.name}  (${base})\n\nMembers:`);
		for (const a of agents) {
			const mine = open.filter((i) => i.assigneeAgentId === a.id);
			console.log(`  ${a.name.padEnd(16)} ${String(a.status).padEnd(8)} ${a.adapterType === "pi_local" && /ferry/i.test(a.adapterConfig?.command ?? "") ? "ferry" : a.adapterType}` +
				`  ${mine.length ? `${mine.length} open: ${mine.slice(0, 3).map((i) => i.identifier ?? i.title).join(", ")}` : ""}`);
		}
		console.log(`\nOpen tasks: ${open.length}${sub === "" ? `\n\n${usage(base)}` : ""}`);
		return;
	}
	console.log(usage(base));
}

const usage = (base) => `Ferry in a Paperclip team (Paperclip: ${base}; docs/TEAM.md)
  ferry team start                        start Paperclip (the team board) on this computer; the first time it sets it up
  ferry team init                         a ready-made team here: Lead, Researcher, Analyst, Writer
  ferry team goal "<what to do>"          give the lead a goal; the lead splits it up and hands parts out
  ferry team status                       the members and their open tasks
  ferry team add <name> [options]         add a member that runs Ferry
      --title "Researcher"  --about "what this member does"  --role researcher|pm|...|general (first one: ceo)
      --boss <name>  --folder <dir> (default: here)  --instructions <file.md>  --model ferry/<id>  --company <name>
  ferry team task "<title>" --to <name> [--text "..."]   give a member a task (e.g. the goal, to the lead)
  --url <address> if Paperclip is not on ${base}`;
