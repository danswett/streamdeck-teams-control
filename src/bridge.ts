import streamDeck from "@elgato/streamdeck";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DEFAULT_DIRECT_MODE, EMPTY_STATE, splitLines, type TeamsState, toState,
	type DirectModeSettings, type DirectModeStatus
} from "./protocol";
import { ensureExecutable, EXECUTABLE_MODE, octal } from "./sidecar-exec";
import { sidecarPath } from "./sidecar-path";

const logger = streamDeck.logger.createScope("Bridge");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.join(HERE, "sidecar", sidecarPath());
const SELECTORS = path.resolve(HERE, "..", "selectors.json");

/**
 * How long to wait for a press to report back. Must stay above the slowest
 * single operation the sidecar performs and below the point where a stuck key
 * feels broken; the sidecar independently discards anything queued longer than
 * this, so the two never disagree about whether a press still counts.
 */
const INVOKE_TIMEOUT_MS = 10_000;

export { EMPTY_STATE, type TeamsState };

export type CameraDevice = { id: string; name: string };
type BridgeResult = { ok: boolean; error?: string; cameras?: CameraDevice[]; directMode?: DirectModeStatus };

type Pending = {
	resolve: (v: BridgeResult) => void;
	timer: NodeJS.Timeout;
	directVersion?: number;
};

/** A captured slide, ready to be drawn on the touch strip. */
export type Thumbnail = {
	ok: boolean;
	image?: string;
	name?: string;
	error?: string;
	/** The deck has no slide after this one, so there is nothing to show. */
	end?: boolean;
	/** Frames fading the previous picture into this one, oldest first. */
	frames?: string[];
};

type PendingThumb = {
	resolve: (v: Thumbnail) => void;
	timer: NodeJS.Timeout;
};

/**
 * How long to wait for a slide thumbnail.
 *
 * Shorter than a press, because nothing is driven by it: a thumbnail that does
 * not arrive is a slot that keeps the last picture, not an action that failed.
 */
const CAPTURE_TIMEOUT_MS = 4_000;

/**
 * Owns the single sidecar process and fans its state out to every action.
 *
 * Stream Deck runs one Node process per plugin, so all key instances of all
 * action types share this one bridge and one UI Automation connection.
 */
class Bridge {
	#proc: ChildProcessWithoutNullStreams | undefined;
	#buffer = "";
	#nextId = 1;
	#pending = new Map<number, Pending>();
	#thumbs = new Map<number, PendingThumb>();
	#listeners = new Set<(s: TeamsState) => void>();
	#state: TeamsState = EMPTY_STATE;
	#restartDelay = 1000;
	#restartTimer: NodeJS.Timeout | undefined;
	#stopped = false;
	#ready = false;
	#directSettings = { ...DEFAULT_DIRECT_MODE };
	#directStatus: DirectModeStatus = { ...DEFAULT_DIRECT_MODE, usable: false, reason: "not enabled" };
	#directListeners = new Set<(status: DirectModeStatus) => void>();
	#directVersion = 0;
	#directApplied = false;

	get state(): TeamsState {
		return this.#state;
	}

	start(): void {
		this.#stopped = false;
		this.#spawn();
	}

	stop(): void {
		this.#stopped = true;
		if (this.#restartTimer) clearTimeout(this.#restartTimer);
		this.#proc?.kill();
		this.#proc = undefined;
		this.#ready = false;
		this.#directApplied = false;
		this.#failAllPending("sidecar stopped");
		this.#directUnavailable("sidecar stopped");
	}

	/** Subscribes to state changes and immediately replays the current state. */
	subscribe(fn: (s: TeamsState) => void): () => void {
		this.#listeners.add(fn);
		fn(this.#state);
		return () => this.#listeners.delete(fn);
	}

	#spawn(): void {
		if (this.#stopped) return;
		this.#ready = false;
		this.#directApplied = false;
		this.#directUnavailable("sidecar starting");

		// Whatever the last sidecar was part-way through writing is not the
		// start of what this one will write. Left behind, it gets glued to the
		// new process's first line and corrupts it.
		this.#buffer = "";

		if (!existsSync(SIDECAR)) {
			logger.error(`Sidecar missing at ${SIDECAR}. Run "npm run build:sidecar".`);
			this.#publish({ ...EMPTY_STATE });
			return;
		}

		// Packaging normalises every file in the .streamDeckPlugin to 0644, so
		// on macOS the helper arrives unable to run and spawn fails with EACCES
		// - which looks exactly like Gatekeeper refusing it. See sidecar-exec.
		// A plugin upgrade re-extracts, so this has to run on every spawn.
		const repair = ensureExecutable(SIDECAR);
		if (repair.outcome === "repaired")
			logger.info(
				`Sidecar was mode ${octal(repair.from)} and could not run; set to ${octal(EXECUTABLE_MODE)}.`
			);
		else if (repair.outcome === "failed")
			logger.error(`Could not make the sidecar executable: ${repair.reason}`);

		const args: string[] = [];
		if (existsSync(SELECTORS)) args.push("--selectors", SELECTORS);
		if (process.platform === "win32") args.push("--direct-mode-managed");

		logger.info(`Starting sidecar: ${SIDECAR}`);
		let proc: ChildProcessWithoutNullStreams;
		try {
			proc = spawn(SIDECAR, args, {
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
				// Anywhere but the plugin folder.
				//
				// A process's working directory is held open against rename, and
				// Stream Deck upgrades a plugin by renaming its folder to
				// ".uninstall". The sidecar inherits this process's directory,
				// which Stream Deck sets to the plugin folder, so it was holding
				// the very folder the next version has to move - and the install
				// failed with "the process cannot access the file because it is
				// being used by another process".
				//
				// Timing cannot fix it: Stream Deck force-kills the plugin and
				// renames in the same millisecond, while the sidecar needs ~73ms
				// to notice its parent is gone. Not holding the directory at all
				// is what fixes it. Nothing here reads the working directory -
				// selectors.json arrives as an absolute path, and the sidecar
				// falls back to AppContext.BaseDirectory, not the cwd.
				cwd: tmpdir()
			});
		} catch (err) {
			logger.error(`Failed to spawn sidecar: ${String(err)}`);
			this.#scheduleRestart();
			return;
		}

		this.#proc = proc;
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => this.#onData(chunk));
		proc.stderr.setEncoding("utf8");
		// Logged at info, not debug: the log level is fixed at info, so debug
		// went nowhere and the sidecar's own diagnostics — a slow snapshot, a
		// selector pattern that timed out — were invisible exactly when someone
		// was trying to work out why a key did nothing. It is low volume, and
		// carries no meeting content by design.
		proc.stderr.on("data", (chunk: string) => logger.info(`sidecar: ${chunk.trim()}`));

		proc.on("exit", (code, signal) => {
			logger.warn(`Sidecar exited (code=${code}, signal=${signal})`);
			this.#failAllPending("sidecar exited");
			this.#proc = undefined;
			this.#ready = false;
			this.#directUnavailable("sidecar exited");
			this.#publish({ ...EMPTY_STATE });
			this.#scheduleRestart();
		});

		// A spawn that fails - EACCES on a helper that lost its execute bit,
		// ENOENT on one removed mid-upgrade - reports here and not through
		// "exit", so without a restart the bridge stayed dead for the rest of
		// the session and every key sat on the alert triangle. That is the
		// shape #7 arrived in.
		proc.on("error", (err) => {
			logger.error(`Sidecar error: ${err.message}`);
			if (this.#proc !== proc) return;
			this.#failAllPending(`sidecar error: ${err.message}`);
			this.#proc = undefined;
			this.#ready = false;
			this.#directUnavailable(`sidecar error: ${err.message}`);
			this.#publish({ ...EMPTY_STATE });
			this.#scheduleRestart();
		});
	}

	#scheduleRestart(): void {
		if (this.#stopped) return;
		// Idempotent: "error" and "exit" can both fire for one process, and two
		// live timers would mean two sidecars.
		if (this.#restartTimer) clearTimeout(this.#restartTimer);
		const delay = this.#restartDelay;
		this.#restartDelay = Math.min(this.#restartDelay * 2, 30_000);
		logger.info(`Restarting sidecar in ${delay}ms`);
		this.#restartTimer = setTimeout(() => this.#spawn(), delay);
	}

	#onData(chunk: string): void {
		const { lines, rest } = splitLines(this.#buffer + chunk);
		this.#buffer = rest;
		for (const line of lines) this.#onMessage(line);
	}

	#onMessage(line: string): void {
		let msg: Record<string, unknown>;
		try {
			msg = JSON.parse(line) as Record<string, unknown>;
		} catch {
			/*
				Deliberately not the line itself. A thumbnail message is the
				largest thing on this channel and is always split across several
				reads, so a sidecar that dies mid-write leaves half of one here
				- and the fields before the image are the slide's own name. The
				shape is enough to debug with; the content is not ours to write
				to a log file.
			*/
			const type = /"type"\s*:\s*"([a-z]+)"/i.exec(line)?.[1] ?? "unknown";
			logger.warn(`Unparsable sidecar line (type ${type}, ${line.length} bytes)`);
			return;
		}

		switch (msg["type"]) {
			case "ready":
				// The sidecar came up cleanly, so reset the backoff.
				this.#restartDelay = 1000;
				logger.info(`Sidecar ready (pid ${String(msg["pid"])})`);
				this.#ready = true;
				if (process.platform === "win32")
					void this.configureDirectMode(this.#directSettings).then((result) => {
						if (!result.ok) logger.warn(`Direct mode setup failed: ${result.error}`);
					});
				break;

			case "directmode": {
				const id = Number(msg["id"]);
				const pending = this.#pending.get(id);
				if (!pending) break;
				clearTimeout(pending.timer);
				this.#pending.delete(id);
				if (msg["ok"] !== true || typeof msg["enabled"] !== "boolean" ||
					typeof msg["port"] !== "number" || !Number.isInteger(msg["port"]) ||
					msg["port"] < 1 || msg["port"] > 65535 ||
					typeof msg["usable"] !== "boolean" || typeof msg["reason"] !== "string") {
					pending.resolve({ ok: false, error: "invalid Direct mode status from sidecar" });
					break;
				}
				const status: DirectModeStatus = {
					enabled: msg["enabled"], port: msg["port"],
					usable: msg["usable"], reason: msg["reason"]
				};
				if (pending.directVersion === this.#directVersion &&
					status.enabled === this.#directSettings.enabled && status.port === this.#directSettings.port) {
					this.#directApplied = true;
					this.#publishDirect(status);
				}
				pending.resolve({ ok: true, directMode: status });
				break;
			}

			case "state":
				this.#publish(toState(msg));
				break;

			case "cameras":
			case "result": {
				const id = Number(msg["id"]);
				const pending = this.#pending.get(id);
				if (pending) {
					clearTimeout(pending.timer);
					this.#pending.delete(id);
					const result: BridgeResult = { ok: Boolean(msg["ok"]), error: msg["error"] as string | undefined };
					if (msg["type"] === "cameras" && result.ok) {
						const cameras = msg["cameras"];
						if (Array.isArray(cameras) && cameras.every((c: unknown): c is CameraDevice =>
							typeof c === "object" && c !== null && "id" in c && "name" in c &&
							typeof c.id === "string" && c.id.length > 0 && typeof c.name === "string")) {
							result.cameras = cameras;
						} else {
							result.ok = false;
							result.error = "invalid webcam list from sidecar";
						}
					}
					pending.resolve(result);
				}
				break;
			}

			case "thumb": {
				const id = Number(msg["id"]);
				const pending = this.#thumbs.get(id);
				if (pending) {
					clearTimeout(pending.timer);
					this.#thumbs.delete(id);
					pending.resolve({
						ok: Boolean(msg["ok"]),
						image: msg["image"] as string | undefined,
						name: msg["name"] as string | undefined,
						error: msg["error"] as string | undefined,
						end: Boolean(msg["end"]),
						frames: Array.isArray(msg["frames"]) ? (msg["frames"] as string[]) : undefined
					});
				}
				break;
			}

			case "error":
				logger.warn(`Sidecar error: ${String(msg["message"])}`);
				break;
		}
	}

	#publish(state: TeamsState): void {
		this.#state = state;
		for (const fn of this.#listeners) {
			try {
				fn(state);
			} catch (err) {
				logger.error(`Listener failed: ${String(err)}`);
			}
		}
	}

	get directModeStatus(): DirectModeStatus {
		return this.#directStatus;
	}

	get directModeNeedsSync(): boolean {
		return this.#ready && !this.#directApplied;
	}

	subscribeDirectMode(fn: (status: DirectModeStatus) => void): () => void {
		this.#directListeners.add(fn);
		fn(this.#directStatus);
		return () => this.#directListeners.delete(fn);
	}

	#publishDirect(status: DirectModeStatus): void {
		this.#directStatus = status;
		for (const fn of this.#directListeners) {
			try { fn(status); }
			catch (err) { logger.error(`Direct mode listener failed: ${String(err)}`); }
		}
	}

	#directUnavailable(reason: string): void {
		this.#publishDirect({
			...this.#directSettings, usable: false,
			reason: this.#directSettings.enabled ? reason : "not enabled"
		});
	}

	configureDirectMode(settings: DirectModeSettings): Promise<BridgeResult> {
		this.#directVersion++;
		this.#directApplied = false;
		this.#directSettings = { ...settings };
		this.#directUnavailable("applying settings");
		return this.#requestDirectMode(JSON.stringify(settings));
	}

	probeDirectMode(): Promise<BridgeResult> {
		return this.#requestDirectMode(this.#directApplied ? undefined : JSON.stringify(this.#directSettings));
	}

	#requestDirectMode(arg?: string): Promise<BridgeResult> {
		if (process.platform !== "win32")
			return Promise.resolve({ ok: false, error: "Direct mode is Windows-only" });
		if (!this.#ready) return Promise.resolve({ ok: false, error: "sidecar not ready" });
		const id = this.#nextId++;
		const directVersion = this.#directVersion;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				if (directVersion === this.#directVersion) this.#directUnavailable("Direct mode request timed out");
				resolve({ ok: false, error: "Direct mode request timed out" });
			}, INVOKE_TIMEOUT_MS);
			this.#pending.set(id, { resolve, timer, directVersion });
			if (!this.#send({ id, cmd: "directmode", arg })) {
				clearTimeout(timer);
				this.#pending.delete(id);
				this.#directUnavailable("sidecar not running");
				resolve({ ok: false, error: "sidecar not running" });
			}
		});
	}

	#failAllPending(reason: string): void {
		for (const [, p] of this.#pending) {
			clearTimeout(p.timer);
			p.resolve({ ok: false, error: reason });
		}
		this.#pending.clear();

		// Captures too, or a dial waiting on a thumbnail when the sidecar died
		// would sit on its timeout rather than being told.
		for (const [, t] of this.#thumbs) {
			clearTimeout(t.timer);
			t.resolve({ ok: false, error: reason });
		}
		this.#thumbs.clear();
	}

	#send(payload: Record<string, unknown>): boolean {
		const proc = this.#proc;
		if (!proc || proc.killed || !proc.stdin.writable) return false;
		try {
			proc.stdin.write(`${JSON.stringify(payload)}\n`);
			return true;
		} catch (err) {
			logger.error(`Write failed: ${String(err)}`);
			return false;
		}
	}

	/**
	 * Presses a Teams control. Resolves with the outcome so keys can show
	 * feedback.
	 *
	 * The timeout is generous because the work behind a press is not uniform: a
	 * slide advance is one posted click, but a flyout-nested control has to open
	 * a menu, wait for it to populate, press an item and then make sure the menu
	 * closed again — measured at up to ~4.5s on a live meeting. At the old 5s a
	 * press queued behind one of those was reported as failed while the sidecar
	 * was still working on it, and then it landed anyway, which read as a key
	 * firing long after it was pressed.
	 */
	/**
	 * Presses a Teams control. Resolves with the outcome so keys can show
	 * feedback.
	 *
	 * The timeout is generous because the work behind a press is not uniform: a
	 * slide advance is one posted click, but a flyout-nested control has to open
	 * a menu, wait for it to populate, press an item and then make sure the menu
	 * closed again — measured at up to ~4.5s on a live meeting. At the old 5s a
	 * press queued behind one of those was reported as failed while the sidecar
	 * was still working on it, and then it landed anyway, which read as a key
	 * firing long after it was pressed.
	 */
	invoke(target: string, arg?: string): Promise<{ ok: boolean; error?: string }> {
		// Do not run a press with old consent after a settings request failed.
		if (process.platform === "win32" && this.directModeNeedsSync)
			return Promise.resolve({ ok: false, error: "Direct mode settings have not been applied yet" });
		const id = this.#nextId++;
		if (!this.#send({ id, cmd: "invoke", target, arg: arg ?? "" })) {
			return Promise.resolve({ ok: false, error: "sidecar not running" });
		}

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				resolve({ ok: false, error: "timed out" });
			}, INVOKE_TIMEOUT_MS);
			this.#pending.set(id, { resolve, timer });
		});
	}

	cameras(): Promise<BridgeResult> {
		const id = this.#nextId++;
		if (!this.#send({ id, cmd: "cameras" })) {
			return Promise.resolve({ ok: false, error: "sidecar not running" });
		}
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				resolve({ ok: false, error: "webcam enumeration timed out" });
			}, INVOKE_TIMEOUT_MS);
			this.#pending.set(id, { resolve, timer });
		});
	}

	/**
	 * Captures the current slide, or the one after it.
	 *
	 * Its own channel rather than part of the state, because it carries a
	 * picture: on the state channel a thumbnail would ride along with every
	 * key's availability, and a stale one would be replayed to anything that
	 * subscribed later.
	 */
	capture(which: "current" | "next", fade = 0, size?: { w: number; h: number }): Promise<Thumbnail> {
		const id = this.#nextId++;
		if (!this.#send({ id, cmd: "thumb", arg: which, fade, w: size?.w ?? 200, h: size?.h ?? 100 })) {
			return Promise.resolve({ ok: false, error: "sidecar not running" });
		}

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#thumbs.delete(id);
				resolve({ ok: false, error: "timed out" });
			}, CAPTURE_TIMEOUT_MS);
			this.#thumbs.set(id, { resolve, timer });
		});
	}

	/**
	 * Tells the sidecar to drop the slide it is holding.
	 *
	 * It keeps the last frame per slot so it has something to fade out of, and
	 * that outlives both the presentation and the setting that allowed it. Sent
	 * and forgotten: there is nothing useful to do if it does not arrive, and
	 * the sidecar drops everything when it exits anyway.
	 */
	forget(which: "current" | "next"): void {
		this.#send({ id: this.#nextId++, cmd: "forget", arg: which });
	}
}

export const bridge = new Bridge();
