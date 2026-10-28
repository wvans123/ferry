// Slash commands and do-it-yourself resources.
//
// Ferry keeps the "/" list short. From pi: /new /resume /name /session /compact /model /quit and /mcp.
// Ferry's own: /help /goal /tasks /rewind /memory /skills /context /cost /status /config (goal, tasks, rewind and memory in their own files).
// Your own commands, as Markdown files (the file name is the command; $ARGUMENTS, $1, ${1:-default} take what
// you type after it):
//   <FERRY_HOME>/commands/*.md          everywhere
//   <project>/.ferry/commands/*.md      in that project (also Claude Code's .claude/commands/)
// Skills (folders with a SKILL.md; the model loads them when the task fits, or you call /skill:name):
//   <FERRY_HOME>/skills/   <project>/.ferry/skills/   <project>/.claude/skills/
// Also here: a desktop notification when a long request finishes.
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FERRY_HOME, SETTINGS, ADVANCED_SETTINGS, loadConfig, parseTokens, saveConfig } from "./config.mjs";
import { MODE_LABEL, ruleFiles } from "./permissions.mjs";

export const HELP = `Ferry commands (type / to pick one; Tab completes)

Conversation   /new  start a new one          /resume  go back to an earlier one
               /name <name>  name this one    /session  file, size and messages of this one
               /compact [what to keep]  summarise the history now, to free up context
               /rewind  go back to one of your messages: conversation, files, or both
Work           /goal <objective>  keep working until it is done (/goal pause | resume | clear | budget)
               /tasks  background commands and subagents: output, stop
Knowledge      /memory  what Ferry remembers;  /memory <text>  remember this (for this project;
               /memory user <text> for all projects)      /skills  what the agent knows how to do
Information    /context [size]  how full the context is; with a size (400k, 1m, auto) change it
               /cost  tokens and money       /status  server, model, settings, and a quick check
Settings       /config  the useful settings   /model  pick a model   /mcp  MCP servers   /quit

Keys           Shift+Tab   permission mode: ask first > auto-edit (file changes go ahead) > plan (read only) > allow all
               Esc  stop the agent        Ctrl+C  clear the input (twice: quit)       Ctrl+D  quit
               Shift+Enter  new line      Ctrl+O  show or hide tool output             Ctrl+T  show or hide thinking
               Ctrl+L  pick a model       Ctrl+G  write the message in your editor     Ctrl+X  copy the last answer
               @file  attach a file       !command  run a command yourself (its output goes to the agent)
Your own commands: Markdown files in .ferry/commands/ or ${join(FERRY_HOME, "commands")} (docs/CUSTOMIZE.md)`;

/** Show text to the user: in the terminal UI as a notice, with -p (print mode) on standard output. */
export function tell(ctx, text, level = "info") {
	if (ctx.hasUI) ctx.ui.notify(text, level);
	else process.stdout.write(`${text}\n`);
}

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

const mdFiles = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f)) : []);

/** Prompt files: yours, then the project's; a later file with the same name replaces an earlier one. */
export function commandFiles(cwd) {
	const byName = new Map();
	for (const dir of [join(FERRY_HOME, "commands"), join(cwd, ".claude", "commands"), join(cwd, ".ferry", "commands")]) {
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
 *         doctor(): text of `ferry doctor --no-model`, reregister(pi): give pi the models again with new sizes }
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

		pi.registerCommand("help", {
			description: "Commands, keys, and the subagents the agent can hand work to",
			handler: async (_a, ctx) => {
				const cwd = ctx.cwd ?? process.cwd();
				const agents = deps.agents(cwd).map((a) => `  ${a.name}: ${a.description.slice(0, 110)}`).join("\n");
				const own = commandFiles(cwd).map((f) => `/${f.split(/[\\/]/).pop().replace(/\.md$/, "")}`);
				tell(ctx, `${HELP}\n${own.length ? `Yours: ${own.join(" ")}\n` : ""}\nSubagents (the agent uses them by itself; ` +
					`add your own in .ferry/agents/):\n${agents}`, "info");
			},
		});

		pi.registerCommand("status", {
			description: "Server, model, permission mode, rules and hooks, and a quick check of the setup",
			handler: async (_a, ctx) => {
				const cwd = ctx.cwd ?? process.cwd();
				const lines = await deps.status();
				const usage = ctx.getContextUsage?.();
				const f = ruleFiles(cwd);
				lines.push(
					`Permission mode: ${MODE_LABEL[deps.mode()]} (Shift+Tab)`,
					`Context: ${usage?.tokens ? `${usage.tokens.toLocaleString()} of ` : ""}${usage?.contextWindow?.toLocaleString() ?? "?"} tokens (/context)`,
					`Tools: ${pi.getActiveTools().join(", ")}`,
					`Permission rules ("always allow" answers; edit to remove): ${f.project}`,
					`  yours for all projects: ${f.user}   the team's: ${f.team}`,
					`Hooks: ${join(FERRY_HOME, "hooks.json")} and .ferry/hooks.json`,
					"",
					"Checking the setup...",
				);
				tell(ctx, lines.join("\n"), "info");
				tell(ctx, await deps.doctor(), "info");
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
					"All conversations, by day, project and model: the server's admin page > 用量和费用",
				];
				tell(ctx, lines.join("\n"), "info");
			},
		});

		pi.registerCommand("context", {
			description: "How full the context is; /context 400k (or 1m, auto) changes its size for this model",
			getArgumentCompletions: (prefix) => ["auto", "128k", "200k", "400k", "1m"].filter((x) => x.startsWith(prefix.trim()))
				.map((x) => ({ value: x, label: x })),
			handler: async (args, ctx) => {
				const want = String(args ?? "").trim().toLowerCase();
				if (want) return setContext(want, ctx);
				const usage = ctx.getContextUsage?.();
				const windowSize = usage?.contextWindow ?? ctx.model?.contextWindow ?? 128000;
				const sys = Math.round((ctx.getSystemPrompt?.() ?? "").length / 4);
				const tools = Math.round(JSON.stringify(pi.getAllTools().filter((t) => pi.getActiveTools().includes(t.name))
					.map((t) => [t.name, t.description, t.parameters])).length / 4);
				const used = usage?.tokens ?? sys + tools;
				const conv = Math.max(0, used - sys - tools);
				const parts = [["system prompt (rules, memory index, AGENTS.md)", sys], ["tool definitions", tools], ["conversation", conv]];
				const own = loadConfig().contextWindow?.[ctx.model?.id];
				const lines = [
					`${bar(parts, windowSize)} ${fmt(used)} of ${fmt(windowSize)} tokens (${Math.round((used / windowSize) * 100)}%)`,
					...parts.map(([name, n], i) => `  ${["#", "=", "-"][i]} ${name}: ${fmt(n)}`),
					`  . free: ${fmt(Math.max(0, windowSize - used))}`,
					`Size: ${fmt(windowSize)} (${own ? "set by you" : "the server's setting for this model"}). Change it: /context 400k, /context 1m, /context auto.`,
					"When it gets full, older parts are summarised automatically; /compact does it now.",
				];
				tell(ctx, lines.join("\n"), "info");
			},
		});

		async function setContext(want, ctx) {
			const model = ctx.model;
			if (!model) return tell(ctx, "No model selected", "warning");
			const all = { ...(loadConfig().contextWindow ?? {}) };
			let n = 0;
			if (want !== "auto" && want !== "reset") {
				n = parseTokens(want);
				if (!n || n < 16000) return tell(ctx, "Usage: /context 400k  (or 200000, 1m; auto = the server's setting). At least 16k.", "warning");
			}
			if (n) all[model.id] = n;
			else delete all[model.id];
			saveConfig({ contextWindow: all });
			cfg.contextWindow = all;
			deps.reregister(pi, cfg);
			const fresh = ctx.modelRegistry?.find?.("ferry", model.id);
			if (fresh) await pi.setModel(fresh);
			const server = deps.serverWindow(model.id);
			const size = fresh?.contextWindow ?? n;
			tell(ctx, `Context size for ${model.id}: ${fmt(size)} tokens${n ? "" : " (the server's setting)"}.` +
				(n && server && n > server ? `\nThe server lists this model with ${fmt(server)}. If the model really takes less, ` +
					"requests fail once the conversation grows past that; go back with /context auto." : "") +
				"\nA bigger context keeps more history before summarising, but every request costs more.", "info");
		}

		pi.registerCommand("config", {
			description: "Ferry's settings: pick one to change it",
			handler: async (_args, ctx) => {
				for (;;) {
					const cur = loadConfig();
					const show = (k) => {
						const v = cur[k];
						return `${k} = ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : JSON.stringify(v)}`;
					};
					const keys = Object.keys(SETTINGS);
					const pick = await ctx.ui.select("Ferry settings (pick one to change it; most apply the next time you start ferry)",
						[...keys.map(show), "More settings...", "Done"]);
					if (!pick || pick === "Done") return;
					let key = pick.split(" = ")[0];
					if (pick === "More settings...") {
						const more = await ctx.ui.select("More settings", [...Object.keys(ADVANCED_SETTINGS).map(show), "Back"]);
						if (!more || more === "Back") continue;
						key = more.split(" = ")[0];
					}
					const [type, why, choices] = SETTINGS[key] ?? ADVANCED_SETTINGS[key] ?? [];
					if (!type) continue;
					let value;
					if (type === "boolean") {
						const on = await ctx.ui.select(`${key}: ${why}`, ["on", "off"]);
						if (!on) continue;
						value = on === "on";
					} else if (choices) {
						const c = await ctx.ui.select(`${key}: ${why}`, choices);
						if (!c) continue;
						value = c.split(" ")[0];
					} else {
						const raw = await ctx.ui.input(`${key}: ${why}`, Array.isArray(cur[key]) ? cur[key].join(",") : String(cur[key] ?? ""));
						if (raw === undefined) continue;
						value = raw.trim();
						if (type === "number") value = Number(value) || 0;
						else if (type === "list") value = value ? value.split(",").map((x) => x.trim()).filter(Boolean) : [];
					}
					saveConfig({ [key]: value });
					if (key === "thinking") pi.setThinkingLevel(value);
					tell(ctx, `${key} = ${JSON.stringify(value)} (saved)`, "info");
				}
			},
		});

		pi.registerCommand("skills", {
			description: "List the skills the agent can use",
			handler: async (_a, ctx) => {
				const skills = ctx.getSystemPromptOptions?.().skills ?? [];
				const list = skills.map((s) => `  ${s.name}: ${String(s.description ?? "").slice(0, 100)}`).join("\n") || "  (none)";
				tell(ctx, `${list}\n\nThe agent reads a skill by itself when a task fits; /skill:<name> calls one. Add your own as ` +
					`folders with a SKILL.md in .ferry/skills/ or ${join(FERRY_HOME, "skills")} (docs/CUSTOMIZE.md).`, "info");
			},
		});
	};
}
