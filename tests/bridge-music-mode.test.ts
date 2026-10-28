import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@elgato/streamdeck", () => ({
	default: { logger: { createScope: () => mocks.logger } }
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs", () => ({ existsSync: () => true }));
vi.mock("../src/sidecar-exec", () => ({
	ensureExecutable: () => ({ outcome: "unnecessary" }), EXECUTABLE_MODE: 0o755, octal: String
}));

import { bridge, EMPTY_STATE } from "../src/bridge";

function processStub() {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		stdin: { writable: true, write: vi.fn((_chunk: string) => true) },
		kill: vi.fn()
	});
}

let proc: ReturnType<typeof processStub>;
const meeting = {
	type: "state", teamsRunning: true, inMeeting: true, windowTitle: "Meeting",
	states: { "music-mode": false, mute: true, camera: false },
	available: { "music-mode": true, mute: true, camera: true },
	context: { "ppt.role": "presenter" }
};
function emit(message: object): void {
	proc.stdout.write(JSON.stringify(message) + "\n");
}
function reply(ok: boolean): void {
	const call = proc.stdin.write.mock.calls.at(-1);
	if (!call) throw new Error("No request was sent");
	const { id } = JSON.parse(call[0]);
	emit({ type: "result", id, ok, ...(ok ? {} : { error: "unconfirmed" }) });
}

beforeEach(() => {
	vi.clearAllMocks();
	proc = processStub();
	mocks.spawn.mockReturnValue(proc);
	bridge.start();
	emit(meeting);
});
afterEach(() => bridge.stop());

describe("confirmed music state before flyout cleanup", () => {
	it("updates every subscriber before the invoke result or post-cleanup snapshot", async () => {
		const previous = bridge.state;
		const states: boolean[] = [];
		const unsubscribe = bridge.subscribe((state) => states.push(state.states["music-mode"]));
		const result = bridge.invoke("music-mode");
		expect(bridge.state.states["music-mode"]).toBe(false);

		emit({ type: "music-mode-state", active: true });
		expect(states).toEqual([false, true]);
		expect(bridge.state).toEqual({ ...previous, states: { ...previous.states, "music-mode": true } });
		expect(previous.states["music-mode"]).toBe(false);
		reply(true);
		await expect(result).resolves.toEqual({ ok: true, error: undefined });
		unsubscribe();
	});

	it("accepts a confirmed off state and still applies the full post-cleanup snapshot", () => {
		emit({ type: "music-mode-state", active: true });
		emit({ type: "music-mode-state", active: false });
		expect(bridge.state.states["music-mode"]).toBe(false);
		emit({ ...meeting, states: { ...meeting.states, "music-mode": true, camera: true } });
		expect(bridge.state.states).toEqual({ "music-mode": true, mute: true, camera: true });
	});

	it("does not optimistically toggle on an acknowledgement or a failure", async () => {
		const successful = bridge.invoke("music-mode");
		reply(true);
		await successful;
		expect(bridge.state.states["music-mode"]).toBe(false);
		const failed = bridge.invoke("music-mode");
		reply(false);
		await expect(failed).resolves.toMatchObject({ ok: false });
		expect(bridge.state.states["music-mode"]).toBe(false);
	});

	it.each([null, "false", 0, undefined])("rejects malformed or unknown state %s rather than guessing", (active) => {
		const previous = bridge.state;
		emit({ type: "music-mode-state", active });
		expect(bridge.state).toBe(previous);
		expect(mocks.logger.warn).toHaveBeenCalledWith("Invalid confirmed music-mode state from sidecar");
	});

	it("does not invent a meeting before the first full snapshot", () => {
		emit({ type: "state", ...EMPTY_STATE });
		emit({ type: "music-mode-state", active: true });
		expect(bridge.state).toEqual(EMPTY_STATE);
	});

	it("leaves non-music invocation behavior unchanged", async () => {
		const result = bridge.invoke("mute");
		reply(true);
		await result;
		expect(bridge.state.states).toEqual(meeting.states);
	});
});
