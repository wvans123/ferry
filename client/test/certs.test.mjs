import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

test("the company certificates also reach the agent's commands (curl, git, Python)", { skip: typeof tls.setDefaultCACertificates !== "function" }, async () => {
	const home = mkdtempSync(join(tmpdir(), "ferry-certs-"));
	process.env.FERRY_HOME = home;
	for (const k of ["CURL_CA_BUNDLE", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "GIT_SSL_CAINFO", "NODE_EXTRA_CA_CERTS"]) delete process.env[k];
	const ca = join(home, "company.pem");
	writeFileSync(ca, tls.rootCertificates[0]); // stands for the company's own certificate
	const { trustCertificates } = await import(`../lib/config.mjs?certs=${Date.now()}`);
	assert.ok(trustCertificates({ systemCerts: false, caFile: ca }) >= 1);
	const bundle = join(home, "ca-bundle.pem");
	assert.equal(process.env.CURL_CA_BUNDLE, bundle);
	assert.equal(process.env.SSL_CERT_FILE, bundle);
	assert.ok(readFileSync(bundle, "utf8").split("BEGIN CERTIFICATE").length - 1 >= tls.getCACertificates("default").length);
});
