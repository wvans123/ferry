// Background jobs, like Claude Code's background commands and tasks:
//   job_start   run a long command (a dev server, a build, a watcher) without waiting for it
//   job_output  see how it is doing: state and the latest output
//   job_stop    stop it
// Subagents started with task(background: true) are listed here too. /tasks shows everything and can stop it.
// When a job ends you get a notice, and the agent is told with your next message. Jobs stop when ferry exits.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { FERRY_HOME, findBash } from "./config.mjs";

const jobs = new Map(); // id -> job, shared by the main agent and its subagents
let nextId = 1;
let hooks = { ui: null, tell: () => {} };
const DIR = join(FERRY_HOME, "jobs", String(process.pid));

function tailOf(text, lines = 40, maxBytes = 8000) {
	let t = text.split(/\r?\n/).slice(-lines).join("\n");
	if (t.length > maxBytes) t = `...${t.slice(-maxBytes)}`;
	return t;
}

function finished(job) {
	const what = job.kind === "subagent" ? `Background subagent ${job.id} (${job.name})` : `Background job ${job.id} (${job.name})`;
	const how = job.status === "stopped" ? "was stopped" : job.kind === "subagent" ? (job.status === "done" ? "finished" : "failed")
		: `exited with code ${job.code}`;
	hooks.ui?.notify(`${what} ${how}. /tasks to see it.`, job.status === "done" ? "info" : "warning");
	const body = job.kind === "subagent" ? (job.report ?? job.error ?? "") : tailOf(output(job), 30);
	hooks.tell(`${what} ${how}.${body ? `\n${job.kind === "subagent" ? "Report" : "Last output"}:\n${body}` : ""}`);
}

function output(job) {
	try {
		return readFileSync(job.log, "utf8");
	} catch {
		return "";
	}
}

/** Start a shell command in the background. */
export function startCommand(command, name, cwd) {
	mkdirSync(DIR, { recursive: true });
	const id = nextId++;
	const bash = findBash();
	const [prog, args] = bash ? [bash, ["-c", command]]
		: ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`]];
	const job = { id, kind: "command", name: name || command.slice(0, 40), command, status: "running", started: Date.now(),
		log: join(DIR, `${id}.log`) };
	appendFileSync(job.log, "");
	const child = spawn(prog, args, { cwd, env: process.env, windowsHide: true, detached: process.platform !== "win32" });
	job.child = child;
	const write = (d) => appendFileSync(job.log, d);
	child.stdout.on("data", write);
	child.stderr.on("data", write);
	child.on("error", (e) => write(`\n${e.message}\n`));
	child.on("close", (code) => {
		if (job.status === "running") job.status = code === 0 ? "done" : "failed";
		job.code = code;
		job.ended = Date.now();
		job.child = null;
		finished(job);
	});
	jobs.set(id, job);
	return job;
}

/** Track a background subagent: run() resolves to its report text. */
export function startSubagentJob(name, run) {
	const id = nextId++;
	const controller = new AbortController();
	const job = { id, kind: "subagent", name, status: "running", started: Date.now(), controller };
	jobs.set(id, job);
	run(controller.signal).then((report) => {
		if (job.status === "running") job.status = "done";
		job.report = report;
	}, (e) => {
		if (job.status === "running") job.status = "failed";
		job.error = String(e?.message ?? e);
	}).finally(() => {
		job.ended = Date.now();
		finished(job);
	});
	return job;
}

export function stopJob(job) {
	if (job.status !== "running") return false;
	job.status = "stopped";
	if (job.kind === "subagent") job.controller.abort();
	else if (job.child) {
		if (process.platform === "win32") spawn("taskkill", ["/PID", String(job.child.pid), "/T", "/F"], { windowsHide: true });
		else {
			try {
				process.kill(-job.child.pid, "SIGTERM");
			} catch {
				job.child.kill();
			}
		}
	}
	return true;
}

const age = (job) => `${Math.round(((job.ended ?? Date.now()) - job.started) / 1000)}s`;
export const listJobs = () => [...jobs.values()];
export const describeJob = (j) => `#${j.id} ${j.kind === "subagent" ? "subagent" : "command"} ${j.status} ${age(j)}  ${j.name}`;

export function createJobs() {
	return (pi) => {
		hooks.tell = (text) => pi.sendMessage({ customType: "ferry-job", content: text, display: false }, { deliverAs: "nextTurn" });
		pi.on("session_start", (_e, ctx) => {
			if (ctx.hasUI) hooks.ui = ctx.ui;
		});
		pi.on("session_shutdown", () => {
			for (const j of jobs.values()) stopJob(j);
		});

		pi.registerTool({
			name: "job_start",
			label: "Background job",
			description: "Run a long-lived command in the background (a dev server, a watcher, a long build or test run) and " +
				"return at once. Check it with job_output, stop it with job_stop. Use the normal shell tool for commands that " +
				"finish quickly.",
			promptSnippet: "Run a long command in the background",
			parameters: Type.Object({
				command: Type.String({ description: "The command, as for the shell tool" }),
				name: Type.Optional(Type.String({ description: "A short name, e.g. dev server" })),
			}),
			async execute(_id, p, _signal, _onUpdate, ctx) {
				const job = startCommand(p.command, p.name, ctx?.cwd ?? process.cwd());
				await new Promise((r) => setTimeout(r, 1500)); // the first lines usually say whether it started
				return {
					content: [{ type: "text", text: `Started job ${job.id} (${job.name}), ${job.status}.\n${tailOf(output(job), 15) || "(no output yet)"}` }],
					details: { id: job.id },
				};
			},
		});
		pi.registerTool({
			name: "job_output",
			label: "Job output",
			description: "State and latest output of a background job or background subagent (all of them when id is left out).",
			promptSnippet: "Check a background job",
			parameters: Type.Object({
				id: Type.Optional(Type.Number()),
				lines: Type.Optional(Type.Number({ description: "How many of the last lines, default 40" })),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, p) {
				if (p.id === undefined) {
					const all = listJobs().map(describeJob).join("\n") || "No background jobs.";
					return { content: [{ type: "text", text: all }], details: undefined };
				}
				const job = jobs.get(Number(p.id));
				if (!job) throw new Error(`No job ${p.id}. Jobs: ${listJobs().map((j) => j.id).join(", ") || "none"}`);
				const body = job.kind === "subagent" ? (job.report ?? job.error ?? "(still working)") : tailOf(output(job), p.lines ?? 40) || "(no output yet)";
				return { content: [{ type: "text", text: `${describeJob(job)}${job.code !== undefined ? ` (exit ${job.code})` : ""}\n${body}` }], details: undefined };
			},
		});
		pi.registerTool({
			name: "job_stop",
			label: "Stop job",
			description: "Stop a background job or background subagent.",
			promptSnippet: "Stop a background job",
			parameters: Type.Object({ id: Type.Number() }),
			annotations: { readOnlyHint: true, openWorldHint: false },
			async execute(_id, p) {
				const job = jobs.get(Number(p.id));
				if (!job) throw new Error(`No job ${p.id}`);
				return { content: [{ type: "text", text: stopJob(job) ? `Stopping job ${job.id}.` : `Job ${job.id} is not running.` }], details: undefined };
			},
		});

		pi.registerCommand("tasks", {
			description: "Background commands and subagents: see their output, stop them",
			handler: async (_a, ctx) => {
				const all = listJobs().reverse();
				if (!all.length) return ctx.ui.notify("No background tasks. The agent starts them with job_start, or task(background).", "info");
				const pick = await ctx.ui.select("Background tasks", [...all.map(describeJob), "Done"]);
				const job = all.find((j) => pick === describeJob(j));
				if (!job) return;
				const what = await ctx.ui.select(describeJob(job), job.status === "running" ? ["Show output", "Stop it", "Back"] : ["Show output", "Back"]);
				if (what === "Stop it") stopJob(job);
				if (what === "Show output") {
					ctx.ui.notify(job.kind === "subagent" ? (job.report ?? job.error ?? "(still working)") : tailOf(output(job), 60) || "(no output)", "info");
				}
			},
		});
	};
}
