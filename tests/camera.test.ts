import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elgato/streamdeck", () => ({
	default: {
		logger: { createScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
		ui: { action: { id: "camera-key" }, sendToPropertyInspector: vi.fn() }
	},
	action: () => (target: unknown) => target,
	SingletonAction: class { actions = []; }
}));
vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
vi.mock("node:fs", async (original) => ({
	...await original<typeof import("node:fs")>(),
	existsSync: () => true
}));
vi.mock("../src/sidecar-exec", () => ({
	ensureExecutable: () => ({ outcome: "unchanged" }), EXECUTABLE_MODE: 0o755, octal: String
}));

import { spawn } from "node:child_process";
import { bridge } from "../src/bridge";

function sidecar() {
	const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
	const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
	return Object.assign(new EventEmitter(), {
		stdout, stderr, stdin: { writable: true, write: vi.fn<(value: string) => void>() }, killed: false, kill: vi.fn()
	});
}

describe("webcam discovery bridge", () => {
	let proc: ReturnType<typeof sidecar>;
	beforeEach(() => {
		vi.useFakeTimers();
		proc = sidecar();
		// Only the process streams and lifecycle methods used by Bridge are needed.
		vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
		bridge.start();
	});
	afterEach(() => {
		bridge.stop();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("requests Windows devices and preserves exact IDs, including duplicate names", async () => {
		const result = bridge.cameras();
		const request = JSON.parse(proc.stdin.write.mock.calls[0][0] as string);
		expect(request.cmd).toBe("cameras");
		const cameras = [{ id: "\\\\?\\usb#one", name: "Webcam" }, { id: "@device:sw:two", name: "Webcam" }];
		proc.stdout.emit("data", JSON.stringify({ type: "cameras", id: request.id, ok: true, cameras }) + "\n");
		expect(await result).toEqual({ ok: true, error: undefined, cameras });
	});

	it.each([null, [{ id: 3, name: "Webcam" }], [{ id: "", name: "Webcam" }]])(
		"reports a malformed list instead of offering a guessed camera (%j)", async (cameras) => {
			const result = bridge.cameras();
			const { id } = JSON.parse(proc.stdin.write.mock.calls[0][0] as string);
			proc.stdout.emit("data", JSON.stringify({ type: "cameras", id, ok: true, cameras }) + "\n");
			expect(await result).toMatchObject({ ok: false, error: "invalid webcam list from sidecar" });
		}
	);

	it("surfaces the macOS unsupported response immediately", async () => {
		const result = bridge.cameras();
		const { id } = JSON.parse(proc.stdin.write.mock.calls[0][0] as string);
		const error = "camera enumeration is not implemented in the macOS sidecar yet";
		proc.stdout.emit("data", JSON.stringify({ type: "cameras", id, ok: false, error }) + "\n");
		expect(await result).toEqual({ ok: false, error });
	});

	it("surfaces sidecar errors, timeouts and process exit", async () => {
		const failed = bridge.cameras();
		const { id } = JSON.parse(proc.stdin.write.mock.calls[0][0] as string);
		proc.stdout.emit("data", JSON.stringify({ type: "cameras", id, ok: false, error: "enumeration failed" }) + "\n");
		expect(await failed).toMatchObject({ ok: false, error: "enumeration failed" });
		const expired = bridge.cameras();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await expired).toMatchObject({ ok: false, error: "webcam enumeration timed out" });
		const pending = bridge.cameras();
		proc.emit("exit", 1, null);
		expect(await pending).toMatchObject({ ok: false, error: "sidecar exited" });
	});

	it("allows time for video preference navigation without extending ordinary camera presses", async () => {
		const plain = bridge.invoke("camera-select", "one");
		const preferences = bridge.invoke("camera-select", '{"cameras":[{"id":"one","mirror":"on"}]}');
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await plain).toMatchObject({ ok: false, error: "timed out" });
		let finished = false;
		void preferences.then(() => { finished = true; });
		await vi.advanceTimersByTimeAsync(9999);
		expect(finished).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(await preferences).toMatchObject({ ok: false, error: "timed out" });
	});
});
