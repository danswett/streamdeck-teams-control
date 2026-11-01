import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import AdmZip from "adm-zip";
import type { JsonObject } from "@elgato/utils";
import type { TeamsState } from "../src/protocol";

type VisibleAction = {
	id: string;
	device: { id: string };
	manifestId: string;
	controllerType: string;
	coordinates: { column: number; row: number } | undefined;
};
type Appearance = { action: VisibleAction };

const mocks = vi.hoisted(() => ({
	global: {} as JsonObject,
	state: {} as TeamsState,
	devices: [{ id: "deck", type: 0, isConnected: true }],
	visible: new Map<string, VisibleAction>(),
	appear: new Set<(ev: Appearance) => void>(),
	disappear: new Set<(ev: Appearance) => void>(),
	receive: new Set<(ev: { settings: JsonObject }) => void>(),
	request: new Set<(ev: { payload: { event: string; enabled: boolean }; action: { id: string } }) => Promise<void>>(),
	connect: new Set<(ev: { device: { id: string } }) => void>(),
	listeners: new Set<(state: TeamsState) => void>(),
	get: vi.fn(),
	save: vi.fn(),
	switch: vi.fn(),
	warn: vi.fn(),
	publish: vi.fn(),
	land: true,
	nextId: 0
}));

vi.mock("@elgato/streamdeck", async (importOriginal) => {
	const original = await importOriginal<typeof import("@elgato/streamdeck")>();
	return {
		...original,
		default: {
			logger: { createScope: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn }) },
			settings: {
				getGlobalSettings: mocks.get,
				setGlobalSettings: mocks.save,
				onDidReceiveGlobalSettings: (fn: (ev: { settings: JsonObject }) => void) => {
					mocks.receive.add(fn);
				}
			},
			devices: {
				[Symbol.iterator]: () => mocks.devices.values(),
				onDeviceDidConnect: (fn: (ev: { device: { id: string } }) => void) => {
					mocks.connect.add(fn);
				}
			},
			actions: {
				[Symbol.iterator]: () => mocks.visible.values(),
				onWillAppear: (fn: (ev: Appearance) => void) => {
					mocks.appear.add(fn);
					return { dispose: () => mocks.appear.delete(fn) };
				},
				onWillDisappear: (fn: (ev: Appearance) => void) => {
					mocks.disappear.add(fn);
					return { dispose: () => mocks.disappear.delete(fn) };
				}
			},
			profiles: { switchToProfile: mocks.switch },
			ui: {
				action: { id: "settings" },
				onSendToPlugin: (fn: (ev: { payload: { event: string; enabled: boolean }; action: { id: string } }) => Promise<void>) => {
					mocks.request.add(fn);
				},
				sendToPropertyInspector: mocks.publish
			}
		}
	};
});
vi.mock("../src/bridge", () => ({
	bridge: {
		get state() { return mocks.state; },
		subscribe: (fn: (state: TeamsState) => void) => {
			mocks.listeners.add(fn);
			fn(mocks.state);
			return () => mocks.listeners.delete(fn);
		}
	}
}));

import { ATTENDEE, MEETING, PRESENTER, ProfileSwitcher, profilePath } from "../src/profiles";
import { EMPTY_STATE } from "../src/protocol";

function updateState(over: Partial<TeamsState>): void {
	mocks.state = { ...mocks.state, ...over };
	for (const fn of mocks.listeners) fn(mocks.state);
}

function following(enabled: boolean): void {
	for (const fn of mocks.request) {
		void fn({ payload: { event: "profile-following-set", enabled }, action: { id: "settings" } });
	}
}

function showLayout(device: string, profile?: string): void {
	for (const [id, action] of [...mocks.visible]) {
		if (action.device.id !== device) continue;
		mocks.visible.delete(id);
		for (const fn of [...mocks.disappear]) fn({ action });
	}
	if (!profile) return;

	const archive = new AdmZip(path.join("com.bad-duck.teamscontrol.sdPlugin", `${profile}.streamDeckProfile`));
	const entry = archive.getEntries().find((item) =>
		item.entryName.includes("/Profiles/") && item.entryName.endsWith("manifest.json")
		&& item.getData().toString("utf8").includes("teamscontrol")
	);
	if (!entry) throw new Error(`No actions in ${profile}`);
	const page = JSON.parse(entry.getData().toString("utf8")) as {
		Controllers: { Type: string; Actions: Record<string, { UUID: string }> | null }[];
	};
	for (const controller of page.Controllers) {
		for (const [position, placed] of Object.entries(controller.Actions ?? {})) {
			if (!placed.UUID.startsWith("com.bad-duck.teamscontrol.")) continue;
			const [column, row] = position.split(",").map(Number);
			const action: VisibleAction = {
				id: `action-${++mocks.nextId}`, device: { id: device },
				manifestId: placed.UUID, controllerType: controller.Type, coordinates: { column, row }
			};
			mocks.visible.set(action.id, action);
			for (const fn of [...mocks.appear]) fn({ action });
		}
	}
}

function addExtraControl(): VisibleAction {
	const placed = [...mocks.visible.values()].filter((action) => action.device.id === "deck");
	const coordinates = Array.from({ length: 15 }, (_, index) => ({
		column: index % 5, row: Math.floor(index / 5)
	})).find((position) => !placed.some((action) =>
		action.coordinates?.column === position.column && action.coordinates.row === position.row
	));
	if (!coordinates) throw new Error("The fixture has no free key position");
	const action: VisibleAction = {
		id: `extra-${++mocks.nextId}`, device: { id: "deck" },
		manifestId: "com.bad-duck.teamscontrol.mute", controllerType: "Keypad", coordinates
	};
	mocks.visible.set(action.id, action);
	for (const fn of [...mocks.appear]) fn({ action });
	return action;
}

async function start(): Promise<ProfileSwitcher> {
	const switcher = new ProfileSwitcher();
	await switcher.start();
	await vi.advanceTimersByTimeAsync(0);
	return switcher;
}

async function change(over: Partial<TeamsState>): Promise<void> {
	updateState(over);
	await vi.advanceTimersByTimeAsync(1000);
}

const presenting: Partial<TeamsState> = {
	states: { "ppt-live": true }, context: { "ppt.role": "presenter" }
};

describe("automatic profile installation policy", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mocks.global = { pptAutoProfile: true, directModeEnabled: true, directModePort: 9457, other: "keep" };
		mocks.state = { ...EMPTY_STATE, teamsRunning: true, inMeeting: true };
		mocks.devices = [{ id: "deck", type: 0, isConnected: true }];
		mocks.visible.clear();
		mocks.appear.clear();
		mocks.disappear.clear();
		mocks.receive.clear();
		mocks.request.clear();
		mocks.connect.clear();
		mocks.listeners.clear();
		mocks.warn.mockReset();
		mocks.publish.mockReset().mockResolvedValue(undefined);
		mocks.land = true;
		mocks.nextId = 0;
		mocks.get.mockReset().mockImplementation(async () => {
			const settings = structuredClone(mocks.global);
			// SDK reads also emit global-settings events; they are not user consent.
			for (const fn of mocks.receive) fn({ settings });
			return settings;
		});
		mocks.save.mockReset().mockImplementation(async (settings: JsonObject) => {
			mocks.global = structuredClone(settings);
			for (const fn of mocks.receive) fn({ settings: structuredClone(settings) });
		});
		mocks.switch.mockReset().mockImplementation(async (device: string, profile?: string) => {
			if (mocks.land || profile === undefined) showLayout(device, profile);
		});
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("does not retry a cancelled or unanswered install after role changes or reconnects", async () => {
		mocks.land = false;
		await start();
		await vi.advanceTimersByTimeAsync(10_000);
		await change(presenting);
		await change({ states: {}, context: {} });
		await change({ inMeeting: false });
		await change({ inMeeting: true });
		for (const fn of mocks.connect) fn({ device: { id: "deck" } });
		await vi.advanceTimersByTimeAsync(60_000);
		// The request is still handed back once, so smart profiles resume; it is never re-sent.
		expect(mocks.switch.mock.calls).toEqual([["deck", profilePath(MEETING, 0)], ["deck"]]);
		expect(mocks.global.pptProfilePending).toEqual({
			device: "deck", profile: profilePath(MEETING, 0)
		});
		expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("paused"));
	});

	it("remembers an unconfirmed request across plugin restarts", async () => {
		mocks.land = false;
		await start();
		await vi.advanceTimersByTimeAsync(10_000);
		mocks.receive.clear();
		mocks.request.clear();
		mocks.connect.clear();
		mocks.listeners.clear();
		mocks.switch.mockClear();
		await start();
		await change(presenting);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.switch).not.toHaveBeenCalled();
	});

	it("does not re-arm an open install prompt when restarted before its observation timeout", async () => {
		mocks.land = false;
		await start();
		expect(mocks.switch).toHaveBeenCalledOnce();
		mocks.receive.clear();
		mocks.request.clear();
		mocks.connect.clear();
		mocks.listeners.clear();
		mocks.switch.mockClear();
		await start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.switch).not.toHaveBeenCalled();
	});

	it("retries only after the user explicitly disables and re-enables following", async () => {
		mocks.land = false;
		await start();
		await vi.advanceTimersByTimeAsync(10_000);
		following(false);
		await vi.advanceTimersByTimeAsync(1000);
		mocks.land = true;
		following(true);
		await vi.advanceTimersByTimeAsync(5000);
		expect(mocks.switch.mock.calls).toEqual([
			["deck", profilePath(MEETING, 0)], ["deck"], ["deck", profilePath(MEETING, 0)]
		]);
		expect(mocks.global.pptProfilePending).toBeUndefined();
		expect(mocks.global).toMatchObject({
			pptAutoProfile: true, directModeEnabled: true, directModePort: 9457, other: "keep"
		});
		await change(presenting);
		expect(mocks.switch).toHaveBeenLastCalledWith("deck", profilePath(PRESENTER, 0));
	});

	it("continues following confirmed layouts and restores the previous profile when the meeting ends", async () => {
		await start();
		await vi.advanceTimersByTimeAsync(1000);
		await change(presenting);
		await change({ states: { "ppt-live": true }, context: { "ppt.role": "attendee" } });
		await change({ states: {}, context: {} });
		await change({ inMeeting: false });
		expect(mocks.switch.mock.calls).toEqual([
			["deck", profilePath(MEETING, 0)], ["deck", profilePath(PRESENTER, 0)],
			["deck", profilePath(ATTENDEE, 0)], ["deck", profilePath(MEETING, 0)], ["deck"]
		]);
		expect(mocks.global.pptProfilePending).toBeUndefined();
	});

	it("claims an already-visible layout that is not redrawn, and hands it back after the meeting", async () => {
		showLayout("deck", profilePath(MEETING, 0)!);
		// Switching to the profile already on screen may redraw nothing at all.
		mocks.switch.mockImplementation(async (device: string, profile?: string) => {
			if (profile === undefined) showLayout(device);
		});
		await start();
		await vi.advanceTimersByTimeAsync(2000);
		expect(mocks.switch.mock.calls).toEqual([["deck", profilePath(MEETING, 0)]]);
		expect(mocks.global.pptProfilePending).toBeUndefined();
		for (const fn of mocks.connect) fn({ device: { id: "deck" } });
		await vi.advanceTimersByTimeAsync(20_000);
		expect(mocks.global.pptProfilePending).toBeUndefined();
		expect(mocks.warn).not.toHaveBeenCalled();
		await change({ inMeeting: false });
		expect(mocks.switch).toHaveBeenLastCalledWith("deck");
	});

	it("claims an already-visible layout that Stream Deck redraws", async () => {
		showLayout("deck", profilePath(MEETING, 0)!);
		await start();
		await vi.advanceTimersByTimeAsync(2000);
		expect(mocks.switch.mock.calls).toEqual([["deck", profilePath(MEETING, 0)]]);
		expect(mocks.global.pptProfilePending).toBeUndefined();
		await change(presenting);
		expect(mocks.switch).toHaveBeenLastCalledWith("deck", profilePath(PRESENTER, 0));
	});

	it("does not confirm an already-visible claim while the layout is still changing", async () => {
		showLayout("deck", profilePath(MEETING, 0)!);
		mocks.switch.mockImplementation(async () => {
			const timer = setInterval(() => {
				const extra = addExtraControl();
				mocks.visible.delete(extra.id);
				for (const fn of [...mocks.disappear]) fn({ action: extra });
			}, 300);
			setTimeout(() => clearInterval(timer), 12_000);
		});
		await start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocks.global.pptProfilePending).toBeDefined();
		expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("paused"));
	});

	it.each(["modified", "deleted"])("stops re-requesting a previously installed profile after it is %s", async (operation) => {
		await start();
		await vi.advanceTimersByTimeAsync(1000);
		await change(presenting);
		if (operation === "deleted") showLayout("deck");
		else {
			const first = mocks.visible.values().next().value!;
			first.coordinates = { column: 99, row: 99 };
		}
		const before = [...mocks.visible];
		mocks.land = false;
		await change({ states: {}, context: {} });
		await vi.advanceTimersByTimeAsync(10_000);
		await change(presenting);
		await change({ states: {}, context: {} });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(mocks.switch).toHaveBeenCalledTimes(3);
		expect([...mocks.visible]).toEqual(before);
		expect(mocks.global.pptProfilePending).toEqual({
			device: "deck", profile: profilePath(MEETING, 0)
		});
	});

	it("does not mistake an unrelated plugin key or a different layout for confirmation", async () => {
		mocks.land = false;
		await start();
		showLayout("other-deck", profilePath(MEETING, 0)!);
		showLayout("deck", profilePath(PRESENTER, 0)!);
		await vi.advanceTimersByTimeAsync(10_000);
		await change(presenting);
		expect(mocks.switch).toHaveBeenCalledOnce();
		expect(mocks.global.pptProfilePending).toBeDefined();
	});

	it("does not stack another deck's install on an unconfirmed request", async () => {
		mocks.devices.push({ id: "second", type: 2, isConnected: true });
		mocks.land = false;
		await start();
		await vi.advanceTimersByTimeAsync(30_000);
		expect(mocks.switch.mock.calls).toEqual([["deck", profilePath(MEETING, 0)]]);
	});

	it("does not send a request if its restart protection cannot be saved", async () => {
		mocks.save.mockRejectedValue(new Error("storage failed"));
		await start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocks.switch).not.toHaveBeenCalled();
		expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining("storage failed"));
	});

	it("does not treat a settings refresh as permission to retry", async () => {
		mocks.land = false;
		await start();
		await vi.advanceTimersByTimeAsync(10_000);
		for (const enabled of [false, true, true]) {
			for (const fn of mocks.receive) fn({ settings: { ...mocks.global, pptAutoProfile: enabled } });
		}
		await change(presenting);
		expect(mocks.switch).toHaveBeenCalledOnce();
	});

	it("allows an inspector to recover an initial settings failure without automatically re-arming following", async () => {
		mocks.get.mockRejectedValueOnce(new Error("not ready"));
		await start();
		expect(mocks.switch).not.toHaveBeenCalled();
		for (const fn of mocks.request) {
			await fn({ payload: { event: "profile-following-status", enabled: false }, action: { id: "settings" } });
		}
		await vi.advanceTimersByTimeAsync(0);
		expect(mocks.switch).not.toHaveBeenCalled();
		expect(mocks.publish.mock.lastCall?.[0]).toMatchObject({ loaded: true, error: "" });
		following(false);
		await vi.advanceTimersByTimeAsync(1000);
		following(true);
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.switch).toHaveBeenCalledOnce();
		expect(mocks.global.pptProfilePending).toBeUndefined();
	});

	it("keeps a failed settings load visible after the inspector asks for status", async () => {
		mocks.get.mockRejectedValue(new Error("settings unavailable"));
		await start();
		for (const fn of mocks.request) {
			await fn({ payload: { event: "profile-following-status", enabled: false }, action: { id: "settings" } });
		}
		expect(mocks.publish.mock.lastCall?.[0]).toMatchObject({
			loaded: false, error: expect.stringContaining("settings unavailable")
		});
	});

	it("does not replace explicit startup consent with a late, older settings reply", async () => {
		let release: (settings: JsonObject) => void = () => {};
		const initial = new Promise<JsonObject>((resolve) => { release = resolve; });
		mocks.get.mockImplementationOnce(() => initial);
		const switcher = new ProfileSwitcher();
		const loading = switcher.start();
		following(false);
		await vi.advanceTimersByTimeAsync(1000);
		release({ pptAutoProfile: true });
		await loading;
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.switch).not.toHaveBeenCalled();
		expect(mocks.global.pptAutoProfile).toBe(false);
	});

	it("does not lose an explicit disable while an older restart-guard write is pending", async () => {
		let release: () => void = () => {};
		const wait = new Promise<void>((resolve) => { release = resolve; });
		mocks.save.mockImplementationOnce(async (settings: JsonObject) => {
			await wait;
			mocks.global = structuredClone(settings);
			for (const fn of mocks.receive) fn({ settings: structuredClone(settings) });
		});
		await start();
		following(false);
		release();
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.switch).not.toHaveBeenCalled();
		expect(mocks.global.pptAutoProfile).toBe(false);
		expect(mocks.global.pptProfilePending).toBeUndefined();
	});

	it("skips a stale queued target if the meeting ends during its settings write", async () => {
		let release: () => void = () => {};
		const wait = new Promise<void>((resolve) => { release = resolve; });
		mocks.save.mockImplementationOnce(async (settings: JsonObject) => {
			await wait;
			mocks.global = settings;
		});
		await start();
		updateState({ inMeeting: false });
		release();
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.switch).not.toHaveBeenCalled();
		expect(mocks.global.pptProfilePending).toBeUndefined();
	});

	it("keeps uncertain SDK errors paused and disposes their observation", async () => {
		mocks.switch.mockRejectedValue(new Error("delivery uncertain"));
		await start();
		await vi.advanceTimersByTimeAsync(30_000);
		await change(presenting);
		expect(mocks.switch).toHaveBeenCalledOnce();
		expect(mocks.global.pptProfilePending).toBeDefined();
		expect(mocks.appear.size).toBe(0);
		expect(mocks.disappear.size).toBe(0);
	});

	it("hands the deck back after the user edits a confirmed layout, so smart profiles resume", async () => {
		await start();
		await vi.advanceTimersByTimeAsync(1000);
		const first = mocks.visible.values().next().value!;
		first.coordinates = { column: 99, row: 99 };
		await change({ inMeeting: false });
		expect(mocks.switch.mock.calls).toEqual([["deck", profilePath(MEETING, 0)], ["deck"]]);
	});

	it("hands back a customized profile whose layout was never confirmed when the meeting ends", async () => {
		mocks.switch.mockImplementation(async (device: string, profile?: string) => {
			showLayout(device, profile);
			if (profile) addExtraControl();
		});
		await start();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocks.global.pptProfilePending).toBeDefined();
		await change({ inMeeting: false });
		await vi.advanceTimersByTimeAsync(5000);
		expect(mocks.switch.mock.calls).toEqual([["deck", profilePath(MEETING, 0)], ["deck"]]);
		await change({ inMeeting: true });
		await change({ inMeeting: false });
		expect(mocks.switch).toHaveBeenCalledTimes(2);
	});

	it("hands back an unconfirmed profile when following is turned off mid-meeting", async () => {
		mocks.land = false;
		await start();
		await vi.advanceTimersByTimeAsync(10_000);
		following(false);
		await vi.advanceTimersByTimeAsync(5000);
		expect(mocks.switch.mock.calls).toEqual([["deck", profilePath(MEETING, 0)], ["deck"]]);
	});

	it("allows an accepted installation to finish within the observation budget", async () => {
		mocks.land = false;
		await start();
		await vi.advanceTimersByTimeAsync(8000);
		showLayout("deck", profilePath(MEETING, 0)!);
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.global.pptProfilePending).toBeUndefined();
		mocks.land = true;
		await change(presenting);
		expect(mocks.switch).toHaveBeenCalledTimes(2);
	});

	it("confirms the new layout when old controls disappear after the new controls appear", async () => {
		await start();
		await vi.advanceTimersByTimeAsync(1000);
		const previous = [...mocks.visible];
		mocks.switch.mockImplementationOnce(async (device: string, profile: string) => {
			showLayout(device, profile);
			for (const [id, action] of previous) mocks.visible.set(id, action);
			setTimeout(() => {
				for (const [id, action] of previous) {
					mocks.visible.delete(id);
					for (const fn of [...mocks.disappear]) fn({ action });
				}
			}, 100);
		});
		await change(presenting);
		expect(mocks.global.pptProfilePending).toBeUndefined();
		expect(mocks.switch).toHaveBeenCalledTimes(2);
	});

	it("does not confirm a transient match before a customized layout's extra key appears", async () => {
		mocks.switch.mockImplementation(async (device: string, profile: string) => {
			showLayout(device, profile);
			setTimeout(addExtraControl, 100);
		});
		await start();
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.global.pptProfilePending).toBeDefined();
		await change(presenting);
		await vi.advanceTimersByTimeAsync(10_000);
		expect(mocks.switch).toHaveBeenCalledOnce();
	});

	it("revalidates the settled layout after the asynchronous settings read, before clearing the guard", async () => {
		let release: () => void = () => {};
		const wait = new Promise<void>((resolve) => { release = resolve; });
		const get = mocks.get.getMockImplementation()!;
		let reads = 0;
		mocks.get.mockImplementation(async () => {
			if (++reads === 3) await wait;
			return get();
		});
		await start();
		await vi.advanceTimersByTimeAsync(500);
		addExtraControl();
		release();
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.global.pptProfilePending).toBeDefined();
		await change(presenting);
		expect(mocks.switch).toHaveBeenCalledOnce();
	});

	it("does not clear the guard if the layout changed and rematched during the settings read", async () => {
		let release: () => void = () => {};
		const wait = new Promise<void>((resolve) => { release = resolve; });
		const get = mocks.get.getMockImplementation()!;
		let reads = 0;
		mocks.get.mockImplementation(async () => {
			if (++reads === 3) await wait;
			return get();
		});
		await start();
		await vi.advanceTimersByTimeAsync(500);
		const extra = addExtraControl();
		await vi.advanceTimersByTimeAsync(100);
		mocks.visible.delete(extra.id);
		for (const fn of [...mocks.disappear]) fn({ action: extra });
		release();
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.global.pptProfilePending).toBeDefined();
		await change(presenting);
		expect(mocks.switch).toHaveBeenCalledOnce();
	});

	it("does not clear an expired confirmation after a delayed settings read and releases its observers", async () => {
		let release: () => void = () => {};
		const wait = new Promise<void>((resolve) => { release = resolve; });
		const get = mocks.get.getMockImplementation()!;
		let reads = 0;
		mocks.get.mockImplementation(async () => {
			if (++reads === 3) await wait;
			return get();
		});
		await start();
		await vi.advanceTimersByTimeAsync(9200);
		expect(mocks.appear.size).toBe(0);
		expect(mocks.disappear.size).toBe(0);
		release();
		await vi.advanceTimersByTimeAsync(1000);
		expect(mocks.global.pptProfilePending).toBeDefined();
		await change(presenting);
		expect(mocks.switch).toHaveBeenCalledOnce();
	});

	it("waits for the layout to stabilize after a temporary extra key disappears", async () => {
		mocks.switch.mockImplementation(async (device: string, profile: string) => {
			showLayout(device, profile);
			setTimeout(() => {
				const extra = addExtraControl();
				setTimeout(() => {
					mocks.visible.delete(extra.id);
					for (const fn of [...mocks.disappear]) fn({ action: extra });
				}, 100);
			}, 100);
		});
		await start();
		await vi.advanceTimersByTimeAsync(500);
		expect(mocks.global.pptProfilePending).toBeDefined();
		await vi.advanceTimersByTimeAsync(500);
		expect(mocks.global.pptProfilePending).toBeUndefined();
	});

	it.each([0, 1, 2, 7, 9, 13])("recognizes complete layouts on device type %s", async (type) => {
		mocks.devices[0].type = type;
		await start();
		await vi.advanceTimersByTimeAsync(1000);
		await change(presenting);
		await change({ inMeeting: false });
		expect(mocks.switch.mock.calls).toEqual([
			["deck", profilePath(MEETING, type)], ["deck", profilePath(PRESENTER, type)], ["deck"]
		]);
		expect(mocks.global.pptProfilePending).toBeUndefined();
	});
});
