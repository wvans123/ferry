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

const titleOf = (html) => (/<title[^>]*>([^<]{1,120})/i.exec(html ?? "")?.[1] ?? "").replace(/\s+/g, " ").trim();

/**
 * Who answered instead of the Ferry server, in one sentence: Cloudflare's bot protection, Cloudflare Access, the
 * company gateway or proxy. r: { status, headers (a Headers or plain object), body (text) }.
 */
export function whoAnswered(r) {
	const h = (k) => (typeof r.headers?.get === "function" ? r.headers.get(k) : r.headers?.[k]) ?? "";
	const body = typeof r.body === "string" ? r.body.slice(0, 20000) : "";
	const title = titleOf(body);
	const server = h("server");
	const cloudflare = /cloudflare/i.test(server) || !!h("cf-ray");
	const page = title ? ` (page title: "${title}")` : "";
	if (h("cf-mitigated") === "challenge" || (cloudflare && /Just a moment|Attention Required|challenge-platform|cf-chl/i.test(body))) {
		return `Cloudflare's bot protection stopped the request${page}. In the Cloudflare dashboard, for the Ferry hostname: ` +
			"Security > Bots: turn off Bot Fight Mode, or Security > WAF: add a custom rule \"Hostname equals <ferry host> -> Skip " +
			"(all remaining custom rules, Bot Fight Mode, Browser Integrity Check)\".";
	}
	if (cloudflare && /cloudflareaccess|cf-access|Cloudflare Access/i.test(`${h("location")} ${body}`)) {
		return "a Cloudflare Access login answered instead of the Ferry server: remove the Access policy from this hostname or use a service token (ferry login ... --header).";
	}
	if (cloudflare) return `Cloudflare answered HTTP ${r.status}${page} (ray ${h("cf-ray") || "?"}): look at Security > Events in the Cloudflare dashboard.`;
	if (gatewayPage(h("location"), body)) return `the company network gateway answered HTTP ${r.status}${page}.`;
	const via = h("via") || h("proxy-agent") || server;
	return `something between this computer and the Ferry server answered HTTP ${r.status}${via ? ` (${via})` : ""}${page}: ` +
		"probably the company proxy or gateway.";
}
