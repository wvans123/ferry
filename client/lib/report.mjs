// /report: tell the Ferry developers what went wrong, from a work computer that may only talk to its Ferry server.
// The agent writes the report (it saw the problem), you read it and approve it here, it goes to the Ferry server, and the
// server (which has the internet and a GitHub token) scrubs it once more and opens a GitHub issue. Only counts and
// versions are added automatically; nothing from your files. A report that cannot reach the server is kept in
// <FERRY_HOME>/reports and sent with the next one.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { FERRY_HOME, serverHeaders } from "./config.mjs";

const PENDING = join(FERRY_HOME, "reports");
const SEND = "Send";

export const REPORT_PROMPT = (note) => "Write a problem report about Ferry itself (the agent tool you are running in), " +
	"not about my project, and send it with the report_problem tool. It becomes a public GitHub issue, so leave out " +
	"everything about my work: no file contents or code, no file or folder names, no project, company, product, people " +
	"or host names, no internal addresses. Say them in general terms instead (\"a 3 MB Word file\", \"a site on the " +
	"company network\"). Write what I was trying to do, what Ferry did step by step, what went wrong, the exact error " +
	"messages (with private parts taken out), and what you think the cause in Ferry is. If you cannot tell what went " +
	"wrong from this conversation, ask me first." + (note ? `\n\nMy note: ${note}` : "");

/** Tool use in this conversation, as counts only: "bash 12 (2 failed), read 30". */
export function toolCounts(branch) {
	const n = new Map();
	for (const e of branch ?? []) {
		const m = e?.type === "message" ? e.message : undefined;
		if (m?.role !== "toolResult" || !m.toolName) continue;
		const c = n.get(m.toolName) ?? { all: 0, failed: 0 };
		c.all++;
		if (m.isError) c.failed++;
		n.set(m.toolName, c);
	}
	return [...n].sort((a, b) => b[1].all - a[1].all)
		.map(([k, c]) => `${k} ${c.all}${c.failed ? ` (${c.failed} failed)` : ""}`).join(", ") || "none";
}

async function post(cfg, report) {
	const r = await fetch(`${cfg.server}/v1/ferry/report`, {
		method: "POST", headers: serverHeaders(cfg, { "Content-Type": "application/json" }),
		body: JSON.stringify(report), signal: AbortSignal.timeout(60000),
	});
	if (!r.ok) throw new Error(`the Ferry server answered HTTP ${r.status}`);
	return r.json();
}

/** Send a report, and any kept from earlier. Returns what to tell the agent. */
export async function sendReport(cfg, report) {
	const lines = [];
	try {
		const a = await post(cfg, report);
		lines.push(a.ok ? `Sent. GitHub issue: ${a.issue}` : `Kept on the Ferry server as report ${a.id}, but not on GitHub yet: ${a.error}. ` +
			"It can be sent again from the server's admin page (设置 → 问题报告).");
		if (a.hidden) lines.push(`The server hid ${a.hidden} item(s) that looked private before posting.`);
	} catch (e) {
		mkdirSync(PENDING, { recursive: true });
		const f = join(PENDING, `${Date.now()}.json`);
		writeFileSync(f, JSON.stringify(report), "utf8");
		return `Not sent (${e.message}). Kept in ${f}; it goes with the next report that reaches the Ferry server.`;
	}
	for (const name of existsSync(PENDING) ? readdirSync(PENDING).filter((x) => x.endsWith(".json")) : []) {
		try {
			const a = await post(cfg, JSON.parse(readFileSync(join(PENDING, name), "utf8")));
			rmSync(join(PENDING, name));
			lines.push(`An earlier report was sent too${a.issue ? `: ${a.issue}` : ` (kept on the server: ${a.error})`}.`);
		} catch {
			break; // still unreachable; try again next time
		}
	}
	return lines.join("\n");
}

export function createReport(cfg, version, piVersion) {
	return (pi) => {
		pi.registerTool({
			name: "report_problem",
			label: "Report",
			description: "Send a problem report about Ferry itself to its developers (it becomes a public GitHub issue, " +
				"posted by the user's Ferry server). Use it only when the user asks for a report (/report). Keep everything " +
				"about the user's work out of it. The user reads the full text and approves it before it is sent.",
			promptSnippet: "Report a problem with Ferry itself to its developers (only when the user asks)",
			parameters: Type.Object({
				title: Type.String({ description: "One line: what goes wrong, e.g. \"a long command output never reaches the model\"" }),
				body: Type.String({ description: "Markdown: what the user tried, what Ferry did, what went wrong, the errors, the likely cause" }),
			}),
			annotations: { readOnlyHint: true, openWorldHint: false }, // it asks the user itself, with the full text
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const facts = {
					ferry: version, pi: piVersion, os: `${process.platform} ${release()}`, node: process.version,
					server: cfg.mode === "local" ? "on this computer" : "remote", model: ctx?.model?.id ?? "",
					"tools used": toolCounts(ctx?.sessionManager?.getBranch?.()),
				};
				const report = { title: String(params.title ?? "").trim(), body: String(params.body ?? "").trim(), facts };
				const text = (t) => ({ content: [{ type: "text", text: t }], details: undefined });
				if (!ctx?.hasUI) return text("Not sent: the user has to read and approve a report in the terminal first.");
				const shown = `${report.title}\n\n${report.body}\n\n${Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join("\n")}`;
				const pick = await ctx.ui.select("Send this report? Your Ferry server posts it as a public GitHub issue " +
					`(after hiding words from its list, private addresses, e-mails and keys).\n\n${shown}`, [SEND, "Don't send"]);
				if (pick !== SEND) return text("The user did not send the report. Ask what to change, or leave it.");
				return text(await sendReport(cfg, report));
			},
		});
		pi.registerCommand("report", {
			description: "Tell the Ferry developers what went wrong: the agent writes a report, you approve it, your Ferry server posts it to GitHub",
			handler: async (args) => {
				pi.sendUserMessage(REPORT_PROMPT(String(args ?? "").trim()));
			},
		});
	};
}
