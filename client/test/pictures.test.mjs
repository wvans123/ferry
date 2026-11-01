import assert from "node:assert/strict";
import { test } from "node:test";
import { fitPictures, smaller } from "../lib/pictures.mjs";

async function bigPng(w = 2400, h = 1600) {
	const index = import.meta.resolve("@earendil-works/pi-coding-agent");
	const { loadPhoton } = await import(new URL("./utils/photon.js", index).href);
	const photon = await loadPhoton();
	const px = new Uint8Array(w * h * 4);
	for (let i = 0; i < px.length; i++) px[i] = (i * 2654435761) >>> 24; // noise: does not compress
	const img = new photon.PhotonImage(px, w, h);
	const b64 = Buffer.from(img.get_bytes()).toString("base64");
	img.free();
	return b64;
}

test("a big screenshot is made smaller before it is sent, the same way every time", async () => {
	const b64 = await bigPng();
	assert.ok(b64.length > 1_000_000);
	const a = await smaller(b64, "image/png");
	const b = await smaller(b64, "image/png");
	assert.ok(a.data.length <= 300 * 1024, `still ${a.data.length}`);
	assert.equal(a.data, b.data);
});

test("only the latest pictures stay; older ones become a note", async () => {
	const pic = (n) => ({ type: "image", source: { type: "base64", media_type: "image/png", data: `AAAA${n}` } });
	const msgs = [
		{ role: "user", content: [{ type: "text", text: "look" }, pic(1)] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: [pic(2)] }] },
		{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB3" } }] },
	];
	assert.equal(await fitPictures(msgs, 2), 3);
	assert.match(msgs[0].content[1].text, /picture was left out/);
	assert.equal(msgs[1].content[0].content[0].source.data, "AAAA2");
	assert.match(msgs[2].content[0].image_url.url, /BBBB3$/);
});
