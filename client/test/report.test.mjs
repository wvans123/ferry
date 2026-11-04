import assert from "node:assert/strict";
import http from "node:http";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

process.env.FERRY_HOME = mkdtempSync(join(tmpdir(), "ferry-report-"));
const { createReport, toolCounts, REPORT_PROMPT } = await import("../lib/report.mjs");
const { readFileSync: readText, writeFileSync: writeText } = await import("node:fs");

function register(cfg, open = () => true) {
	const tools = {}, commands = {}, sent = [];
	createReport(cfg, "9.9.9", "1.4.0", { open })({
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
		ui: { notify() {}, select: async (title, options) => { shown.push(title); return answer(options); } } });
	const send = (o) => o.find((x) => x === "Send");
	const params = { title: "web_fetch times out", body: "It hung for 60 s." };

	// no terminal: nothing leaves the computer
	const r0 = await tool.execute("1", params, undefined, undefined, { hasUI: false });
	assert.match(r0.content[0].text, /Not sent/);
	// the user says no
	const r1 = await tool.execute("2", params, undefined, undefined, ctx((o) => o.find((x) => x === "Don't send")));
	assert.match(r1.content[0].text, /did not send/);
	assert.equal(got.length, 0);
	assert.match(shown[0], /public GitHub issue[\s\S]*web_fetch times out[\s\S]*It hung for 60 s\.[\s\S]*Full text \(1 lines\): /);
	assert.doesNotMatch(shown[0], /secret project text/);

	// a long report: the question shows the start and how much more there is; the full text is in a file the user
	// may open and change, and what the file says is what goes out
	let draft = "";
	const long = { title: "long one", body: Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") };
	const edit = register(cfg, (file) => {
		draft = file;
		writeText(file, readText(file, "utf8").replace("# long one", "# shorter title").replace(/line 2[0-9]\n/g, ""));
		return true;
	}).tool;
	const answers = ["Open the full text first (you can change it there)", "Send"];
	const r1b = await edit.execute("2b", long, undefined, undefined, ctx((o) => {
		const a = answers.shift();
		assert.ok(o.includes(a), `${a} not in ${o}`);
		return a;
	}));
	assert.match(shown.at(-2), /line 8\n\.\.\. 22 more line\(s\)\n\nFull text \(30 lines\)/);
	assert.doesNotMatch(shown.at(-2), /line 9\b/);
	assert.match(shown.at(-1), /^Send this report\?[\s\S]*sent as the file reads now[\s\S]*shorter title/);
	assert.match(r1b.content[0].text, /Sent\./);
	assert.equal(got.at(-1).body.title, "shorter title");
	assert.equal(got.at(-1).body.body.split("\n").length, 20);
	assert.ok(draft && !existsSync(draft), "the draft is removed once decided");
	got.length = 0;

	// the server cannot be reached: kept on this computer
	const off = register({ ...cfg, server: "http://127.0.0.1:9" }).tool;
	const r2 = await off.execute("3", params, undefined, undefined, ctx(send));
	assert.match(r2.content[0].text, /Not sent[\s\S]*goes with the next report/);
	assert.equal(readdirSync(join(process.env.FERRY_HOME, "reports")).filter((f) => f.endsWith(".json")).length, 1);

	// the next one goes through and takes the kept one along
	const r3 = await tool.execute("4", params, undefined, undefined, ctx(send));
	assert.match(r3.content[0].text, /Sent\. GitHub issue: https:\/\/github.com\/x\/y\/issues\/1/);
	assert.match(r3.content[0].text, /hid 1 item/);
	assert.match(r3.content[0].text, /earlier report was sent too/);
	assert.equal(got.length, 2);
	assert.equal(got[0].url, "/v1/ferry/report");
	assert.equal(got[0].auth, "Bearer t");
	assert.deepEqual(Object.keys(got[0].body), ["title", "body", "facts"]);
	assert.equal(got[0].body.facts.ferry, "9.9.9");
	assert.equal(readdirSync(join(process.env.FERRY_HOME, "reports")).filter((f) => f.endsWith(".json")).length, 0);
	assert.ok(existsSync(process.env.FERRY_HOME));
	srv.close();
});
