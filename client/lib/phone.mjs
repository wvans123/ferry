// Phone notifications, sent by the Ferry server (admin page > 设置 > 手机通知, Bark for iPhone).
// The client only says what happened, in a short line without the conversation's content:
//   a /goal finished or needs you, a long request is done, an approval has been waiting for a while.
import { basename } from "node:path";
import { serverHeaders } from "./config.mjs";

export function phoneNotifier(cfg) {
	return (title, body, kind = "") => {
		if (cfg.phoneNotify === false || !cfg.server) return;
		const project = basename(process.cwd());
		fetch(`${cfg.server}/v1/ferry/notify`, {
			method: "POST",
			headers: serverHeaders(cfg, { "Content-Type": "application/json" }),
			body: JSON.stringify({ title: `Ferry · ${project}`.slice(0, 60), body: `${title}${body ? `: ${body}` : ""}`.slice(0, 300), kind }),
			signal: AbortSignal.timeout(15000),
		}).catch(() => {}); // a notification that does not arrive must not disturb the work
	};
}
