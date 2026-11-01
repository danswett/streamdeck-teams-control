import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@elgato/utils";

type Permissions = { accessibility: boolean; screenRecording: boolean };

const mocks = vi.hoisted(() => ({
	global: {} as JsonObject,
	receive: undefined as ((event: { settings: JsonObject }) => void) | undefined,
	request: undefined as ((ev: { payload: unknown; action: { id: string } }) => Promise<void>) | undefined,
	ready: new Set<() => void>(),
	gate: undefined as (() => string | undefined) | undefined,
	get: vi.fn(),
	save: vi.fn(),
	permissions: vi.fn(),
	publish: vi.fn(),
	granted: { accessibility: false, screenRecording: false } as Permissions
}));
vi.mock("@elgato/streamdeck", () => ({
	default: {
		logger: { createScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
		settings: {
			getGlobalSettings: mocks.get,
			setGlobalSettings: mocks.save,
			onDidReceiveGlobalSettings: (fn: typeof mocks.receive) => { mocks.receive = fn; }
		},
		ui: {
			action: { id: "settings" },
			onSendToPlugin: (fn: typeof mocks.request) => { mocks.request = fn; },
			sendToPropertyInspector: mocks.publish
		}
	}
}));
vi.mock("../src/bridge", () => ({
	bridge: {
		permissions: mocks.permissions,
		setGate: (gate: () => string | undefined) => { mocks.gate = gate; },
		onReady: (fn: () => void) => { mocks.ready.add(fn); return () => mocks.ready.delete(fn); }
	}
}));

import { TEAMS_CONTROL_OFF, TeamsControl, type FirstRunAnswer } from "../src/teams-control";

function requested(kind: string): number {
	return mocks.permissions.mock.calls.filter(([arg]) => arg === kind).length;
}

describe("Teams control opt-in on macOS", () => {
	let ask: ReturnType<typeof vi.fn<() => Promise<FirstRunAnswer>>>;

	beforeEach(() => {
		vi.useFakeTimers();
		mocks.global = { other: "keep" };
		mocks.receive = undefined;
		mocks.request = undefined;
		mocks.gate = undefined;
		mocks.ready.clear();
		mocks.granted = { accessibility: false, screenRecording: false };
		mocks.get.mockReset().mockImplementation(async () => structuredClone(mocks.global));
		mocks.save.mockReset().mockImplementation(async (settings: JsonObject) => { mocks.global = structuredClone(settings); });
		mocks.publish.mockReset().mockResolvedValue(undefined);
		mocks.permissions.mockReset().mockImplementation(async (request?: string) => {
			if (request === "accessibility") mocks.granted.accessibility = true;
			if (request === "screen-recording") mocks.granted.screenRecording = true;
			return { ok: true, permissions: { ...mocks.granted } };
		});
		ask = vi.fn<() => Promise<FirstRunAnswer>>();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	async function start(answer: FirstRunAnswer = "dismissed", platform: NodeJS.Platform = "darwin") {
		ask.mockResolvedValue(answer);
		const control = new TeamsControl(ask, platform);
		await control.start();
		await vi.advanceTimersByTimeAsync(0);
		return control;
	}

	it("asks once at first launch and requests Accessibility only on Allow", async () => {
		const control = await start("allow");
		expect(ask).toHaveBeenCalledOnce();
		expect(mocks.global).toEqual({ other: "keep", teamsControlEnabled: true });
		expect(requested("accessibility")).toBe(1);
		expect(requested("screen-recording")).toBe(0);
		expect(mocks.gate?.()).toBeUndefined();
		expect(control.needsSetup).toBe(false);
	});

	it("records Not now without prompting, and refuses every press until it is turned on", async () => {
		const control = await start("decline");
		expect(mocks.global["teamsControlEnabled"]).toBe(false);
		expect(mocks.permissions).not.toHaveBeenCalledWith("accessibility");
		expect(mocks.gate?.()).toBe(TEAMS_CONTROL_OFF);
		expect(control.needsSetup).toBe(true);

		await mocks.request?.({ payload: { event: "teams-control-set", enabled: true }, action: { id: "settings" } });
		expect(requested("accessibility")).toBe(1);
		expect(mocks.gate?.()).toBeUndefined();
	});

	it("leaves an unanswered dialog open for the next launch, without prompting or saving", async () => {
		const control = await start("dismissed");
		expect(mocks.save).not.toHaveBeenCalled();
		expect(mocks.permissions).not.toHaveBeenCalledWith("accessibility");
		expect(mocks.gate?.()).toBe(TEAMS_CONTROL_OFF);
		expect(control.view.enabled).toBeUndefined();
	});

	it("does not ask again once answered, and never prompts on a later launch", async () => {
		mocks.global = { teamsControlEnabled: true };
		mocks.granted.accessibility = true;
		await start("decline");
		for (const fn of mocks.ready) fn();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(ask).not.toHaveBeenCalled();
		expect(mocks.permissions).not.toHaveBeenCalledWith("accessibility");
		expect(mocks.permissions).toHaveBeenCalledWith();
	});

	it("lets a choice made in a key's settings win over a dialog still on screen", async () => {
		let answer: (value: FirstRunAnswer) => void = () => {};
		ask.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
		const control = new TeamsControl(ask, "darwin");
		await control.start();
		await mocks.request?.({ payload: { event: "teams-control-set", enabled: false }, action: { id: "settings" } });
		answer("allow");
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.global["teamsControlEnabled"]).toBe(false);
		expect(mocks.permissions).not.toHaveBeenCalledWith("accessibility");
	});

	it("asks for Accessibility once the sidecar is up if it was allowed before", async () => {
		mocks.permissions.mockResolvedValueOnce({ ok: false, error: "sidecar not ready" });
		await start("allow");
		expect(requested("accessibility")).toBe(1);
		for (const fn of mocks.ready) fn();
		await vi.advanceTimersByTimeAsync(0);
		expect(requested("accessibility")).toBe(2);
	});

	it("shows the setup tile until macOS grants Accessibility, re-checking without prompting", async () => {
		mocks.permissions.mockImplementation(async (request?: string) =>
			({ ok: true, permissions: { ...mocks.granted } }));
		const control = await start("allow");
		expect(control.waitingForMacOS).toBe(true);
		expect(control.needsSetup).toBe(true);
		mocks.granted.accessibility = true;
		await vi.advanceTimersByTimeAsync(5_000);
		expect(control.needsSetup).toBe(false);
		expect(requested("accessibility")).toBe(1);
	});

	it("holds Screen Recording separately: only a slide dial's explicit choice requests it", async () => {
		const control = await start("allow");
		expect(requested("screen-recording")).toBe(0);
		await control.requestScreenRecording();
		expect(requested("screen-recording")).toBe(1);
		expect(control.view.screenRecording).toBe(true);
	});

	it("is a no-op on Windows: no dialog, no gate, no setup tile", async () => {
		const control = await start("allow", "win32");
		expect(ask).not.toHaveBeenCalled();
		expect(mocks.gate).toBeUndefined();
		expect(control.needsSetup).toBe(false);
		expect(control.refusal).toBeUndefined();
		await control.requestScreenRecording();
		expect(mocks.permissions).not.toHaveBeenCalled();
	});

	it("tells the settings page what to show", async () => {
		await start("decline");
		await mocks.request?.({ payload: { event: "teams-control-status" }, action: { id: "settings" } });
		expect(mocks.publish).toHaveBeenLastCalledWith(expect.objectContaining({
			event: "teams-control-status", supported: true, loaded: true, enabled: false, busy: false
		}));
	});
});
