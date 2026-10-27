// Slash commands and do-it-yourself resources.
//
// Built in, like Claude Code's basic commands: /help /clear /exit /rename /cost /context /doctor /config /skills
// /add-dir /status /agents; Markdown templates in client/commands/: /init /review /security-review
// Your own, as Markdown files (the file name is the command; $ARGUMENTS, $1, ${1:-default} take what you type after it):
//   <FERRY_HOME>/commands/*.md          everywhere
//   <project>/.ferry/commands/*.md      in that project (also Claude Code's .claude/commands/)
// Skills (folders with a SKILL.md; the model loads them when the task fits, or you call /skill:name):
//   <FERRY_HOME>/skills/   <project>/.ferry/skills/   <project>/.claude/skills/
// Also here: /status, /agents, and a desktop notification when a long request finishes.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FERRY_HOME, SETTINGS, loadConfig, saveConfig } from "./config.mjs";
import { MODE_LABEL } from "./permissions.mjs";

const HELP = `Ferry commands (type / to pick one; Tab completes)

Conversation   /clear  start over         /compact [what to keep]  shrink the context
               /resume pick a conversation   /rename <name>   /fork   /tree   /export   /copy   /exit
Work           /goal <objective>  keep working until it is done (/goal pause|resume|clear|budget)
               /plan <task>  read-only plan first      /tasks  background commands and subtasks
               /todos  the task list                   /rewind  put files back as before a request
Knowledge      /init  write AGENTS.md for this folder   /memory   /remember <text>   /skills
Review         /review [what]   /security-review [what]
Information    /cost  tokens and money    /context  what fills the context    /status   /doctor
Settings       /config   /permissions   /hooks   /agents   /mcp   /model   /settings   /add-dir <folder>
Keys           Shift+Tab permission mode · Esc interrupt · @ attach a file · !cmd run a command yourself
               Ctrl+C twice to quit
Your own commands: Markdown files in .ferry/commands/ or ${join(FERRY_HOME, "commands")} (docs/CUSTOMIZE.md)`;

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)));

/** Token and cost totals of a conversation, from its messages (subagents and background tasks included). */
export function usageOf(entries) {
	const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, calls: 0 };
	for (const e of entries) {
		const m = e.type === "message" ? e.message : null;
		const u = m?.usage;
		if (!u || !(m.role === "assistant" || m.role === "toolResult")) continue;
		t.input += u.input ?? 0;
		t.output += u.output ?? 0;
		t.cacheRead += u.cacheRead ?? 0;
		t.cacheWrite += u.cacheWrite ?? 0;
		t.cost += u.cost?.total ?? 0;
		if (m.role === "assistant") t.calls++;
	}
	return t;
}

function bar(parts, total, width = 40) {
	const marks = ["#", "=", "-", "+"];
	let out = "";
	parts.forEach(([, n], i) => {
		out += marks[i % marks.length].repeat(Math.round((n / total) * width));
	});
	return `[${out.padEnd(width, ".").slice(0, width)}]`;
}

export const BUILTIN_COMMANDS = join(dirname(fileURLToPath(import.meta.url)), "..", "commands");

const mdFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f)) : []);

/** Prompt files: built-in first, then yours, then the project's; a later file with the same name replaces an earlier one. */
export function commandFiles(cwd) {
	const byName = new Map();
	for (const dir of [BUILTIN_COMMANDS, join(FERRY_HOME, "commands"), join(cwd, ".claude", "commands"), join(cwd, ".ferry", "commands")]) {
		for (const f of mdFiles(dir)) byName.set(f.split(/[\\/]/).pop().toLowerCase(), f);
	}
	return [...byName.values()];
}

export function skillDirs(cwd) {
	return [join(FERRY_HOME, "skills"), join(cwd, ".claude", "skills"), join(cwd, ".ferry", "skills")].filter((d) => existsSync(d));
}

function notifyDone(seconds) {
	process.stdout.write("\x07"); // the terminal flashes or beeps (Windows Terminal: the taskbar button)
	if (process.platform === "win32" && process.env.WT_SESSION) {
		const t = "Windows.UI.Notifications";
		const body = `Finished after ${Math.round(seconds)} s`;
		const ps = `[${t}.ToastNotificationManager, ${t}, ContentType = WindowsRuntime] > $null; ` +
			`$x = [${t}.ToastNotificationManager]::GetTemplateContent([${t}.ToastTemplateType]::ToastText01); ` +
			`$x.GetElementsByTagName('text')[0].AppendChild($x.CreateTextNode('${body}')) > $null; ` +
			`[${t}.ToastNotificationManager]::CreateToastNotifier('Ferry').Show([${t}.ToastNotification]::new($x))`;
		execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true }, () => {});
	}
}

/**
 * deps: { status(): lines about the server and model, mode(): current permission mode, agents(cwd),
 *         doctor(): text of `ferry doctor`, addDir(path): allow a folder outside the project, price: model prices }
 */
export function createCommands(cfg, deps) {
	return (pi) => {
		pi.on("resources_discover", (event) => ({
			promptPaths: commandFiles(event.cwd ?? process.cwd()),
			skillPaths: skillDirs(event.cwd ?? process.cwd()),
		}));

		let started = 0;
		pi.on("before_agent_start", (event) => {
			if (event.messageType === "user") started = Date.now();
		});
		pi.on("agent_settled", (_e, ctx) => {
			const secs = (Date.now() - started) / 1000;
			if (ctx?.hasUI && started && cfg.notify !== false && secs >= (cfg.notifyAfterSeconds ?? 30)) notifyDone(secs);
			started = 0;
		});

		pi.registerCommand("status", {
			description: "Ferry status: server, model, permission mode, web, memory, tools",
			handler: async (_a, ctx) => {
				const lines = await deps.status();
				const tools = pi.getActiveTools();
				lines.push(`Permission mode: ${MODE_LABEL[deps.mode()]} (Shift+Tab, /permissions)`);
				lines.push(`Tools: ${tools.join(", ")}`);
				const usage = ctx.getContextUsage?.();
				if (usage?.tokens) lines.push(`Context: ${usage.tokens.toLocaleString()} of ${usage.contextWindow?.toLocaleString() ?? "?"} tokens`);
				lines.push(`Commands: ${commandFiles(ctx.cwd ?? process.cwd()).map((f) => `/${f.split(/[\\/]/).pop().replace(/\.md$/, "")}`).join(" ")}`);
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});

		pi.registerCommand("help", {
			description: "List Ferry's commands and keys",
			handler: async (_a, ctx) => ctx.ui.notify(HELP, "info"),
		});
		pi.registerCommand("clear", {
			description: "Start a new conversation (the old one stays in /resume)",
			handler: async (_a, ctx) => {
				await ctx.newSession();
			},
		});
		pi.registerCommand("exit", { description: "Quit Ferry", handler: async (_a, ctx) => ctx.shutdown() });
		pi.registerCommand("rename", {
			description: "Name this conversation (shown in /resume)",
			handler: async (args, ctx) => {
				const name = String(args ?? "").trim();
				if (!name) return ctx.ui.notify("Usage: /rename <name>", "warning");
				pi.setSessionName(name);
				ctx.ui.notify(`Renamed to: ${name}`, "info");
			},
		});

		pi.registerCommand("cost", {
			description: "Tokens and money spent in this conversation",
			handler: async (_a, ctx) => {
				const u = usageOf(ctx.sessionManager.getBranch());
				const total = u.input + u.cacheRead + u.cacheWrite;
				const lines = [
					`Model calls: ${u.calls}`,
					`Input: ${fmt(total)} tokens (${fmt(u.cacheRead)} from the cache${total ? `, ${Math.round((u.cacheRead / total) * 100)}%` : ""}${u.cacheWrite ? `, ${fmt(u.cacheWrite)} written to it` : ""})`,
					`Output: ${fmt(u.output)} tokens`,
					u.cost > 0 ? `Cost: $${u.cost.toFixed(u.cost < 1 ? 4 : 2)}` : "Cost: unknown (set the model's prices in the server's admin page)",
					"All conversations, by day, project and model: the server's admin page > 用量",
				];
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});

		pi.registerCommand("context", {
			description: "How full the context is, and with what",
			handler: async (_a, ctx) => {
				const usage = ctx.getContextUsage?.();
				const windowSize = usage?.contextWindow ?? 128000;
				const sys = Math.round((ctx.getSystemPrompt?.() ?? "").length / 4);
				const tools = Math.round(JSON.stringify(pi.getAllTools().filter((t) => pi.getActiveTools().includes(t.name))
					.map((t) => [t.name, t.description, t.parameters])).length / 4);
				const used = usage?.tokens ?? sys + tools;
				const conv = Math.max(0, used - sys - tools);
				const parts = [["system prompt (rules, memory index, AGENTS.md)", sys], ["tool definitions", tools], ["conversation", conv]];
				const lines = [
					`${bar(parts, windowSize)} ${fmt(used)} of ${fmt(windowSize)} tokens (${Math.round((used / windowSize) * 100)}%)`,
					...parts.map(([name, n], i) => `  ${["#", "=", "-"][i]} ${name}: ${fmt(n)}`),
					`  . free: ${fmt(Math.max(0, windowSize - used))}`,
					"When it gets full, older parts are summarised automatically; /compact does it now.",
				];
				ctx.ui.notify(lines.join("\n"), "info");
			},
		});

		pi.registerCommand("doctor", {
			description: "Check the setup: server, token, model, search tools",
			handler: async (_a, ctx) => {
				ctx.ui.notify("Checking...", "info");
				ctx.ui.notify(await deps.doctor(), "info");
			},
		});

		pi.registerCommand("config", {
			description: "Show or change Ferry's settings",
			handler: async (args, ctx) => {
				const cfg = loadConfig();
				const keys = Object.keys(SETTINGS);
				const pick = await ctx.ui.select("Ferry settings (pick one to change; most apply the next time you start ferry)",
					[...keys.map((k) => `${k} = ${JSON.stringify(cfg[k])}`), "Done"]);
				const key = pick?.split(" = ")[0];
				if (!key || !SETTINGS[key]) return;
				const [type, why] = SETTINGS[key];
				const raw = await ctx.ui.input(`${key}: ${why}`, Array.isArray(cfg[key]) ? cfg[key].join(",") : String(cfg[key] ?? ""));
				if (raw === undefined) return;
				let value = raw.trim();
				if (type === "boolean") value = /^(true|on|yes|1)$/i.test(value);
				else if (type === "number") value = Number(value) || 0;
				else if (type === "list") value = value ? value.split(",").map((x) => x.trim()).filter(Boolean) : [];
				saveConfig({ [key]: value });
				ctx.ui.notify(`${key} = ${JSON.stringify(value)} (saved; restart ferry if it does not apply right away)`, "info");
			},
		});

		pi.registerCommand("skills", {
			description: "List the skills the agent can use",
			handler: async (_a, ctx) => {
				const skills = ctx.getSystemPromptOptions?.().skills ?? [];
				const list = skills.map((s) => `  ${s.name}: ${String(s.description ?? "").slice(0, 100)}`).join("\n") || "  (none)";
				ctx.ui.notify(`${list}\n\nCall one with /skill:<name>. Add your own as folders with a SKILL.md in .ferry/skills/ ` +
					`or ${join(FERRY_HOME, "skills")} (docs/CUSTOMIZE.md).`, "info");
			},
		});

		pi.registerCommand("add-dir", {
			description: "Let the agent work in another folder too (changes there are treated like the project's)",
			handler: async (args, ctx) => {
				const dir = String(args ?? "").trim().replace(/^["']|["']$/g, "");
				if (!dir || !existsSync(dir)) return ctx.ui.notify("Usage: /add-dir <existing folder>", "warning");
				const abs = deps.addDir(dir);
				pi.sendMessage({ customType: "ferry-add-dir", display: false,
					content: `The user added the folder ${abs} to the workspace. You may read and change files there as in the project folder.` },
				{ deliverAs: "nextTurn" });
				ctx.ui.notify(`Added ${abs} for this session.`, "info");
			},
		});

		pi.registerCommand("agents", {
			description: "List the subagents the task tool can use, and where to add your own",
			handler: async (_a, ctx) => {
				const cwd = ctx.cwd ?? process.cwd();
				const list = deps.agents(cwd).map((a) => `  ${a.name}${a.file ? ` (${a.file})` : " (built in)"}: ${a.description}`).join("\n");
				ctx.ui.notify(`${list}\n\nAdd your own as Markdown in ${join(cwd, ".ferry", "agents")} or ${join(FERRY_HOME, "agents")} ` +
					"(header: name, description, tools).", "info");
			},
		});
	};
}
