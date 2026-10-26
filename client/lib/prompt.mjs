// Ferry's own system prompt, in place of pi's default one.
//
// pi's default prompt introduces the model as "operating inside pi", lists pi's documentation folders and asks the
// model to read them in full; it also invites it to look at PI_* environment variables. Models took that as a cue
// to go reading pi's files and settings. Ferry keeps pi's tool list and tool rules, drops the rest, and adds what a
// coding agent on a locked-down work computer needs to know (like Claude Code's environment section).
import { existsSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { findBash } from "./config.mjs";

const IDENTITY = `You are Ferry, a coding agent that works on the user's computer from a terminal. You help with software
engineering: understanding code, changing it, running commands, debugging, planning and explaining. Your tools run on
the user's computer; your replies are shown in their terminal.`;

function style(webTools) {
	return [
		"How to work:",
		"- Understand before changing: search for and read the relevant code first; do not guess file contents.",
		"- Make the smallest change that does the job and follow the project's existing style and conventions.",
		"- After changing code, run the project's tests, linter or build when there is an obvious way to.",
		"- For work with several steps, keep a task list with the todo tool and update it as you go.",
		"- For wide searches or side tasks, use the task tool so the main conversation stays small.",
		"- Stay inside the project folder unless the user asks otherwise. Do not read configuration or settings of",
		"  Ferry or of the agent itself unless the user asks about them.",
		"- If an action is refused by the user or by policy, do not try to get around it: ask or choose another way.",
		"- Never print secrets, passwords or keys you come across.",
		"- Be concise. Reply in the language the user writes in. Show file paths clearly.",
		"",
		"Network: this computer usually cannot reach the internet directly (a company gateway blocks it). Do not use curl,",
		"wget, Invoke-WebRequest or other commands to fetch web pages or downloads.",
		webTools
			? "To read a web page or search the web, use web_fetch and web_search: they run on the Ferry server, which has internet access."
			: "You have no web access in this session; if you need information from the internet, say so and ask the user.",
	].join("\n");
}

function gitInfo(cwd) {
	let dir = cwd;
	for (let i = 0; i < 30; i++) {
		const head = join(dir, ".git", "HEAD");
		if (existsSync(head)) {
			try {
				const ref = readFileSync(head, "utf8").trim();
				const branch = ref.startsWith("ref: refs/heads/") ? ref.slice(16) : "detached";
				return `yes (branch ${branch})`;
			} catch {
				return "yes";
			}
		}
		const up = dirname(dir);
		if (up === dir) break;
		dir = up;
	}
	return "no";
}

function environment(cwd, tools) {
	const win = process.platform === "win32";
	const bash = tools.includes("bash") ? findBash() : "";
	const shell = tools.includes("bash")
		? win ? `Git Bash (${bash}): use Unix shell syntax; Windows paths can be written C:/like/this` : "bash"
		: tools.includes("powershell") ? "PowerShell" : "none";
	const os = win ? `Windows (${release()})` : process.platform === "darwin" ? "macOS" : `Linux (${release()})`;
	return [
		`Operating system: ${os}`,
		`Shell for commands: ${shell}`,
		`Project folder: ${cwd}`,
		`Git repository: ${gitInfo(cwd)}`,
		`Today's date: ${new Date().toISOString().slice(0, 10)}`,
	].join("\n");
}

/** pi's rules for the selected tools, without the ones that point the model at pi itself. */
function toolRules(o) {
	const seen = new Set();
	const rules = [];
	for (const name of o.selectedTools) for (const r of o.toolGuidelines[name] ?? []) rules.push(r);
	rules.push(...o.promptGuidelines);
	return rules.map((r) => r.trim()).filter((r) => r && !/\bPI_|\bpi\b/.test(r) && !seen.has(r) && seen.add(r))
		.map((r) => `- ${r}`).join("\n");
}

export function createPrompt() {
	return (pi) => {
		pi.on("before_agent_start", (event, ctx) => {
			const o = event.systemPromptOptions;
			// the user set SYSTEM.md or --system-prompt: theirs wins
			if (o.forceSystemPrompt || (o.customPrompt && !o.customPrompt.startsWith(IDENTITY))) return;
			const cwd = ctx?.cwd ?? o.cwd ?? process.cwd();
			const declared = o.selectedTools.filter((t) => !o.hiddenTools.includes(t));
			const tools = declared.filter((t) => o.toolSnippets[t]).map((t) => `- ${t}: ${o.toolSnippets[t]}`).join("\n");
			const webTools = declared.includes("web_fetch");
			o.customPrompt = `${IDENTITY}\n\n${style(webTools)}`;
			o.sections.tools = tools || "(none)";
			const rules = toolRules(o);
			if (rules) o.sections.tool_rules = rules;
			o.sections.environment = environment(cwd, declared);
		});
	};
}
