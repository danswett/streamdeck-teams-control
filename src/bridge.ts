import streamDeck from "@elgato/streamdeck";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EMPTY_STATE, splitLines, type TeamsState, toState } from "./protocol";

const logger = streamDeck.logger.createScope("Bridge");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR = path.join(HERE, "sidecar", "TeamsBridge.exe");
const SELECTORS = path.resolve(HERE, "..", "selectors.json");

export { EMPTY_STATE, type TeamsState };

type Pending = {
	resolve: (v: { ok: boolean; error?: string }) => void;
	timer: NodeJS.Timeout;
};

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
			proc = spawn(SIDECAR, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
		} catch (err) {
			logger.error(`Failed to spawn sidecar: ${String(err)}`);
			this.#scheduleRestart();
			return;
		}

		this.#proc = proc;
		proc.stdout.setEncoding("utf8");
		proc.stdout.on("data", (chunk: string) => this.#onData(chunk));
		proc.stderr.setEncoding("utf8");
		proc.stderr.on("data", (chunk: string) => logger.debug(`sidecar: ${chunk.trim()}`));

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
			logger.warn(`Unparsable sidecar line: ${line.slice(0, 200)}`);
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

			case "discover":
				logger.info(`discover(${String(msg["menu"])}): ${JSON.stringify(msg["elements"])}`);
				break;

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

	/** Presses a Teams control. Resolves with the outcome so keys can show feedback. */
	invoke(target: string, arg?: string): Promise<{ ok: boolean; error?: string }> {
		const id = this.#nextId++;
		if (!this.#send({ id, cmd: "invoke", target, arg: arg ?? "" })) {
			return Promise.resolve({ ok: false, error: "sidecar not running" });
		}

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				resolve({ ok: false, error: "timed out" });
			}, 5000);
			this.#pending.set(id, { resolve, timer });
		});
	}

	/** Dumps a flyout's contents to the plugin log; used to re-map Teams' UI. */
	discover(menu?: string): void {
		this.#send({ id: this.#nextId++, cmd: "discover", menu: menu ?? "" });
	}
}

export const bridge = new Bridge();
