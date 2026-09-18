/**
 * Rewrites package-lock.json with SHA-512 integrity and canonical registry URLs.
 *
 * The machine this repo is developed on resolves npm through a corporate proxy
 * that strips `dist.integrity` from the packument and serves only the legacy
 * SHA-1 `shasum`, so every one of the 213 entries recorded `sha1-`. npm accepts
 * any tarball matching a SHA-1 digest, which is materially weaker than its own
 * default, and it covers build-time code that executes. registry.npmjs.org is
 * not reachable from here, so the lockfile cannot simply be regenerated.
 *
 * Integrity is just the hash of the tarball, so this downloads each one through
 * the proxy, verifies it against the SHA-1 already recorded - proving it is the
 * artefact the lockfile already described - and records the SHA-512 of those
 * same bytes. `resolved` is repointed at registry.npmjs.org, both so the public
 * repo stops advertising internal feed URLs and so CI verifies these digests
 * against npm's own tarballs. A mismatch there fails the build loudly.
 *
 * npm rewrites the host of a registry.npmjs.org URL to whatever registry is
 * configured, so this keeps working behind the proxy too.
 *
 * Run with: node tools/relock-integrity.mjs
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const LOCK = "package-lock.json";
const CANONICAL = "https://registry.npmjs.org";
const PROXY = "https://packagefeedproxy.microsoft.io/npm";
const CONCURRENCY = 12;

const lock = JSON.parse(readFileSync(LOCK, "utf8"));

/** node_modules/@scope/name -> @scope/name */
const packageName = (key) => key.replace(/^(?:.*node_modules\/)/, "");

const targets = Object.entries(lock.packages)
	.filter(([key, meta]) => key && meta.integrity && meta.resolved)
	.map(([key, meta]) => ({ key, meta, name: packageName(key) }));

console.log(`${targets.length} entries to rehash, ${CONCURRENCY} at a time\n`);

let done = 0;
let changed = 0;
const failures = [];

async function convert({ key, meta, name }) {
	// Same layout on the proxy as on the registry.
	const file = meta.resolved.slice(meta.resolved.lastIndexOf("/") + 1);
	const url = `${PROXY}/${name}/-/${file}`;

	let bytes;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			bytes = Buffer.from(await res.arrayBuffer());
			break;
		} catch (err) {
			if (attempt === 3) {
				failures.push(`${name}: ${err.message}`);
				return;
			}
			await new Promise((r) => setTimeout(r, 400 * attempt));
		}
	}

	// The tarball must be the one the lockfile already trusts, or this would be
	// laundering a substitution into a stronger-looking digest.
	if (meta.integrity.startsWith("sha1-")) {
		const sha1 = createHash("sha1").update(bytes).digest("base64");
		if (`sha1-${sha1}` !== meta.integrity) {
			failures.push(`${name}: SHA-1 mismatch, refusing to rehash`);
			return;
		}
	}

	meta.integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	meta.resolved = `${CANONICAL}/${name}/-/${file}`;
	changed++;

	if (++done % 25 === 0) console.log(`  ${done}/${targets.length}`);
}

const queue = [...targets];
await Promise.all(
	Array.from({ length: CONCURRENCY }, async () => {
		while (queue.length > 0) await convert(queue.shift());
	})
);

if (failures.length > 0) {
	console.error(`\n${failures.length} failed:`);
	for (const f of failures) console.error(`  ${f}`);
	process.exit(1);
}

writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
console.log(`\nRewrote ${changed} entries.`);
