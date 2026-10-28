// A tiny MCP server over stdio (newline-delimited JSON-RPC) with one tool, for the self-test.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
	let req;
	try {
		req = JSON.parse(line);
	} catch {
		return;
	}
	if (req.id === undefined) return; // a notification
	if (req.method === "initialize") {
		send({ id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} },
			serverInfo: { name: "fake-notes", version: "1.0.0" } } });
	} else if (req.method === "tools/list") {
		send({ id: req.id, result: { tools: [{ name: "notes_lookup", description: "Look up a team note by key.",
			inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
			annotations: { readOnlyHint: true } }] } });
	} else if (req.method === "tools/call") {
		send({ id: req.id, result: { content: [{ type: "text", text: `NOTE[${req.params?.arguments?.key}]: the build runs on port 7070` }] } });
	} else send({ id: req.id, error: { code: -32601, message: `no method ${req.method}` } });
});
