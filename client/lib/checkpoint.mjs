// /undo: put files back the way they were before the agent changed them (like Claude Code's checkpoints / rewind).
//
// Before the first edit or write of a file in each request you send, its content is copied to
// <FERRY_HOME>/checkpoints/<session>/. /undo lists your recent requests that changed files; pick one and every file
// changed by it and by later requests goes back to how it was before. Changes made by shell commands (a build,
// `git checkout`, deleting files with rm...) are not tracked: use git for those.
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
			if ((event.toolName === "edit" || event.toolName === "write") && typeof event.input?.path === "string") {
				try {
					store?.snapshot(resolve(ctx?.cwd ?? process.cwd(), event.input.path));
				} catch {
					// a checkpoint that cannot be taken must not stop the edit
				}
			}
			return undefined;
		});
		pi.registerCommand("undo", {
			description: "Put files back the way they were before one of your recent requests (file edits only)",
			handler: async (_args, ctx) => {
				const runs = (store?.runs ?? []).filter((r) => r.files.length).slice(-15).reverse();
				if (!runs.length) return ctx.ui.notify("Nothing to undo: the agent has not changed files with edit or write in this conversation.", "info");
				const time = (t) => new Date(t).toLocaleTimeString();
				const pick = await ctx.ui.select("Undo the file changes of this request and everything after it:",
					[...runs.map((r) => `${time(r.at)}  ${r.label || "(request)"}  (${r.files.length} file${r.files.length > 1 ? "s" : ""})`), "Cancel"]);
				const run = runs.find((r) => pick?.startsWith(time(r.at)) && pick.includes(r.label));
				if (!run) return;
				const done = store.undo(run.id);
				const list = done.map(([p, how]) => `  ${how}: ${p}`).join("\n");
				ctx.ui.notify(`Undone. ${done.length} file(s):\n${list}\nChanges made by shell commands are not undone.`, "info");
				// tell the model, so it does not assume its edits are still there
				pi.sendMessage({ customType: "ferry-undo", display: false,
					content: `The user undid the file changes made since their request "${run.label}". These files are back to ` +
						`their earlier state:\n${list}\nRe-read files before relying on their content.` }, { deliverAs: "nextTurn" });
			},
		});
	};
}
