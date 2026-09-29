import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ensureExecutable, EXECUTABLE_MODE, type ExecFs, octal } from "../src/sidecar-exec";

/** Records what was asked of the filesystem, and answers with a fixed mode. */
function fakeFs(mode: number | Error, onChmod?: Error): ExecFs & { chmodded: string[] } {
	const chmodded: string[] = [];
	return {
		chmodded,
		mode: (file) => {
			if (mode instanceof Error) throw mode;
			void file;
			return mode;
		},
		makeExecutable: (file) => {
			if (onChmod) throw onChmod;
			chmodded.push(file);
		}
	};
}

describe("ensureExecutable", () => {
	it("restores the bit on a sidecar packaging left at 0644", () => {
		// The whole bug: streamdeck pack writes every zip entry 0644, Stream
		// Deck extracts it as written, and the helper cannot be spawned.
		const fs = fakeFs(0o644);
		const result = ensureExecutable("/plugin/TeamsBridge", "darwin", fs);

		expect(result).toEqual({ outcome: "repaired", from: 0o644 });
		expect(fs.chmodded).toEqual(["/plugin/TeamsBridge"]);
	});

	it("leaves an already-executable sidecar alone", () => {
		// A sideloaded build keeps its bit, and so does one this already fixed
		// - the repair runs on every spawn, so it must not rewrite the mode
		// each restart.
		const fs = fakeFs(0o755);
		const result = ensureExecutable("/plugin/TeamsBridge", "darwin", fs);

		expect(result).toEqual({ outcome: "already", mode: 0o755 });
		expect(fs.chmodded).toEqual([]);
	});

	it("accepts owner-only execute rather than rewriting it", () => {
		const fs = fakeFs(0o700);
		expect(ensureExecutable("/plugin/TeamsBridge", "darwin", fs)).toEqual({
			outcome: "already",
			mode: 0o700
		});
		expect(fs.chmodded).toEqual([]);
	});

	it("repairs a mode that is executable for everyone except its owner", () => {
		// 0o655 would spawn for nobody who matters: the plugin and the helper
		// run as the user who owns the extracted folder.
		const fs = fakeFs(0o655);
		expect(ensureExecutable("/plugin/TeamsBridge", "darwin", fs)).toEqual({
			outcome: "repaired",
			from: 0o655
		});
	});

	it("does nothing at all on Windows", () => {
		// There is no execute bit to lose, and Node's chmod there only toggles
		// the read-only attribute - which would make the sidecar unwritable by
		// the next upgrade for no gain.
		const fs = fakeFs(0o644);
		expect(ensureExecutable("C:\\plugin\\TeamsBridge.exe", "win32", fs)).toEqual({
			outcome: "unnecessary"
		});
		expect(fs.chmodded).toEqual([]);
	});

	it("reports a mode it cannot read without throwing", () => {
		// The caller spawns regardless: a mode this failed to read may still be
		// fine, and an exception here would take the whole bridge down.
		const fs = fakeFs(new Error("ENOENT: no such file or directory"));
		expect(ensureExecutable("/plugin/gone", "darwin", fs)).toEqual({
			outcome: "failed",
			reason: "ENOENT: no such file or directory"
		});
	});

	it("reports a chmod it cannot perform without throwing", () => {
		const fs = fakeFs(0o644, new Error("EPERM: operation not permitted"));
		expect(ensureExecutable("/plugin/TeamsBridge", "darwin", fs)).toEqual({
			outcome: "failed",
			reason: "EPERM: operation not permitted"
		});
	});
});

describe("octal", () => {
	it("prints a mode the way ls -l taught people to read it", () => {
		expect(octal(0o644)).toBe("644");
		expect(octal(EXECUTABLE_MODE)).toBe("755");
	});
});

// The real filesystem, which is the part the fakes above cannot vouch for: that
// statSync's mode masks down to the permission bits and chmodSync sets the one
// that matters. Windows cannot represent any of it, so this runs on the macOS
// job in build.yml - the TypeScript suite's other home is windows-latest.
const posix = process.platform === "win32" ? describe.skip : describe;
let dir: string | undefined;

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

posix("ensureExecutable, against a real file", () => {
	const file = (mode: number): string => {
		dir ??= mkdtempSync(path.join(tmpdir(), "sidecar-exec-"));
		const p = path.join(dir, `bridge-${mode.toString(8)}-${Math.random().toString(36).slice(2)}`);
		writeFileSync(p, "#!/bin/sh\nexit 0\n");
		chmodSync(p, mode);
		return p;
	};

	const modeOf = (p: string): number => statSync(p).mode & 0o7777;

	it("turns a packaged 0644 into something spawnable", () => {
		const p = file(0o644);
		expect(ensureExecutable(p)).toEqual({ outcome: "repaired", from: 0o644 });
		expect(octal(modeOf(p))).toBe("755");
	});

	it("is idempotent, as the restart path needs", () => {
		const p = file(0o644);
		ensureExecutable(p);
		expect(ensureExecutable(p)).toEqual({ outcome: "already", mode: EXECUTABLE_MODE });
		expect(octal(modeOf(p))).toBe("755");
	});

	it("fails rather than throws on a file that is not there", () => {
		dir ??= mkdtempSync(path.join(tmpdir(), "sidecar-exec-"));
		const result = ensureExecutable(path.join(dir, "absent"));
		expect(result.outcome).toBe("failed");
	});
});
