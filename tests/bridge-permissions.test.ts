import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elgato/streamdeck", () => ({
	default: { logger: { createScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) } }
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (original) => ({
	...await original<typeof import("node:fs")>(), existsSync: () => true
}));
vi.mock("../src/sidecar-exec", () => ({
	ensureExecutable: () => ({ outcome: "unchanged" }), EXECUTABLE_MODE: 0o755, octal: String
}));

import { spawn } from "node:child_process";
import { bridge } from "../src/bridge";

function sidecar() {
	return Object.assign(new EventEmitter(), {
		stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
		stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
		stdin: { writable: true, write: vi.fn<(value: string) => void>() }, killed: false, kill: vi.fn()
	});
}
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

describe("macOS permission plumbing in the bridge", () => {
	let proc: ReturnType<typeof sidecar>;
	const requests = () => proc.stdin.write.mock.calls.map(([line]) => JSON.parse(line));

	beforeEach(() => {
		vi.useFakeTimers();
		Object.defineProperty(process, "platform", { value: "darwin" });
		proc = sidecar();
		vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
		bridge.start();
		proc.stdout.emit("data", '{"type":"ready","pid":1}\n');
	});
	afterEach(() => {
		bridge.setGate(() => undefined);
		bridge.stop();
		Object.defineProperty(process, "platform", platform);
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("refuses presses and captures with the gate's reason, without reaching the sidecar", async () => {
		bridge.setGate(() => "Teams control is off");
		expect(await bridge.invoke("mute")).toEqual({ ok: false, error: "Teams control is off" });
		expect(await bridge.capture("current")).toEqual({ ok: false, error: "Teams control is off" });
		expect(requests()).toHaveLength(0);
		bridge.setGate(() => undefined);
		void bridge.invoke("mute");
		expect(requests()).toEqual([expect.objectContaining({ cmd: "invoke", target: "mute" })]);
	});

	it("asks for a permission only when one is named, and reads the reply", async () => {
		const status = bridge.permissions();
		const ask = bridge.permissions("screen-recording");
		expect(requests().map((r) => r.arg)).toEqual([undefined, "request-screen-recording"]);
		for (const [index, granted] of [[0, false], [1, true]] as const) {
			proc.stdout.emit("data", JSON.stringify({
				type: "permissions", id: requests()[index].id, ok: true, accessibility: true, screenRecording: granted
			}) + "\n");
		}
		expect(await status).toEqual({ ok: true, permissions: { accessibility: true, screenRecording: false } });
		expect(await ask).toEqual({ ok: true, permissions: { accessibility: true, screenRecording: true } });
	});

	it("rejects a malformed permission reply", async () => {
		const status = bridge.permissions();
		proc.stdout.emit("data", JSON.stringify({ type: "permissions", id: requests()[0].id, ok: true }) + "\n");
		expect(await status).toEqual({ ok: false, error: "invalid permission status from sidecar" });
	});

	it("tells listeners each time a sidecar comes up", () => {
		const ready = vi.fn();
		const stop = bridge.onReady(ready);
		proc.stdout.emit("data", '{"type":"ready","pid":2}\n');
		stop();
		proc.stdout.emit("data", '{"type":"ready","pid":3}\n');
		expect(ready).toHaveBeenCalledOnce();
	});

	it("never asks on Windows", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		expect(await bridge.permissions("accessibility")).toEqual({ ok: false, error: "macOS only" });
		expect(requests()).toHaveLength(0);
	});
});
