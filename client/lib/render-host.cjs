// Runs inside Electron, started by render.mjs: opens web pages in a hidden window, lets their scripts run, and
// sends back what the page shows. One JSON request per line on stdin, one JSON answer per line on stdout.
//   request:  {"id":1,"url":"https://...","waitMs":12000,"blocked":["mail.example.com"],"proxy":"http://host:port"}
//   answer:   {"id":1,"ok":true,"url":"<final address>","title":"...","html":"...","text":"<innerText>"}
//             {"id":1,"ok":false,"error":"...","blocked":"<host>"}
// Every page gets a fresh in-memory session: no cookies, logins or cache are kept between pages or on disk.
// Downloads, pop-up windows, permission requests (camera, location, notifications...) are refused.
// The process quits by itself after two idle minutes, or when stdin closes (the ferry window ended).
const { app, BrowserWindow, session } = require("electron");

const IDLE_MS = 120_000;
const MAX_HTML = 3_000_000;
let pageNo = 0;
let idle = null;

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("mute-audio");
if (app.dock) app.dock.hide();
app.on("window-all-closed", () => {}); // keep running between pages

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function armIdle() {
	clearTimeout(idle);
	idle = setTimeout(() => app.quit(), IDLE_MS);
}

/** "mail.corp.com" is blocked by "corp.com" or "mail.corp.com" in the list, not by "il.corp.com". */
function blockedBy(host, list) {
	host = String(host || "").toLowerCase().replace(/\.$/, "");
	return (list || []).find((d) => {
		d = String(d).toLowerCase().trim().replace(/^\*?\./, "").replace(/\/.*$/, "");
		return d && (host === d || host.endsWith(`.${d}`));
	});
}

async function render(req) {
	const part = `ferry-render-${process.pid}-${++pageNo}`; // no "persist:" prefix: memory only
	const ses = session.fromPartition(part, { cache: false });
	if (req.proxy) await ses.setProxy({ proxyRules: req.proxy, proxyBypassRules: ["<local>", req.bypass].filter(Boolean).join(",") });
	let blockedMain = "";
	ses.webRequest.onBeforeRequest((details, done) => {
		let host = "";
		try {
			host = new URL(details.url).hostname;
		} catch {
			// data:, blob: and the like
		}
		const hit = host && blockedBy(host, req.blocked);
		if (hit && details.resourceType === "mainFrame") blockedMain = host;
		done({ cancel: Boolean(hit) });
	});
	ses.setPermissionRequestHandler((_wc, _perm, done) => done(false));
	ses.setPermissionCheckHandler(() => false);
	ses.on("will-download", (e) => e.preventDefault());

	const win = new BrowserWindow({
		show: false, width: 1280, height: 900,
		webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false,
			backgroundThrottling: false, spellcheck: false },
	});
	const wc = win.webContents;
	wc.setAudioMuted(true);
	wc.setWindowOpenHandler(() => ({ action: "deny" }));
	wc.on("will-prevent-unload", (e) => e.preventDefault());
	const waitMs = Math.max(2000, Math.min(Number(req.waitMs) || 12000, 60000));
	const started = Date.now();
	try {
		let loadError = "";
		await Promise.race([
			wc.loadURL(req.url).catch((e) => { loadError = e.message || String(e); }),
			sleep(waitMs),
		]);
		if (blockedMain) return { ok: false, blocked: blockedMain, error: `${blockedMain} is on the blocked sites list` };
		// let the page's scripts fill it in: wait until the visible text stops changing (or the time is up)
		let last = -1;
		let steady = 0;
		while (Date.now() - started < waitMs && steady < 3) {
			await sleep(400);
			const n = await wc.executeJavaScript("document.body ? document.body.innerText.length : 0", true).catch(() => -1);
			steady = n > 0 && n === last ? steady + 1 : 0;
			last = n;
		}
		if (blockedMain) return { ok: false, blocked: blockedMain, error: `${blockedMain} is on the blocked sites list` };
		const page = await wc.executeJavaScript(`({ url: location.href, title: document.title,
			html: document.documentElement ? document.documentElement.outerHTML.slice(0, ${MAX_HTML}) : "",
			text: document.body ? document.body.innerText : "" })`, true).catch((e) => ({ error: e.message }));
		if (page.error || (!page.html && loadError)) return { ok: false, error: loadError || page.error };
		return { ok: true, ...page, ms: Date.now() - started };
	} finally {
		win.destroy();
		ses.clearStorageData().catch(() => {});
		ses.clearCache().catch(() => {});
	}
}

app.whenReady().then(() => {
	armIdle();
	let buf = "";
	let chain = Promise.resolve(); // one page at a time
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk) => {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf("\n")) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line) continue;
			let req;
			try {
				req = JSON.parse(line);
			} catch {
				continue;
			}
			chain = chain.then(async () => {
				clearTimeout(idle);
				const r = await render(req).catch((e) => ({ ok: false, error: e.message || String(e) }));
				send({ id: req.id, ...r });
				armIdle();
			});
		}
	});
	process.stdin.on("end", () => app.quit());
	send({ ready: true, electron: process.versions.electron });
});
