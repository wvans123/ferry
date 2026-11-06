// Move Ferry to another pi version. Ferry's own version is left alone: releases are batched (scripts/bump.py).
//   node scripts/bump_pi.mjs <pi version>     then: npm install
// Used by .github/workflows/update-pi.yml.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pi = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(pi ?? "")) {
	console.error("usage: node scripts/bump_pi.mjs <pi version, e.g. 1.5.0>");
	process.exit(2);
}
const pkgFile = join(root, "package.json");
const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
for (const deps of [pkg.dependencies, pkg.overrides]) {
	for (const name of Object.keys(deps ?? {})) if (name.startsWith("@earendil-works/")) deps[name] = pi;
}
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
