// Hooks: your own commands that run at fixed moments (like Claude Code's hooks).
//
//   <FERRY_HOME>/hooks.json          yours, for every project
//   <project>/.ferry/hooks.json      the project's (asked once before they run, and again whenever the file changes)
//
// {
//   "afterEdit": [ { "match": "**/*.{ts,tsx}", "run": "npx prettier --write \"$FERRY_FILE\"" },
//                  { "match": "**/*.py", "run": "ruff check \"$FERRY_FILE\"" } ],
//   "onDone":    [ { "run": "npm run lint --silent" } ]
// }
//
// afterEdit runs after the agent changes a matching file; if the command fails, its output goes back to the agent with
// the edit result, so it can fix what the formatter or linter found. onDone runs when the agent has finished your
// request; you see the result. "timeout" (seconds, default 60) is optional on every hook.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { FERRY_HOME, findBash } from "./config.mjs";
import { projectKeyDir } from "./permissions.mjs";

/** "**\/*.{ts,tsx}" -> RegExp on forward-slash paths relative to the project. */
export function globRe(glob) {
	let re = "";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			re += ".*";
			i++;
			if (glob[i + 1] === "/") i++;
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += "[^/]";
		else if (c === "{") re += "(";
		else if (c === "}") re += ")";
		else if (c === "," && re.lastIndexOf("(") > re.lastIndexOf(")")) re += "|";
		else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${re}$`, "i");
}

function readHooks(file) {
	try {
		return { text: readFileSync(file, "utf8"), hooks: JSON.parse(readFileSync(file, "utf8")) };
	} catch {
		return null;
	}
}

/** Run one hook command in the project folder. Resolves to { code, output }. */
export function runHook(cmd, cwd, env = {}, timeoutSec = 60) {
	return new Promise((done) => {
		const bash = process.platform === "win32" ? findBash() : "sh";
		const [prog, args] = bash ? [bash, ["-c", cmd]] : ["cmd.exe", ["/d", "/s", "/c", cmd]];
		let output = "";
		const child = spawn(prog, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
		const add = (d) => {
			output += d.toString();
			if (output.length > 200_000) output = output.slice(-100_000);
		};
		child.stdout.on("data", add);
		child.stderr.on("data", add);
		const timer = setTimeout(() => {
			child.kill();
			output += `\n(stopped after ${timeoutSec} s)`;
		}, timeoutSec * 1000);
		child.on("error", (e) => {
			clearTimeout(timer);
			done({ code: 127, output: String(e.message) });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			done({ code: code ?? 1, output: output.trim() });
		});
	});
}

const tail = (s, n = 3000) => (s.length > n ? `...${s.slice(-n)}` : s);

export function createHooks() {
	return (pi) => {
		let hooks = { afterEdit: [], onDone: [] };
		const load = async (ctx) => {
			const cwd = ctx.cwd ?? process.cwd();
			hooks = { afterEdit: [], onDone: [] };
			const add = (h) => {
				for (const k of Object.keys(hooks)) if (Array.isArray(h?.[k])) hooks[k].push(...h[k].filter((x) => x?.run));
			};
			add(readHooks(join(FERRY_HOME, "hooks.json"))?.hooks);
			const project = readHooks(join(cwd, ".ferry", "hooks.json"));
			if (!project) return;
			// a repository can carry hooks; they run commands, so ask once per version of the file
			const hash = createHash("sha256").update(project.text).digest("hex");
			const trustFile = join(projectKeyDir(cwd), "hooks-trust.json");
			let trusted = "";
			try {
				trusted = JSON.parse(readFileSync(trustFile, "utf8")).hash;
			} catch {
				// never asked
			}
			if (trusted === hash) return add(project.hooks);
			if (!ctx.hasUI) return;
			const list = Object.entries(project.hooks).flatMap(([k, v]) => (Array.isArray(v) ? v : []).map((h) => `  ${k}: ${h.run}`)).join("\n");
			const ok = await ctx.ui.select(`This project's .ferry/hooks.json runs these commands automatically:\n${list}\n\nAllow them?`,
				["Allow (asked again if the file changes)", "Not now"]);
			if (ok?.startsWith("Allow")) {
				mkdirSync(projectKeyDir(cwd), { recursive: true });
				writeFileSync(trustFile, JSON.stringify({ hash }), "utf8");
				add(project.hooks);
			}
		};
		pi.on("session_start", (_e, ctx) => load(ctx));

		pi.on("tool_result", async (event, ctx) => {
			if (event.isError || !(event.toolName === "edit" || event.toolName === "write") || !hooks.afterEdit.length) return undefined;
			const cwd = ctx?.cwd ?? process.cwd();
			const file = resolve(cwd, String(event.input?.path ?? ""));
			const rel = relative(cwd, file).replace(/\\/g, "/");
			const notes = [];
			for (const h of hooks.afterEdit) {
				if (h.match && !globRe(h.match).test(rel)) continue;
				const r = await runHook(h.run, cwd, { FERRY_FILE: file, FERRY_FILE_REL: rel }, h.timeout ?? 60);
				if (r.code !== 0) notes.push(`[hook "${h.run}" failed with exit code ${r.code}; fix what it reports]\n${tail(r.output)}`);
				else if (h.show && r.output) notes.push(`[hook "${h.run}"]\n${tail(r.output)}`);
			}
			if (!notes.length) return undefined;
			return { content: [...(event.content ?? []), { type: "text", text: `\n${notes.join("\n\n")}` }] };
		});

		pi.on("agent_settled", async (_e, ctx) => {
			for (const h of hooks.onDone) {
				const r = await runHook(h.run, ctx?.cwd ?? process.cwd(), {}, h.timeout ?? 120);
				if (ctx?.hasUI) ctx.ui.notify(`${r.code === 0 ? "OK" : `exit ${r.code}`}  ${h.run}${r.output ? `\n${tail(r.output, 1500)}` : ""}`, r.code === 0 ? "info" : "warning");
			}
		});
	};
}
