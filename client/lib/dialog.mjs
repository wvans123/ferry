// Viewport-fitted interactive selector dialog for Ferry's TUI.
//
// Pi's built-in ExtensionSelectorComponent renders the entire `title` text above `options` with no height cap.
// Whenever a permission command or skill-sync preview exceeds the terminal's height, the bottom choice buttons get
// clipped off-screen (or overflow terminal scrollback) and ↑/↓ or the mouse wheel cannot reach them.
//
// FerrySelectDialog guarantees `render(width).length <= terminal.rows - 5` on every frame:
//   - Choice buttons stay pinned and visible at the bottom at all times (1 row per visible option).
//   - Long `title` details sit inside an internal scrollable window above the buttons:
//     ←/→, PgUp/PgDn, Home/End, `[`/`]` and mouse wheel scroll the details; ↑/↓ and 1-9 move between buttons.
import {
	CURSOR_MARKER,
	matchesKey,
	replaceControlCharacters,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const PATCHED = new WeakSet();

/** Split and wrap multi-line text to `width` columns, preserving blank lines. */
export function wrapBodyLines(text, width) {
	const safeWidth = Math.max(4, Math.floor(width));
	const rawLines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
	const out = [];
	for (const raw of rawLines) {
		const clean = replaceControlCharacters(raw);
		if (!clean) {
			out.push("");
			continue;
		}
		const wrapped = wrapTextWithAnsi(clean, safeWidth);
		if (wrapped.length) out.push(...wrapped);
		else out.push("");
	}
	return out.length ? out : [""];
}

/** Compute visible window [start, end) of length <= maxVisible centered around index. */
function windowRange(index, total, maxVisible) {
	if (total <= maxVisible) return { start: 0, end: total };
	const start = Math.max(0, Math.min(index - Math.floor(maxVisible / 2), total - maxVisible));
	return { start, end: Math.min(total, start + maxVisible) };
}

export class FerrySelectDialog {
	constructor(title, options, { tui, theme, keybindings, done, timeout }) {
		this.baseTitle = String(title ?? "");
		this.options = options;
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.done = done;
		this.selectedIndex = 0;
		this.bodyScroll = 0;
		this.lastLayout = { bodyLines: 1, bodyMaxRows: 1, optStart: 0, optEnd: options.length, optRowStart: 0, optRowEnd: 0 };
		this.remainingSeconds = timeout && timeout > 0 ? Math.ceil(timeout / 1000) : 0;
		this.timer = null;
		if (this.remainingSeconds > 0) {
			this.timer = setInterval(() => {
				this.remainingSeconds -= 1;
				if (this.remainingSeconds <= 0) {
					this.dispose();
					this.done(undefined);
				} else {
					this.tui?.requestRender?.();
				}
			}, 1000);
			this.timer.unref?.();
		}
	}

	fg(color, text) {
		return this.theme?.fg ? this.theme.fg(color, text) : text;
	}

	bold(text) {
		return this.theme?.bold ? this.theme.bold(text) : text;
	}

	termRows() {
		const r = this.tui?.terminal?.rows ?? process.stdout?.rows ?? 28;
		return Number.isFinite(r) && r > 0 ? r : 28;
	}

	render(width) {
		const safeWidth = Math.max(12, Math.floor(width));
		const innerWidth = Math.max(8, safeWidth - 2);
		// Keep at least 5 rows for footer/status/context so the dialog always fits within one viewport.
		const maxTotalRows = Math.max(9, this.termRows() - 5);

		// Reserve 4 chrome rows: top border, separator/scroll bar, key hints, bottom border.
		const availContentRows = Math.max(5, maxTotalRows - 4);
		const maxOptVisible = Math.max(2, Math.min(this.options.length, 8, Math.floor(availContentRows * 0.55)));
		const { start: optStart, end: optEnd } = windowRange(this.selectedIndex, this.options.length, maxOptVisible);
		const hasOptOverflow = optStart > 0 || optEnd < this.options.length;
		const optRowsCount = (optEnd - optStart) + (hasOptOverflow ? 1 : 0);

		const bodyMaxRows = Math.max(2, availContentRows - optRowsCount);
		const titleText = this.remainingSeconds > 0 ? `${this.baseTitle} (${this.remainingSeconds}s)` : this.baseTitle;
		const bodyAll = wrapBodyLines(titleText, innerWidth);
		const maxScroll = Math.max(0, bodyAll.length - bodyMaxRows);
		if (this.bodyScroll > maxScroll) this.bodyScroll = maxScroll;
		if (this.bodyScroll < 0) this.bodyScroll = 0;

		const bodySlice = bodyAll.slice(this.bodyScroll, this.bodyScroll + bodyMaxRows);
		const hasBodyOverflow = bodyAll.length > bodyMaxRows;

		const lines = [];
		const pushLine = (raw, withCursor = false) => {
			const clean = withCursor ? raw.replaceAll(CURSOR_MARKER, "") : raw;
			const fitted = visibleWidth(clean) > safeWidth ? truncateToWidth(clean, safeWidth, "…") : clean;
			lines.push(withCursor ? `${CURSOR_MARKER}${fitted}` : fitted);
		};

		// 1. Top border
		pushLine(this.fg("border", "─".repeat(safeWidth)));

		// 2. Body lines (first line highlighted as header; rest readable text)
		bodySlice.forEach((bLine, idx) => {
			const globalIdx = this.bodyScroll + idx;
			const styled = globalIdx === 0 ? this.fg("accent", this.bold(bLine)) : this.fg("text", bLine);
			pushLine(` ${styled}`);
		});

		// 3. Separator / body scroll indicator right above the choice buttons
		if (hasBodyOverflow) {
			const from = this.bodyScroll + 1;
			const to = Math.min(bodyAll.length, this.bodyScroll + bodySlice.length);
			pushLine(this.fg("warning", ` ── 详情第 ${from}-${to} / ${bodyAll.length} 行（←/→ 或 PgUp/PgDn 或滚轮翻页） ──`));
		} else {
			lines.push("");
		}

		// 4. Always-visible choice buttons
		const optRowStart = lines.length;
		const numbered = this.options.length <= 9;
		for (let i = optStart; i < optEnd; i++) {
			const isSelected = i === this.selectedIndex;
			const singleLine = replaceControlCharacters(String(this.options[i] ?? "").replace(/\s*\n\s*/g, " "));
			const numPrefix = numbered && !/^\d+[.)]\s|^\[[ xX]\]/.test(singleLine) ? `${i + 1}. ` : "";
			const rawOption = truncateToWidth(`${numPrefix}${singleLine}`, Math.max(4, safeWidth - 4), "…");
			if (isSelected) {
				pushLine(` ${this.fg("accent", "→ ")}${this.fg("accent", this.bold(rawOption))}`, true);
			} else {
				pushLine(`   ${this.fg("text", rawOption)}`);
			}
		}
		const optRowEnd = lines.length;
		if (hasOptOverflow) {
			pushLine(this.fg("muted", `   (选项 ${this.selectedIndex + 1}/${this.options.length}，↑↓ 继续翻选)`));
		}

		// 5. Keybinding hints + bottom border
		const hintParts = ["↑↓ 选按钮"];
		if (numbered) hintParts.push(`1-${this.options.length} 快选`);
		if (hasBodyOverflow) hintParts.push("←→/滚轮 翻看详情");
		hintParts.push("Enter 确认", "Esc 取消");
		pushLine(this.fg("muted", ` ${hintParts.join("  •  ")}`));
		pushLine(this.fg("border", "─".repeat(safeWidth)));

		this.lastLayout = {
			bodyLines: bodyAll.length,
			bodyMaxRows,
			maxScroll,
			optStart,
			optEnd,
			optRowStart,
			optRowEnd,
		};
		return lines;
	}

	scrollBodyBy(delta) {
		const maxScroll = Math.max(0, (this.lastLayout.bodyLines ?? 1) - (this.lastLayout.bodyMaxRows ?? 1));
		if (maxScroll <= 0) return false;
		const next = Math.max(0, Math.min(maxScroll, this.bodyScroll + delta));
		if (next === this.bodyScroll) return false;
		this.bodyScroll = next;
		return true;
	}

	moveSelection(delta) {
		const n = this.options.length;
		if (!n) return;
		this.selectedIndex = (this.selectedIndex + delta + n) % n;
	}

	handleMouse(event) {
		if (!event || !this.options.length) return undefined;
		if (event.type === "wheel" && event.wheelDelta) {
			const step = event.wheelDelta < 0 ? -1 : 1;
			const overOptions = typeof event.y === "number" && event.y >= this.lastLayout.optRowStart;
			const hasOptOverflow = this.lastLayout.optStart > 0 || this.lastLayout.optEnd < this.options.length;
			if (!overOptions && this.scrollBodyBy(step * 3)) {
				return { handled: true, render: true };
			}
			if (hasOptOverflow || overOptions) {
				this.moveSelection(step);
				return { handled: true, render: true };
			}
			if (this.scrollBodyBy(step * 3)) {
				return { handled: true, render: true };
			}
			return { handled: true, render: false };
		}
		if (event.button === "left" && (event.type === "press" || event.type === "click")) {
			const row = event.y;
			if (typeof row === "number" && row >= this.lastLayout.optRowStart && row < this.lastLayout.optRowEnd) {
				const idx = this.lastLayout.optStart + (row - this.lastLayout.optRowStart);
				if (idx >= 0 && idx < this.options.length) {
					this.selectedIndex = idx;
					if (event.type === "click") {
						const chosen = this.options[idx];
						this.dispose();
						this.done(chosen);
					}
					return { handled: true, focus: true, render: true };
				}
			}
		}
		return undefined;
	}

	handleInput(data) {
		const kb = this.keybindings;
		const pageStep = Math.max(1, (this.lastLayout.bodyMaxRows ?? 6) - 1);
		const hasBodyOverflow = (this.lastLayout.bodyLines ?? 0) > (this.lastLayout.bodyMaxRows ?? 1);

		if (kb?.matches?.(data, "tui.select.cancel") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.dispose();
			this.done(undefined);
			return;
		}
		if (kb?.matches?.(data, "tui.select.confirm") || data === "\r" || data === "\n" || matchesKey(data, "enter")) {
			const selected = this.options[this.selectedIndex];
			this.dispose();
			this.done(selected);
			return;
		}
		if (kb?.matches?.(data, "tui.select.up") || matchesKey(data, "up") || data === "k") {
			this.moveSelection(-1);
			return;
		}
		if (kb?.matches?.(data, "tui.select.down") || matchesKey(data, "down") || data === "j") {
			this.moveSelection(1);
			return;
		}
		if (matchesKey(data, "left") || data === "[") {
			this.scrollBodyBy(-pageStep);
			return;
		}
		if (matchesKey(data, "right") || data === "]") {
			this.scrollBodyBy(pageStep);
			return;
		}
		if (matchesKey(data, "pageUp") || kb?.matches?.(data, "tui.select.pageUp")) {
			if (!hasBodyOverflow || !this.scrollBodyBy(-pageStep)) {
				this.selectedIndex = Math.max(0, this.selectedIndex - 6);
			}
			return;
		}
		if (matchesKey(data, "pageDown") || kb?.matches?.(data, "tui.select.pageDown")) {
			if (!hasBodyOverflow || !this.scrollBodyBy(pageStep)) {
				this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 6);
			}
			return;
		}
		if (matchesKey(data, "home") || data === "g") {
			this.bodyScroll = 0;
			return;
		}
		if (matchesKey(data, "end") || data === "G") {
			this.bodyScroll = Math.max(0, (this.lastLayout.bodyLines ?? 1) - (this.lastLayout.bodyMaxRows ?? 1));
			return;
		}
		if (/^[1-9]$/.test(data)) {
			const idx = Number(data) - 1;
			if (idx < this.options.length) this.selectedIndex = idx;
		}
	}

	invalidate() {}

	dispose() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}

/** Run FerrySelectDialog when ui.custom is available; fall back to native ui.select in unit-test mocks. */
export async function selectDialog(ui, title, options, opts, fallbackSelect) {
	if (!Array.isArray(options) || options.length === 0) return undefined;
	if (opts?.signal?.aborted) return undefined;
	if (typeof ui?.custom !== "function") {
		return fallbackSelect ? fallbackSelect(title, options, opts) : ui?.select?.(title, options, opts);
	}
	return new Promise((resolve) => {
		let closeFn = null;
		let dialog = null;
		let settled = false;
		const finish = (val) => {
			if (settled) return;
			settled = true;
			opts?.signal?.removeEventListener("abort", onAbort);
			dialog?.dispose();
			resolve(val);
		};
		const onAbort = () => {
			if (closeFn) closeFn(undefined);
			else finish(undefined);
		};
		opts?.signal?.addEventListener("abort", onAbort, { once: true });
		ui.custom((tui, theme, keybindings, done) => {
			closeFn = done;
			dialog = new FerrySelectDialog(title, options, {
				tui,
				theme,
				keybindings,
				timeout: opts?.timeout,
				done: (val) => {
					done(val);
					finish(val);
				},
			});
			if (opts?.signal?.aborted) queueMicrotask(() => done(undefined));
			return dialog;
		}, { blocked: { kind: "question", message: String(title ?? "").slice(0, 200) } }).then(finish, () => finish(undefined));
	});
}

/** Patch ctx.ui.select once per UI context so every Ferry dialog (permissions, /sync, ask_user, /config, etc.) fits on screen. */
export function patchUISelect(ui) {
	if (!ui || typeof ui.select !== "function" || typeof ui.custom !== "function" || PATCHED.has(ui)) return ui;
	const origSelect = ui.select.bind(ui);
	ui.select = (title, options, opts) => selectDialog(ui, title, options, opts, origSelect);
	PATCHED.add(ui);
	return ui;
}

export function createDialogs() {
	return (pi) => {
		pi.on("session_start", (_e, ctx) => {
			if (ctx?.hasUI && ctx.ui) patchUISelect(ctx.ui);
		});
	};
}
