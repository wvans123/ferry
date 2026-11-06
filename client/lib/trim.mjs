// Fewer slash commands: hide pi's built-in commands that Ferry users do not need, and pi's llama.cpp extension.
//
// pi keeps its built-in command list in dist/core/slash-commands.js and its built-in extensions in
// dist/extensions/index.js; neither is exported from the package, so they are imported by file (the same module
// instances pi's interactive mode and main() use) and edited in place before main() runs.
// A hidden command still works when typed in full; it is only left out of the "/" list.

import { restrictModelRuntime } from "./server-models.mjs";

// Kept: model, name, session, new, compact, resume, quit (and /mcp, /skill:..., Ferry's own commands)
export const HIDDEN_BUILTINS = ["settings", "tree", "thinking", "scoped-models", "export", "import", "share", "bug", "copy",
	"changelog", "hotkeys", "fork", "clone", "trust", "login", "logout", "reload"];
const DROPPED_EXTENSIONS = ["llama.cpp"];

export async function trimPi(modelIds) {
	const index = import.meta.resolve("@earendil-works/pi-coding-agent"); // .../dist/index.js
	// Unlike cosmetic trimming, model isolation must fail closed if Pi changes its internals.
	const { ModelRuntime } = await import(new URL("./core/model-runtime.js", index).href);
	restrictModelRuntime(ModelRuntime, modelIds);
	const result = { hidden: [], dropped: [] };
	try {
		const { BUILTIN_SLASH_COMMANDS: list } = await import(new URL("./core/slash-commands.js", index).href);
		for (let i = list.length - 1; i >= 0; i--) {
			if (HIDDEN_BUILTINS.includes(list[i].name)) result.hidden.push(...list.splice(i, 1).map((c) => c.name));
		}
	} catch {
		// a pi version laid out differently: every command stays listed
	}
	try {
		const { builtInExtensions: exts } = await import(new URL("./extensions/index.js", index).href);
		for (let i = exts.length - 1; i >= 0; i--) {
			if (DROPPED_EXTENSIONS.includes(exts[i].name)) result.dropped.push(...exts.splice(i, 1).map((e) => e.name));
		}
	} catch {
		// as above
	}
	try {
		// Ctrl+C: pi quits only when it is pressed twice within half a second, which is easy to miss. Ferry: twice within
		// two seconds, and it says so after the first press.
		const { InteractiveMode } = await import(new URL("./modes/interactive/interactive-mode.js", index).href);
		InteractiveMode.prototype.handleCtrlC = function handleCtrlC() {
			const now = Date.now();
			if (now - (this.lastSigintTime ?? 0) < 2000) return void this.shutdown();
			this.clearEditor();
			this.lastSigintTime = now;
			this.showStatus?.("Press Ctrl+C again to quit (or Ctrl+D)");
		};
		result.ctrlC = true;
	} catch {
		// laid out differently: pi's own behaviour stays
	}
	try {
		// Only the Ferry server's models: pi also lists every built-in provider it finds a key for on this computer
		// (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...), which Ferry never uses. /model, Ctrl+L and --list-models show
		// what the server offers, nothing else.
		const { ModelRuntime } = await import(new URL("./core/model-runtime.js", index).href);
		const P = ModelRuntime.prototype;
		const { FERRY_PROVIDERS } = await import("./config.mjs");
		const onlyFerry = (list) => (Array.isArray(list) ? list.filter((m) => FERRY_PROVIDERS.has(m?.provider)) : list);
		const snap = P.getAvailableSnapshot;
		P.getAvailableSnapshot = function getAvailableSnapshot(...a) {
			return onlyFerry(snap.apply(this, a));
		};
		const avail = P.getAvailable;
		P.getAvailable = async function getAvailable(...a) {
			return onlyFerry(await avail.apply(this, a));
		};
		result.onlyFerry = true;
	} catch {
		// laid out differently: pi's list stays
	}
	return result;
}
