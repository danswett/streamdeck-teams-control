import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@elgato/streamdeck", () => ({
	default: { logger: { createScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) } }
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

describe("runtime Direct mode bridge", () => {
	let proc: ReturnType<typeof sidecar>;
	function requests() { return proc.stdin.write.mock.calls.map(([line]) => JSON.parse(line)); }
	function reply(index: number, enabled: boolean, port: number, usable = enabled) {
		proc.stdout.emit("data", JSON.stringify({
			type: "directmode", id: requests()[index].id, ok: true,
			enabled, port, usable, reason: usable ? "connected" : "not enabled"
		}) + "\n");
	}
	beforeEach(async () => {
		vi.useFakeTimers();
		Object.defineProperty(process, "platform", { value: "win32" });
		proc = sidecar();
		vi.mocked(spawn).mockClear();
		vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
		await bridge.configureDirectMode({ enabled: false, port: 9457 });
		bridge.start();
	});
	afterEach(() => {
		bridge.stop();
		Object.defineProperty(process, "platform", platform);
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("starts the sidecar inert and supplies settings on readiness", async () => {
		expect(vi.mocked(spawn).mock.lastCall?.[1]).toContain("--direct-mode-managed");
		expect(requests()).toHaveLength(0);
		proc.stdout.emit("data", '{"type":"ready","pid":123}\n');
		expect(requests()[0]).toMatchObject({ cmd: "directmode", arg: '{"enabled":false,"port":9457}' });
		reply(0, false, 9457);
		expect(bridge.directModeStatus).toMatchObject({ enabled: false, usable: false });
	});

	it("enables, changes port and disables in the same process, ignoring stale status replies", async () => {
		proc.stdout.emit("data", '{"type":"ready","pid":123}\n');
		reply(0, false, 9457);
		const enable = bridge.configureDirectMode({ enabled: true, port: 12345 });
		reply(1, true, 12345);
		expect(await enable).toMatchObject({ ok: true });
		expect(bridge.directModeStatus).toMatchObject({ enabled: true, port: 12345, usable: true });
		const oldProbe = bridge.probeDirectMode();
		const change = bridge.configureDirectMode({ enabled: true, port: 54321 });
		reply(2, true, 12345);
		await oldProbe;
		expect(bridge.directModeStatus).toMatchObject({ port: 54321, usable: false });
		reply(3, true, 54321);
		await change;
		const disable = bridge.configureDirectMode({ enabled: false, port: 54321 });
		reply(4, false, 54321);
		await disable;
		expect(bridge.directModeStatus).toMatchObject({ enabled: false, usable: false });
		expect(spawn).toHaveBeenCalledOnce();
	});

	it("restores desired settings when the sidecar restarts", async () => {
		proc.stdout.emit("data", '{"type":"ready","pid":123}\n');
		reply(0, false, 9457);
		const change = bridge.configureDirectMode({ enabled: true, port: 12345 });
		reply(1, true, 12345);
		await change;
		proc.emit("exit", 1, null);
		expect(bridge.directModeStatus).toMatchObject({ enabled: true, usable: false, reason: "sidecar exited" });
		proc = sidecar();
		vi.mocked(spawn).mockReturnValue(proc as unknown as ReturnType<typeof spawn>);
		await vi.advanceTimersByTimeAsync(1000);
		proc.stdout.emit("data", '{"type":"ready","pid":456}\n');
		expect(requests()[0].arg).toBe('{"enabled":true,"port":12345}');
		reply(0, true, 12345);
		expect(bridge.directModeStatus.usable).toBe(true);
	});

	it("reports timeouts without claiming the connection is usable", async () => {
		proc.stdout.emit("data", '{"type":"ready","pid":123}\n');
		reply(0, false, 9457);
		const pending = bridge.configureDirectMode({ enabled: true, port: 12345 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
		expect(bridge.directModeStatus.usable).toBe(false);
	});

	it("blocks controls after a failed disable and retries the desired settings", async () => {
		proc.stdout.emit("data", '{"type":"ready","pid":123}\n');
		reply(0, false, 9457);
		const enable = bridge.configureDirectMode({ enabled: true, port: 12345 });
		reply(1, true, 12345);
		await enable;
		const disable = bridge.configureDirectMode({ enabled: false, port: 12345 });
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await disable).toMatchObject({ ok: false });
		expect(await bridge.invoke("mute")).toMatchObject({ ok: false, error: expect.stringContaining("not been applied") });
		const retry = bridge.probeDirectMode();
		expect(requests().at(-1).arg).toBe('{"enabled":false,"port":12345}');
		reply(3, false, 12345);
		await retry;
		expect(bridge.directModeNeedsSync).toBe(false);
	});
});
