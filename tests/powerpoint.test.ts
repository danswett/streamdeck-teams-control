import type { KeyDownEvent, KeyUpEvent, WillDisappearEvent } from "@elgato/streamdeck";
import type { JsonObject } from "@elgato/utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
	invoke: vi.fn<(target: string, arg?: string) => Promise<{ ok: boolean; error?: string }>>()
}));
vi.mock("@elgato/streamdeck", () => ({
	default: {
		logger: { createScope: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }
	},
	action: () => (target: unknown) => target,
	SingletonAction: class { actions = []; }
}));
vi.mock("../src/bridge", () => ({ bridge: mock }));

import { PptStopPresentingAction } from "../src/actions/powerpoint";

describe("Stop Presenting confirmation", () => {
	let action: PptStopPresentingAction;
	const key = { id: "stop-key", showOk: vi.fn(), showAlert: vi.fn(), setImage: vi.fn() };
	const down = { action: key, payload: { settings: {} } } as KeyDownEvent<JsonObject>;
	const up = { action: key, payload: { settings: {} } } as KeyUpEvent<JsonObject>;
	const disappear = { action: key, payload: { settings: {} } } as WillDisappearEvent<JsonObject>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.clearAllMocks();
		mock.invoke.mockResolvedValue({ ok: true });
		action = new PptStopPresentingAction();
	});
	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("leaves confirmation to the user when released before the hold threshold", async () => {
		await action.onKeyDown(down);
		await vi.advanceTimersByTimeAsync(699);
		await action.onKeyUp(up);
		await vi.advanceTimersByTimeAsync(1000);
		expect(mock.invoke.mock.calls.map(([target]) => target)).toEqual(["ppt-stop-presenting"]);
	});

	it("confirms exactly once after a deliberate hold", async () => {
		await action.onKeyDown(down);
		await vi.advanceTimersByTimeAsync(700);
		expect(mock.invoke.mock.calls.map(([target]) => target)).toEqual([
			"ppt-stop-presenting", "ppt-stop-presenting-confirm"
		]);
		expect(key.showOk).toHaveBeenCalledOnce();
	});

	it("never retries an uncertain destructive confirmation", async () => {
		mock.invoke.mockImplementation(async (target) => target === "ppt-stop-presenting-confirm"
			? { ok: false, error: "debugger disconnected; presentation may already have stopped" }
			: { ok: true });
		await action.onKeyDown(down);
		await vi.advanceTimersByTimeAsync(2000);
		expect(mock.invoke.mock.calls.filter(([target]) => target === "ppt-stop-presenting-confirm")).toHaveLength(1);
		expect(key.showAlert).toHaveBeenCalledOnce();
		expect(key.showOk).not.toHaveBeenCalled();
	});

	it("does not confirm after the key disappears before the hold finishes", async () => {
		await action.onKeyDown(down);
		action.onWillDisappear(disappear);
		await vi.advanceTimersByTimeAsync(1000);
		expect(mock.invoke.mock.calls.map(([target]) => target)).toEqual(["ppt-stop-presenting"]);
	});
});
