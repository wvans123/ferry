import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-report-"));
const { createReport, toolCounts, REPORT_PROMPT } = await import("../lib/report.mjs");

function register(cfg) {
	const tools = {}, commands = {}, sent = [];
	createReport(cfg, "9.9.9", "1.4.0")({
		registerTool: (t) => { tools[t.name] = t; },
		registerCommand: (n, c) => { commands[n] = c; },
		sendUserMessage: (m) => sent.push(m),
	});
	return { tool: tools.report_problem, command: commands.report, sent };
}

const branch = [
	{ type: "message", message: { role: "toolResult", toolName: "bash", isError: true } },
	{ type: "message", message: { role: "toolResult", toolName: "bash" } },
	{ type: "message", message: { role: "toolResult", toolName: "read" } },
	{ type: "message", message: { role: "user", content: "secret project text" } },
];

test("tool use is reported as counts only", () => {
	assert.equal(toolCounts(branch), "bash 2 (1 failed), read 1");
	assert.equal(toolCounts([]), "none");
});

test("/report asks the agent for a report that leaves the user's work out", async () => {
	const { command, sent } = register({});
	await command.handler("web_fetch hangs");
	assert.equal(sent.length, 1);
	assert.match(sent[0], /report_problem/);
	assert.match(sent[0], /public GitHub issue/);
	assert.match(sent[0], /My note: web_fetch hangs$/);
	assert.doesNotMatch(REPORT_PROMPT(""), /My note/);
});

test("a report is sent only after the user approves it; one that cannot reach the server waits for the next", async () => {
	const got = [];
	const srv = http.createServer((req, res) => {
		let body = "";
		req.on("data", (d) => { body += d; });
		req.on("end", () => {
			got.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: true, id: "1", issue: `https://github.com/x/y/issues/${got.length}`, hidden: 1 }));
		});
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const cfg = { server: `http://127.0.0.1:${srv.address().port}`, token: "t", mode: "remote" };
	const { tool } = register(cfg);
	const shown = [];
	const ctx = (answer) => ({ hasUI: true, model: { id: "auto" }, sessionManager: { getBranch: () => branch },
		ui: { select: async (title, options) => { shown.push(title); return answer(options); } } });
	const params = { title: "web_fetch times out", body: "It hung for 60 s." };

	// no terminal: nothing leaves the computer
	const r0 = await tool.execute("1", params, undefined, undefined, { hasUI: false });
	assert.match(r0.content[0].text, /Not sent/);
	// the user says no
	const r1 = await tool.execute("2", params, undefined, undefined, ctx((o) => o[1]));
	assert.match(r1.content[0].text, /did not send/);
	assert.equal(got.length, 0);
	assert.match(shown[0], /public GitHub issue[\s\S]*web_fetch times out[\s\S]*It hung for 60 s\.[\s\S]*tools used: bash 2 \(1 failed\), read 1/);
	assert.doesNotMatch(shown[0], /secret project text/);

	// the server cannot be reached: kept on this computer
	const off = register({ ...cfg, server: "http://127.0.0.1:9" }).tool;
	const r2 = await off.execute("3", params, undefined, undefined, ctx((o) => o[0]));
	assert.match(r2.content[0].text, /Not sent[\s\S]*goes with the next report/);
	assert.equal(readdirSync(join(process.env.FERRY_HOME, "reports")).length, 1);

	// the next one goes through and takes the kept one along
	const r3 = await tool.execute("4", params, undefined, undefined, ctx((o) => o[0]));
	assert.match(r3.content[0].text, /Sent\. GitHub issue: https:\/\/github.com\/x\/y\/issues\/1/);
	assert.match(r3.content[0].text, /hid 1 item/);
	assert.match(r3.content[0].text, /earlier report was sent too/);
	assert.equal(got.length, 2);
	assert.equal(got[0].url, "/v1/ferry/report");
	assert.equal(got[0].auth, "Bearer t");
	assert.deepEqual(Object.keys(got[0].body), ["title", "body", "facts"]);
	assert.equal(got[0].body.facts.ferry, "9.9.9");
	assert.equal(readdirSync(join(process.env.FERRY_HOME, "reports")).length, 0);
	assert.ok(existsSync(process.env.FERRY_HOME));
	srv.close();
});
