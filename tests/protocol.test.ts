import { describe, expect, it } from "vitest";
import { EMPTY_STATE, splitLines, toState } from "../src/protocol";

describe("splitLines", () => {
	it("returns whole lines and keeps the trailing partial", () => {
		const { lines, rest } = splitLines('{"a":1}\n{"b":2}\n{"c"');

		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
		expect(rest).toBe('{"c"');
	});

	it("reassembles a message split across chunks", () => {
		// The case that matters: stdout can cut a JSON payload anywhere.
		const first = splitLines('{"type":"sta');
		expect(first.lines).toEqual([]);

		const second = splitLines(first.rest + 'te","inMeeting":true}\n');
		expect(second.lines).toEqual(['{"type":"state","inMeeting":true}']);
		expect(second.rest).toBe("");
	});

	it("handles several messages arriving in one chunk", () => {
		const { lines } = splitLines("a\nb\nc\n");
		expect(lines).toEqual(["a", "b", "c"]);
	});

	it("strips carriage returns so CRLF output still parses", () => {
		const { lines } = splitLines('{"a":1}\r\n');
		expect(lines).toEqual(['{"a":1}']);
	});

	it("drops blank lines rather than emitting empty messages", () => {
		const { lines } = splitLines("a\n\n   \nb\n");
		expect(lines).toEqual(["a", "b"]);
	});

	it("returns nothing for an empty buffer", () => {
		expect(splitLines("")).toEqual({ lines: [], rest: "" });
	});

	it("does not lose a line that has no trailing newline yet", () => {
		const { lines, rest } = splitLines("partial");
		expect(lines).toEqual([]);
		expect(rest).toBe("partial");
	});
});

describe("toState", () => {
	it("maps a full state message", () => {
		const state = toState({
			type: "state",
			teamsRunning: true,
			inMeeting: true,
			windowTitle: "Meeting | Microsoft Teams",
			states: { mute: true, camera: false },
			available: { mute: true, camera: true }
		});

		expect(state).toEqual({
			teamsRunning: true,
			inMeeting: true,
			windowTitle: "Meeting | Microsoft Teams",
			states: { mute: true, camera: false },
			available: { mute: true, camera: true }
		});
	});

	it("defaults every field when the sidecar sends almost nothing", () => {
		// A key must dim, not crash, if the sidecar is older or mid-restart.
		expect(toState({ type: "state" })).toEqual(EMPTY_STATE);
	});

	it("survives states arriving as the wrong shape", () => {
		const state = toState({ states: "nonsense", available: ["also", "wrong"] });

		expect(state.states).toEqual({});
		expect(state.available).toEqual({});
	});

	it("survives a null states object", () => {
		expect(toState({ states: null }).states).toEqual({});
	});

	it("coerces truthy values to real booleans", () => {
		// Anything other than a boolean would flow into setImage decisions.
		const state = toState({ states: { mute: 1, camera: 0 } });

		expect(state.states["mute"]).toBe(true);
		expect(state.states["camera"]).toBe(false);
	});

	it("does not alias EMPTY_STATE, so a later write cannot corrupt it", () => {
		const state = toState({ type: "state" });
		state.states["mute"] = true;

		expect(EMPTY_STATE.states).toEqual({});
	});
});
