import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@elgato/utils";
import type { DirectModeStatus } from "../src/protocol";

const mocks = vi.hoisted(() => ({
	global: {} as JsonObject,
	receive: undefined as ((event: { settings: JsonObject }) => void) | undefined,
	status: { enabled: false, port: 9457, usable: false, reason: "not enabled" } as DirectModeStatus,
	listeners: new Set<(status: DirectModeStatus) => void>(),
	get: vi.fn(),
	save: vi.fn(),
	configure: vi.fn(),
	probe: vi.fn()
}));
vi.mock("@elgato/streamdeck", () => ({
	default: {
		logger: { createScope: () => ({ warn: vi.fn(), error: vi.fn() }) },
		settings: {
			getGlobalSettings: mocks.get,
			setGlobalSettings: mocks.save,
			onDidReceiveGlobalSettings: (fn: typeof mocks.receive) => { mocks.receive = fn; }
		}
	}
}));
vi.mock("../src/bridge", () => ({
	bridge: {
		get directModeStatus() { return mocks.status; },
		configureDirectMode: mocks.configure,
		probeDirectMode: mocks.probe,
		subscribeDirectMode: (fn: (status: DirectModeStatus) => void) => {
			mocks.listeners.add(fn);
			return () => mocks.listeners.delete(fn);
		}
	}
}));
import { DirectModeControl } from "../src/direct-mode";
import { readDirectModeSettings } from "../src/protocol";
import { updateGlobalSettings } from "../src/settings";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

describe("plugin-wide Direct mode settings", () => {
	let control: DirectModeControl;
	beforeEach(() => {
		vi.useFakeTimers();
		Object.defineProperty(process, "platform", { value: "win32" });
		mocks.global = {};
		mocks.status = { enabled: false, port: 9457, usable: false, reason: "not enabled" };
		mocks.listeners.clear();
		mocks.get.mockReset().mockImplementation(async () => mocks.global);
		mocks.save.mockReset().mockImplementation(async (settings: JsonObject) => { mocks.global = settings; });
		mocks.configure.mockReset().mockImplementation(async (settings) => {
			mocks.status = { ...settings, usable: false, reason: settings.enabled ? "no meeting" : "not enabled" };
			for (const fn of mocks.listeners) fn(mocks.status);
			return { ok: true };
		});
		mocks.probe.mockReset().mockResolvedValue({ ok: true });
		control = new DirectModeControl();
	});
	afterEach(() => {
		Object.defineProperty(process, "platform", platform);
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("starts off on the default port without probing or writing settings", async () => {
		await control.start();
		expect(mocks.configure).toHaveBeenLastCalledWith({ enabled: false, port: 9457 });
		await vi.advanceTimersByTimeAsync(15_000);
		expect(mocks.probe).not.toHaveBeenCalled();
		expect(mocks.save).not.toHaveBeenCalled();
	});

	it("restores saved consent and port after restart", async () => {
		mocks.global = { directModeEnabled: true, directModePort: 12345 };
		await control.start();
		expect(mocks.configure).toHaveBeenLastCalledWith({ enabled: true, port: 12345 });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(mocks.probe).toHaveBeenCalledOnce();
	});

	it("toggles at runtime, preserves unrelated globals, and synchronizes every subscriber", async () => {
		mocks.global = { pptAutoProfile: true, anotherSetting: "keep" };
		await control.start();
		const first = vi.fn(), second = vi.fn();
		control.subscribe(first);
		control.subscribe(second);
		expect(await control.toggle()).toEqual({ ok: true });
		expect(mocks.global).toEqual({
			pptAutoProfile: true, anotherSetting: "keep", directModeEnabled: true, directModePort: 9457
		});
		expect(first.mock.lastCall?.[0]).toMatchObject({ enabled: true, busy: false });
		expect(second.mock.lastCall?.[0]).toMatchObject({ enabled: true, busy: false });
		expect(await control.toggle()).toEqual({ ok: true });
		expect(mocks.configure).toHaveBeenLastCalledWith({ enabled: false, port: 9457 });
	});

	it("changes the shared port immediately without implicitly enabling Direct", async () => {
		await control.start();
		expect(await control.setPort(12345)).toEqual({ ok: true });
		expect(mocks.configure).toHaveBeenLastCalledWith({ enabled: false, port: 12345 });
		await control.toggle();
		await control.setPort(54321);
		expect(mocks.configure).toHaveBeenLastCalledWith({ enabled: true, port: 54321 });
	});

	it.each([0, 65536, 12.5, NaN])("rejects invalid port %s without saving it", async (port) => {
		await control.start();
		expect(await control.setPort(port)).toMatchObject({ ok: false });
		expect(mocks.save).not.toHaveBeenCalled();
	});

	it("applies global-settings events and disables Direct for corrupt settings", async () => {
		await control.start();
		mocks.receive?.({ settings: { directModeEnabled: true, directModePort: 12345 } });
		expect(mocks.configure).toHaveBeenLastCalledWith({ enabled: true, port: 12345 });
		mocks.receive?.({ settings: { directModeEnabled: true, directModePort: "bad" } });
		expect(mocks.configure).toHaveBeenLastCalledWith({ enabled: false, port: 9457 });
		expect(control.status.error).toContain("Invalid Direct mode settings");
	});

	it("can repair invalid saved settings through the port field without granting consent", async () => {
		mocks.global = { directModeEnabled: "invalid", directModePort: "invalid" };
		await control.start();
		expect(control.status.error).toContain("Invalid Direct mode settings");
		expect(await control.setPort(12345)).toEqual({ ok: true });
		expect(mocks.global).toEqual({ directModeEnabled: false, directModePort: 12345 });
		expect(control.status.error).toBeUndefined();
	});

	it("reports persistence failures rather than applying unsaved consent", async () => {
		await control.start();
		mocks.configure.mockClear();
		mocks.save.mockRejectedValue(new Error("storage failed"));
		expect(await control.toggle()).toMatchObject({ ok: false, error: expect.stringContaining("storage failed") });
		expect(mocks.configure).not.toHaveBeenCalled();
		expect(control.status.enabled).toBe(false);
		await control.refresh();
		expect(control.status.error).toContain("storage failed");
	});

	it("reports an unresponsive settings store instead of hanging the toggle", async () => {
		await control.start();
		mocks.get.mockImplementation(() => new Promise(() => {}));
		const change = control.toggle();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(await change).toMatchObject({ ok: false, error: expect.stringContaining("timed out") });
		expect(control.status.busy).toBe(false);
		expect(mocks.save).not.toHaveBeenCalled();
	});

	it("reports runtime application failures while retaining the saved preference", async () => {
		await control.start();
		mocks.configure.mockResolvedValue({ ok: false, error: "sidecar not ready" });
		expect(await control.toggle()).toEqual({ ok: false, error: "sidecar not ready" });
		expect(mocks.global.directModeEnabled).toBe(true);
	});

	it("does not execute simultaneous toggles from different keys", async () => {
		await control.start();
		const first = control.toggle();
		const second = control.toggle();
		expect(await second).toMatchObject({ ok: false });
		expect(await first).toEqual({ ok: true });
		expect(mocks.save).toHaveBeenCalledOnce();
	});

	it("preserves profile restart protection during a concurrent Direct mode change", async () => {
		await control.start();
		let release: () => void = () => {};
		const wait = new Promise<void>((resolve) => { release = resolve; });
		mocks.save.mockImplementationOnce(async (settings: JsonObject) => {
			await wait;
			mocks.global = settings;
		});
		const profile = updateGlobalSettings((settings) => ({
			...settings, pptProfilePending: { device: "deck", profile: "profiles/Teams Meeting" }
		}));
		const toggle = control.toggle();
		await vi.advanceTimersByTimeAsync(0);
		release();
		await profile;
		expect(await toggle).toEqual({ ok: true });
		expect(mocks.global).toMatchObject({
			directModeEnabled: true,
			pptProfilePending: { device: "deck", profile: "profiles/Teams Meeting" }
		});
	});

	it("declines runtime changes on macOS", async () => {
		Object.defineProperty(process, "platform", { value: "darwin" });
		expect(await control.toggle()).toMatchObject({ ok: false, error: expect.stringContaining("Windows") });
		expect(mocks.save).not.toHaveBeenCalled();
	});
});

describe("saved Direct mode validation", () => {
	it("defaults to off and requires correctly typed values", () => {
		expect(readDirectModeSettings({})).toEqual({ enabled: false, port: 9457 });
		expect(() => readDirectModeSettings({ directModeEnabled: "true" })).toThrow();
		expect(() => readDirectModeSettings({ directModeEnabled: true, directModePort: null })).toThrow();
	});
});
