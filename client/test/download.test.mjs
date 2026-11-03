import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { downloadFile } from "../lib/web.mjs";

test("web_download saves a file in the project, unpacks a zip, and refuses pages and outside paths", async () => {
	const zip = Buffer.from(zipSync({ "23501-j40.docx": strToU8("not really a docx"), "../evil.txt": strToU8("x") }));
	const srv = createServer((req, res) => {
		if (req.url === "/ftp/old.zip") return res.writeHead(302, { location: "/ftp/23501-j40.zip" }), res.end();
		if (req.url === "/ftp/23501-j40.zip") return res.writeHead(200, { "content-type": "application/zip", "content-length": zip.length }), res.end(zip);
		res.writeHead(200, { "content-type": "text/html" });
		res.end("<html><body><a href='/ftp/23501-j40.zip'>23501-j40.zip</a></body></html>");
	});
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const base = `http://127.0.0.1:${srv.address().port}`;
	const cwd = mkdtempSync(join(tmpdir(), "ferry-dl-"));
	try {
		const r = await downloadFile(`${base}/ftp/old.zip`, { cwd });
		assert.equal(r.path, join("downloads", "23501-j40.zip"));
		assert.deepEqual(r.files, [join("downloads", "23501-j40", "23501-j40.docx")]);
		assert.equal(readFileSync(join(cwd, r.files[0]), "utf8"), "not really a docx");
		assert.ok(!existsSync(join(cwd, "downloads", "evil.txt")));
		await assert.rejects(downloadFile(`${base}/ftp/`, { cwd }), /web page, not a file/);
		await assert.rejects(downloadFile(`${base}/ftp/23501-j40.zip`, { cwd, dest: "../outside.zip" }), /inside the project folder/);
		const small = await downloadFile(`${base}/ftp/23501-j40.zip`, { cwd, dest: "specs/", unzip: false });
		assert.equal(small.path, join("specs", "23501-j40.zip"));
		assert.equal(small.files.length, 0);
	} finally {
		srv.close();
	}
});
