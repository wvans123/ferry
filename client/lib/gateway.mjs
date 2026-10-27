// A company web gateway sometimes stops a site until someone confirms in a browser ("访问提醒" / proxycontrolwarn).
// Ferry does not click through it. It opens the gateway's page in your browser, waits while you confirm,
// and carries on as soon as the server answers.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

/** A company gateway's warning or block page, recognised by its address or its text. */
export function gatewayPage(url, text = "") {
	return /proxycontrol|proxy[-_]?warn|warnpage|webfilter|urlfilter|blockpage|access[-_]?denied|safebrowse/i.test(url ?? "")
		|| /(访问提醒|上网行为|访问受限|该网站被|继续访问|网址过滤|URL Filtering|Web Page Blocked|has been blocked by|Continue to site)/i.test(text.slice(0, 5000));
}

export function openInBrowser(url) {
	if (process.env.FERRY_TEST_OPENED_FILE) { // self-test: stands for the user confirming in the browser
		writeFileSync(process.env.FERRY_TEST_OPENED_FILE, url, "utf8");
		return true;
	}
	if (process.env.FERRY_NO_BROWSER) return false;
	try {
		const [cmd, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] // & in URLs is safe here
			: process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
		spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
		return true;
	} catch {
		return false;
	}
}

/** The gateway page a response points at, or "". r: { status, location, body } as from getJson. */
export function gatewayOf(r) {
	if (r.status >= 300 && r.status < 400 && gatewayPage(r.location)) return r.location;
	if (typeof r.body === "string" && r.body.length < 30000 && gatewayPage("", r.body)) return "(the page shown instead of the server)";
	return "";
}

/**
 * Open the gateway page and wait (up to waitMs) until check() says the server answers.
 * Returns true when it got through.
 */
export async function waitThroughGateway(page, server, check, { waitMs = 180000, say = (m) => process.stderr.write(`${m}\n`) } = {}) {
	const opened = /^https?:/.test(page) && openInBrowser(page);
	say(`The company network gateway wants a confirmation before ${new URL(server).hostname} can be used.`);
	say(opened ? `Opened it in your browser: confirm there (for example "继续访问"), and Ferry carries on by itself.`
		: `Open this address in a browser and confirm there; Ferry carries on by itself:\n  ${page}`);
	say("If the gateway does not let you confirm, ask IT to allow this address. Waiting (Ctrl+C to stop)...");
	const end = Date.now() + waitMs;
	while (Date.now() < end) {
		await new Promise((r) => setTimeout(r, 2500));
		if (await check()) {
			say("Through. Starting.");
			return true;
		}
	}
	return false;
}
