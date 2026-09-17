/**
 * The sidecar protocol, kept apart from the process that speaks it.
 *
 * Framing and message mapping are the parts that go wrong quietly — a split
 * payload, a stray carriage return, a field the sidecar stopped sending — and
 * they are pure functions, so they can be tested without a Stream Deck runtime
 * or a live Teams meeting.
 */

/** Snapshot of Teams as reported by the sidecar. */
export type TeamsState = {
	teamsRunning: boolean;
	inMeeting: boolean;
	windowTitle: string;
	states: Record<string, boolean>;
	available: Record<string, boolean>;
	/**
	 * Non-boolean context: the PowerPoint Live role, slide position and deck
	 * name. Kept apart from `states` because keys render these rather than
	 * toggling on them.
	 */
	context: Record<string, string>;
};

export const EMPTY_STATE: TeamsState = {
	teamsRunning: false,
	inMeeting: false,
	windowTitle: "",
	states: {},
	available: {},
	context: {}
};

/**
 * Splits whatever has arrived so far into whole lines, returning the trailing
 * partial line to be carried into the next chunk.
 *
 * stdout arrives in arbitrary pieces: a single JSON message can be delivered
 * across several chunks, and several messages can arrive in one.
 */
export function splitLines(buffered: string): { lines: string[]; rest: string } {
	const lines: string[] = [];
	let rest = buffered;

	let idx: number;
	while ((idx = rest.indexOf("\n")) >= 0) {
		const line = rest.slice(0, idx).trim();
		rest = rest.slice(idx + 1);
		if (line) lines.push(line);
	}

	return { lines, rest };
}

/**
 * Maps a parsed `state` message onto TeamsState.
 *
 * Every field is defaulted, so a sidecar that is older, newer or mid-crash can
 * only ever produce a state that says "nothing is available" — never one with
 * missing properties that would throw further up.
 */
export function toState(msg: Record<string, unknown>): TeamsState {
	return {
		teamsRunning: Boolean(msg["teamsRunning"]),
		inMeeting: Boolean(msg["inMeeting"]),
		windowTitle: String(msg["windowTitle"] ?? ""),
		states: asBoolMap(msg["states"]),
		available: asBoolMap(msg["available"]),
		context: asStringMap(msg["context"])
	};
}

function asBoolMap(value: unknown): Record<string, boolean> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

	const out: Record<string, boolean> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		out[k] = Boolean(v);
	}
	return out;
}

function asStringMap(value: unknown): Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		// A sidecar that started sending a number or null here must not produce
		// "[object Object]" on a key; only real strings are taken.
		if (typeof v === "string") out[k] = v;
	}
	return out;
}
