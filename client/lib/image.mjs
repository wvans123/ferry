// image_create: the agent draws a picture (a diagram for slides, an illustration, a mock-up) and saves it in the
// project. The Ferry server's "生成图片用" model draws it (routing.image); the tool is offered only when the server
// has one. Reference pictures (to edit or follow) are sent along, within the upload limit.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve } from "node:path";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { serverHeaders } from "./config.mjs";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
const REF_BYTES = 700 * 1024; // reference pictures together: the request must stay under the 1 MB upload rule

export function createImage(cfg) {
	return (pi) => {
		if (!(cfg.features ?? []).includes("image")) return;
		pi.registerTool({
			name: "image_create",
			label: "Image",
			description: "Draw a picture from a description and save it as a PNG file: an illustration, an icon, a diagram-like " +
				"figure for slides or documents, a UI mock-up. Describe it fully (subject, style, layout, colours, any text in " +
				"it). Optionally give reference pictures from the project to edit or follow (small files only). The file is " +
				"saved at `path`; insert it into documents or slides afterwards with the office tools if needed.",
			promptSnippet: "Draw a picture from a description and save it as a PNG in the project",
			parameters: Type.Object({
				prompt: Type.String({ description: "What to draw, in detail" }),
				path: Type.String({ description: "Where to save it, e.g. images/architecture.png" }),
				size: Type.Optional(StringEnum(["auto", "1024x1024", "1536x1024", "1024x1536"], { description: "Default auto" })),
				references: Type.Optional(Type.Array(Type.String(), { description: "Project pictures to edit or follow (png/jpg/webp)" })),
			}),
			async execute(_id, p, signal, _onUpdate, ctx) {
				const cwd = ctx?.cwd ?? process.cwd();
				const at = (f) => (isAbsolute(f) ? f : resolve(cwd, f));
				const images = [];
				let bytes = 0;
				for (const f of p.references ?? []) {
					const mime = MIME[extname(f).toLowerCase()];
					if (!mime) throw new Error(`${f}: only png, jpg, webp or gif pictures can be references`);
					bytes += statSync(at(f)).size;
					if (bytes > REF_BYTES) throw new Error("The reference pictures are too big to send (the limit is about 700 KB together); use smaller ones");
					images.push(`data:${mime};base64,${readFileSync(at(f)).toString("base64")}`);
				}
				const res = await fetch(`${cfg.server}/v1/ferry/image`, {
					method: "POST", signal: signal ?? AbortSignal.timeout(600000), redirect: "manual",
					headers: serverHeaders(cfg, { "Content-Type": "application/json" }),
					body: JSON.stringify({ prompt: p.prompt, size: p.size ?? "auto", images }),
				});
				const out = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
				if (!res.ok || !out?.images?.length) throw new Error(`The picture was not made: ${out?.error ?? `HTTP ${res.status}`}`);
				const file = at(p.path.toLowerCase().endsWith(".png") ? p.path : `${p.path}.png`);
				mkdirSync(dirname(file), { recursive: true });
				const data = Buffer.from(out.images[0].b64, "base64");
				writeFileSync(file, data);
				const kb = Math.round(data.length / 1024);
				return { content: [{ type: "text", text: `Saved ${file} (${kb} KB, drawn by ${out.model}).` +
					(out.images[0].revised_prompt ? ` The model drew: ${out.images[0].revised_prompt.slice(0, 300)}` : "") }],
					details: { path: file } };
			},
		});
	};
}
