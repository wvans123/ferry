// Move Ferry to another pi version and bump Ferry's patch version, so a release follows.
//   node scripts/bump_pi.mjs <pi version>     then: npm install
// Used by .github/workflows/update-pi.yml; prints the new Ferry version.
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
const [a, b, c] = pkg.version.split(".").map(Number);
const old = pkg.version;
pkg.version = `${a}.${b}.${c + 1}`;
writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);

const edit = (file, from, to) => {
	const p = join(root, file);
	const text = readFileSync(p, "utf8");
	if (!text.includes(from)) throw new Error(`${file}: "${from}" not found`);
	writeFileSync(p, text.replace(from, to));
};
edit("server/pyproject.toml", `version = "${old}"`, `version = "${pkg.version}"`);
edit("server/ferry_server/__init__.py", `__version__ = "${old}"`, `__version__ = "${pkg.version}"`);
console.log(pkg.version);
