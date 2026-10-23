// Ferry header in the terminal UI
export function createBrand(cfg, version) {
	return (pi) => {
		pi.on("session_start", async (_event, ctx) => {
			if (ctx.mode !== "tui") return;
			const host = cfg.mode === "local" ? "on this computer" : cfg.server.replace(/^https?:\/\//, "");
			ctx.ui.setHeader((_tui, theme) => ({
				render() {
					return [
						"",
						`  ${theme.fg("accent", "Ferry")}${theme.fg("dim", ` v${version}`)}  ${theme.fg("muted", `server ${host}`)}`,
						theme.fg("dim", "  Files and history stay on this machine. The server builds the prompt and calls the model."),
						"",
					];
				},
				invalidate() {},
			}));
		});
	};
}
