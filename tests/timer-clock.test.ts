import { describe, expect, it } from "vitest";

import { TimerClock } from "../src/timer-clock";

/* -------------------------------------------------------------------------- *
 * Smoothing Teams' timer readings
 *
 * Teams reports whole seconds, floored, and only when the number changes. Those
 * readings reach the plugin late and unevenly, because the sidecar polls and
 * the event loop has slide captures on it. Drawing straight from them steps
 * once a second; re-anchoring on each one stutters, because a late reading
 * pushes the bar back up.
 *
 * These pin the behavior against a synthetic meeting, since the jitter that
 * makes it necessary only appears against a real one.
 * -------------------------------------------------------------------------- */

/** Teams' own label for a true remaining time: whole seconds, floored. */
const reported = (trueRemaining: number): number => Math.max(0, Math.floor(trueRemaining));

describe("TimerClock", () => {
	it("runs down smoothly between readings instead of stepping", () => {
		const clock = new TimerClock();
		const seen: number[] = [];

		// 25 frames a second over two seconds, with a reading that only
		// changes when Teams' own number does.
		for (let f = 0; f <= 50; f++) {
			const now = 1000 + f * 40;
			const trueLeft = 30 - f * 0.04;
			seen.push(clock.update(reported(trueLeft), true, now));
		}

		// More than two distinct values means it is not stepping once a second.
		expect(new Set(seen.map((v) => v.toFixed(2))).size).toBeGreaterThan(40);
	});

	it("never runs backwards when readings arrive late", () => {
		// The bug this exists to stop. Readings land between 150ms and 900ms
		// after Teams' own tick, which is what a polling sidecar on a busy
		// event loop actually does.
		const clock = new TimerClock();
		const lateness = [150, 380, 900, 210, 640, 120, 870, 300];

		let previous = Infinity;
		let ticks = 0;
		let reading = 30;

		for (let ms = 0; ms <= 8000; ms += 40) {
			// Teams ticks every 1000ms; the plugin learns about it later.
			const tick = Math.floor(ms / 1000);
			if (tick > ticks) {
				ticks = tick;
			}
			const late = lateness[ticks % lateness.length];
			const known = ms - (ticks * 1000 + late) >= 0 ? 30 - ticks : 30 - ticks + 1;
			reading = Math.max(0, known);

			const shown = clock.update(reading, true, ms);
			expect(shown, `went backwards at ${ms}ms`).toBeLessThanOrEqual(previous + 1e-9);
			previous = shown;
		}
	});

	it("never reads ahead of the number Teams is showing", () => {
		// Anchoring at the reading itself would put the bar up to a second
		// ahead of the meeting, because Teams floors.
		const clock = new TimerClock();
		for (let ms = 0; ms <= 3000; ms += 40) {
			const trueLeft = 30 - ms / 1000;
			const shown = clock.update(reported(trueLeft), true, ms);
			expect(Math.floor(shown), `at ${ms}ms`).toBeLessThanOrEqual(reported(trueLeft));
		}
	});

	it("follows a reset rather than absorbing it", () => {
		const clock = new TimerClock();
		clock.update(30, true, 0);
		clock.update(30, true, 2000);

		// Reset back to a full minute: far outside ordinary lateness.
		const after = clock.update(59, true, 2040);
		expect(after).toBeGreaterThan(58);
	});

	it("shows the reading exactly while paused, and does not creep", () => {
		const clock = new TimerClock();
		expect(clock.update(42, false, 0)).toBe(42);
		expect(clock.update(42, false, 5000)).toBe(42);
	});

	it("picks up again after a pause without jumping", () => {
		const clock = new TimerClock();
		clock.update(30, true, 0);
		clock.update(30, false, 1000);

		const resumed = clock.update(30, true, 1040);
		expect(resumed).toBeLessThanOrEqual(31);
		expect(resumed).toBeGreaterThan(29);
	});

	it("stops at zero rather than going negative", () => {
		const clock = new TimerClock();
		clock.update(1, true, 0);

		// "0 sec remaining" still covers up to a second of real time, so the
		// bar keeps a sliver - but the clock text has already floored to zero.
		const atZero = clock.update(0, true, 5000);
		expect(atZero).toBeGreaterThanOrEqual(0);
		expect(atZero).toBeLessThan(1);
		expect(Math.floor(atZero)).toBe(0);

		// And it stops there rather than running on into negatives.
		expect(clock.update(0, true, 7000)).toBe(0);
	});

	it("starts clean after being forgotten", () => {
		const clock = new TimerClock();
		clock.update(10, true, 0);
		clock.update(10, true, 900);
		clock.forget();

		// A fresh timer, at a time well past the old anchor.
		expect(clock.update(59, true, 10_000)).toBeGreaterThan(59);
	});
});
