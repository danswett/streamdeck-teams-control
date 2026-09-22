import streamDeck from "@elgato/streamdeck";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_STATE, splitLines, type TeamsState, toState } from "./protocol";

const logger = streamDeck.logger.createScope("Bridge");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.join(HERE, "sidecar", "TeamsBridge.exe");
const SELECTORS = path.resolve(HERE, "..", "selectors.json");

/**
 * How long to wait for a press to report back. Must stay above the slowest
 * single operation the sidecar performs and below the point where a stuck key
 * feels broken; the sidecar independently discards anything queued longer than
 * this, so the two never disagree about whether a press still counts.
 */
const INVOKE_TIMEOUT_MS = 10_000;

export { EMPTY_STATE, type TeamsState };

type Pending = {
	resolve: (v: { ok: boolean; error?: string }) => void;
	timer: NodeJS.Timeout;
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
	}

	/** Subscribes to state changes and immediately replays the current state. */
	subscribe(fn: (s: TeamsState) => void): () => void {
		this.#listeners.add(fn);
		fn(this.#state);
		return () => this.#listeners.delete(fn);
	}

	#spawn(): void {
		if (this.#stopped) return;

		// Whatever the last sidecar was part-way through writing is not the
		// start of what this one will write. Left behind, it gets glued to the
		// new process's first line and corrupts it.
		this.#buffer = "";

		if (!existsSync(SIDECAR)) {
			logger.error(`Sidecar missing at ${SIDECAR}. Run "npm run build:sidecar".`);
			this.#publish({ ...EMPTY_STATE });
			return;
		}

		const args: string[] = [];
		if (existsSync(SELECTORS)) args.push("--selectors", SELECTORS);

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
			this.#publish({ ...EMPTY_STATE });
			this.#scheduleRestart();
		});

		proc.on("error", (err) => logger.error(`Sidecar error: ${err.message}`));
	}

	#scheduleRestart(): void {
		if (this.#stopped) return;
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
				break;

			case "state":
				this.#publish(toState(msg));
				break;

			case "result": {
				const id = Number(msg["id"]);
				const pending = this.#pending.get(id);
				if (pending) {
					clearTimeout(pending.timer);
					this.#pending.delete(id);
					pending.resolve({ ok: Boolean(msg["ok"]), error: msg["error"] as string | undefined });
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
