// /rewind: go back to one of your messages, like Claude Code's rewind: the conversation, the files, or both.
//
// Before the first edit or write of a file in each request you send, its content is copied to
// <FERRY_HOME>/checkpoints/<session>/. /rewind lists your messages; pick one, and
//   - the conversation goes back to just before it (your message is put back in the input box, to change and resend;
//     the later part stays in the session file), and/or
//   - every file the agent changed with edit/write since then goes back to how it was.
// Changes made by shell commands (a build, `git checkout`, deleting files with rm...) are not tracked: use git for those.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FERRY_HOME } from "./config.mjs";

export const CHECKPOINTS = join(FERRY_HOME, "checkpoints");
const MAX_FILE = 5 * 1024 * 1024;
const KEEP_DAYS = 14;

/** Checkpoint store for one session. runs: [{ id, label, at, files: [{ path, existed, blob }] }] */
export function createStore(dir) {
	mkdirSync(dir, { recursive: true });
	const indexFile = join(dir, "index.json");
	let runs = [];
	try {
		runs = JSON.parse(readFileSync(indexFile, "utf8"));
	} catch {
		// new session
	}
	const save = () => writeFileSync(indexFile, JSON.stringify(runs), "utf8");
	return {
		get runs() {
			return runs;
		},
		begin(label) {
			runs.push({ id: (runs.at(-1)?.id ?? 0) + 1, label: label.replace(/\s+/g, " ").slice(0, 70), at: Date.now(), files: [] });
			save();
		},
		/** Remember a file's content before its first change in the current run. */
		snapshot(path) {
			const run = runs.at(-1);
			if (!run || run.files.some((f) => f.path === path)) return;
			let existed = existsSync(path);
			let blob = null;
			if (existed) {
				if (statSync(path).size > MAX_FILE) return; // too big to keep a copy
				const data = readFileSync(path);
				blob = createHash("sha256").update(data).digest("hex").slice(0, 24);
				const b = join(dir, blob);
				if (!existsSync(b)) writeFileSync(b, data);
			}
			run.files.push({ path, existed, blob });
			save();
		},
		/** Restore every file changed in run `id` and later; returns the restored paths. */
		undo(id) {
			const later = runs.filter((r) => r.id >= id).reverse();
			const done = new Map();
			for (const r of later) {
				for (const f of r.files) {
					if (f.existed) {
						mkdirSync(dirname(f.path), { recursive: true });
						writeFileSync(f.path, readFileSync(join(dir, f.blob)));
					} else rmSync(f.path, { force: true });
					done.set(f.path, f.existed ? "restored" : "removed");
				}
			}
			runs = runs.filter((r) => r.id < id);
			save();
			return [...done.entries()];
		},
	};
}

function cleanOld() {
	try {
		const cutoff = Date.now() - KEEP_DAYS * 86400_000;
		for (const d of readdirSync(CHECKPOINTS)) {
			const p = join(CHECKPOINTS, d);
			if (statSync(p).mtimeMs < cutoff) rmSync(p, { recursive: true, force: true });
		}
	} catch {
		// nothing yet
	}
}

export function createCheckpoints() {
	return (pi) => {
		let store = null;
		pi.on("session_start", (_e, ctx) => {
			cleanOld();
			const id = ctx.sessionManager.getSessionId?.() ?? `s-${Date.now()}`;
			store = createStore(join(CHECKPOINTS, String(id).replace(/[^\w-]+/g, "_")));
		});
		pi.on("before_agent_start", (event) => {
			if (event.messageType === "user") store?.begin(event.prompt ?? "");
		});
		pi.on("tool_call", (event, ctx) => {
			if (["edit", "write", "office_edit", "office_create"].includes(event.toolName) && typeof event.input?.path === "string") {
				try {
					store?.snapshot(resolve(ctx?.cwd ?? process.cwd(), event.input.path));
				} catch {
					// a checkpoint that cannot be taken must not stop the edit
				}
			}
			return undefined;
		});
		const textOf = (m) => (typeof m.content === "string" ? m.content
			: (m.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join(" ")).replace(/\s+/g, " ").trim();
		const timeOf = (e) => e.message?.timestamp ?? (Date.parse(e.timestamp ?? "") || 0);

		pi.registerCommand("rewind", {
			description: "Go back to one of your messages: the conversation, the files the agent changed, or both",
			handler: async (_args, ctx) => {
				if (!ctx.hasUI) return;
				const users = ctx.sessionManager.getBranch().filter((e) => e.type === "message" && e.message?.role === "user");
				if (!users.length) return ctx.ui.notify("Nothing to go back to yet.", "info");
				// a request's checkpoint starts just before its message is stored, so everything after the previous message
				const since = (k) => (store?.runs ?? []).filter((r) => r.at > (k > 0 ? timeOf(users[k - 1]) : 0));
				const changed = (k) => new Set(since(k).flatMap((r) => r.files.map((f) => f.path))).size;
				const time = (e) => new Date(timeOf(e)).toLocaleTimeString();
				const items = users.map((e, k) => ({ e, k, files: changed(k),
					label: `${time(e)}  ${textOf(e.message).slice(0, 60) || "(message)"}` })).slice(-20).reverse();
				const pick = await ctx.ui.select("Go back to just before which message?",
					[...items.map((x) => `${x.label}${x.files ? `  [${x.files} file${x.files > 1 ? "s" : ""} changed since]` : ""}`), "Cancel"]);
				const item = items.find((x) => pick?.startsWith(x.label));
				if (!item) return;
				let how = "Conversation only";
				if (item.files) {
					how = await ctx.ui.select(`Go back to before "${textOf(item.e.message).slice(0, 50)}":`,
						["Conversation and files", "Conversation only (keep the files as they are now)", "Files only (keep the conversation)", "Cancel"]);
					if (!how || how === "Cancel") return;
				}
				let list = "";
				if (how.startsWith("Conversation and") || how.startsWith("Files")) {
					const done = store.undo(since(item.k)[0].id);
					list = done.map(([p, what]) => `  ${what}: ${p}`).join("\n");
				}
				if (how.startsWith("Conversation")) {
					const r = await ctx.navigateTree(item.e.id);
					if (r?.cancelled) return ctx.ui.notify("Not rewound.", "warning");
					if (how.startsWith("Conversation only") && item.files) {
						pi.sendMessage({ customType: "ferry-rewind", display: false,
							content: "The user went back in the conversation but kept the files: changes made after this point are " +
								"still on disk. Re-read files before relying on their content." }, { deliverAs: "nextTurn" });
					}
				} else {
					// tell the model, so it does not assume its edits are still there
					pi.sendMessage({ customType: "ferry-undo", display: false,
						content: `The user undid the file changes made since their message "${textOf(item.e.message).slice(0, 80)}". ` +
							`These files are back to their earlier state:\n${list}\nRe-read files before relying on their content.` },
					{ deliverAs: "nextTurn" });
				}
				ctx.ui.notify([how.startsWith("Conversation") ? "Back to before that message; it is in the input box to change and send again." : "",
					list ? `Files put back:\n${list}\nChanges made by shell commands are not undone.` : ""].filter(Boolean).join("\n"), "info");
			},
		});
	};
}
