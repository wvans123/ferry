// Ferry header in the terminal UI
import { existsSync, readdirSync } from "node:fs";
import { scopeDir } from "./memory.mjs";

function memoryCount(cwd) {
	let n = 0;
	for (const d of [scopeDir("user", cwd), scopeDir("project", cwd)]) {
		if (existsSync(d)) n += readdirSync(d).filter((f) => f.endsWith(".md") && f !== "MEMORY.md").length;
	}
	return n;
}

export function createBrand(cfg, version) {
	return (pi) => {
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			const host = cfg.mode === "local" ? "on this computer" : cfg.server.replace(/^https?:\/\//, "");
			const features = [
				cfg.memory === false ? "memory off" : `memory: ${memoryCount(ctx.cwd ?? process.cwd())} (/memory)`,
				cfg.subagents === false ? "subagents off" : "subagents on",
				"ferry config to change",
			].join("  ·  ");
			ctx.ui.setHeader((_tui, theme) => ({
				render() {
					return [
						"",
						`  ${theme.fg("accent", "Ferry")}${theme.fg("dim", ` v${version}`)}  ${theme.fg("muted", `server ${host}`)}`,
						theme.fg("dim", "  Files and history stay on this machine. The server builds the prompt and calls the model."),
						theme.fg("dim", `  ${features}`),
						"",
					];
				},
				invalidate() {},
			}));
		});
	};
}
