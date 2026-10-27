// Slash commands and do-it-yourself resources.
//
// Built in (Markdown templates in client/commands/): /init /review /commit /explain /test /fix /pr /doc
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
import { FERRY_HOME } from "./config.mjs";
import { MODE_LABEL } from "./permissions.mjs";

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

/** deps: { status(): lines about the server and model, mode(): current permission mode, agents(cwd) } */
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
