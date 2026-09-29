/**
 * Puts back the execute bit that packaging takes away.
 *
 * `streamdeck pack` writes every entry in the `.streamDeckPlugin` zip with mode
 * `0o644`. Measured on the package testers actually installed: 120 entries, all
 * `0o644`, the Mach-O among them. Stream Deck honours the stored mode when it
 * extracts, so the helper lands on a Mac as `-rw-r--r--` and cannot be executed
 * at all. `build-sidecar-macos.sh` does `chmod +x`; the bit simply does not
 * survive the zip.
 *
 * From the outside this is indistinguishable from Gatekeeper refusing the
 * binary - keys show the alert triangle, Teams never moves - which is why
 * https://github.com/danswett/streamdeck-teams-control/issues/7 asked for the
 * mode and the quarantine attribute together. Both testers came back with no
 * `com.apple.quarantine` set and mode `644`: nothing to do with signing.
 *
 * Repairing it here, rather than trying to make the package carry the bit, is
 * deliberate. This is the one point that holds however the plugin arrived -
 * downloaded, sideloaded, upgraded in place, or re-packed by Marketplace - and
 * it costs one `stat` on a path that is about to be spawned anyway. A plugin
 * upgrade re-extracts, so the repair has to be able to run again.
 *
 * It cannot break signing: `codesign` seals file contents and records hashes in
 * `_CodeSignature/CodeResources`. POSIX mode is not part of either, nor of the
 * notarization ticket stapled at `Contents/CodeResources`.
 */
import { chmodSync, statSync } from "node:fs";

/** What a helper should be: owner-writable, world-executable. */
export const EXECUTABLE_MODE = 0o755;

/**
 * Owner execute alone decides whether this process can spawn the file: the
 * plugin and the helper run as the same user, who also owns the folder Stream
 * Deck extracted. A mode that has lost only the group and other bits is still
 * perfectly spawnable, and rewriting it would be churn.
 */
const OWNER_EXEC = 0o100;

/** The permission bits, with the file-type bits `statSync` also returns masked off. */
const PERMISSION_BITS = 0o7777;

export type ExecRepair =
	/** Windows: there is no execute bit, and `chmod` there only toggles read-only. */
	| { outcome: "unnecessary" }
	| { outcome: "already"; mode: number }
	| { outcome: "repaired"; from: number }
	| { outcome: "failed"; reason: string };

/**
 * The two filesystem operations, injectable so the decision can be tested off
 * a POSIX machine. Windows cannot represent mode `0o644`, so a test that wrote
 * a real file would assert nothing there - and the TypeScript suite runs on
 * `windows-latest`.
 */
export type ExecFs = {
	/** Permission bits of `file`, or throws if it cannot be read. */
	mode: (file: string) => number;
	/** Sets `file` to {@link EXECUTABLE_MODE}, or throws. */
	makeExecutable: (file: string) => void;
};

const REAL_FS: ExecFs = {
	mode: (file) => statSync(file).mode & PERMISSION_BITS,
	makeExecutable: (file) => chmodSync(file, EXECUTABLE_MODE)
};

/**
 * Makes `file` executable if it is not already, reporting what it found.
 *
 * Never throws: a helper that cannot be chmod'ed should still be attempted -
 * the mode may be fine in a way this could not read - and the caller logs the
 * reason either way.
 */
export function ensureExecutable(
	file: string,
	platform: NodeJS.Platform = process.platform,
	fs: ExecFs = REAL_FS
): ExecRepair {
	if (platform === "win32") return { outcome: "unnecessary" };

	try {
		const mode = fs.mode(file);
		if (mode & OWNER_EXEC) return { outcome: "already", mode };
		fs.makeExecutable(file);
		return { outcome: "repaired", from: mode };
	} catch (err) {
		return { outcome: "failed", reason: err instanceof Error ? err.message : String(err) };
	}
}

/** `0o644` as `644`, so a log line reads the way `ls -l` taught people to expect. */
export function octal(mode: number): string {
	return mode.toString(8).padStart(3, "0");
}
