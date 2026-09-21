/**
 * Smoothing Teams' meeting-timer readings into something drawable per frame.
 *
 * Kept apart from the dial that uses it because it is arithmetic rather than a
 * Stream Deck action, which is what lets it be tested without the SDK.
 */

/**
 * How far out a reading has to be before the bar is allowed to jump to it.
 *
 * Under this it is treated as ordinary lateness and ignored; over it, the timer
 * has genuinely been reset or replaced and the bar should follow at once.
 */
const RESYNC_S = 2;

/**
 * Turns Teams' readings into something that can be drawn every frame.
 *
 * Teams reports whole seconds, floored, and the sidecar publishes only when
 * that number changes - so a bar drawn straight from it steps once a second.
 * Worse, those readings arrive late and unevenly, because the sidecar polls and
 * the event loop has slide captures on it. Re-anchoring on each one nudges the
 * bar backwards about as often as forwards, which reads as a stutter even
 * though the error is a fraction of a second.
 *
 * So each reading is an anchor, time is carried forward from it between
 * readings, and the result is never allowed to run backwards unless the timer
 * has really been reset.
 *
 * Exported for tests: the jitter that makes this necessary only appears against
 * a live meeting, so the behavior is pinned against a synthetic one.
 */
export class TimerClock {
	#anchor: number | undefined;
	#anchorAt = 0;
	#lastReading: number | undefined;
	#shown: number | undefined;

	forget(): void {
		this.#anchor = undefined;
		this.#anchorAt = 0;
		this.#lastReading = undefined;
		this.#shown = undefined;
	}

	/**
	 * @param reading whole seconds remaining, as Teams reports them
	 * @param moving whether the timer is actually counting down
	 * @param now milliseconds, from the same clock each call
	 */
	update(reading: number, moving: boolean, now: number): number {
		if (reading !== this.#lastReading) {
			this.#lastReading = reading;
			// Teams floors what it reports, so a label of N means the true
			// remaining is somewhere in [N, N+1). Anchoring at N alone would
			// run the bar up to a second ahead of the meeting.
			this.#anchor = reading + 0.999;
			this.#anchorAt = now;
		}

		if (!moving) {
			this.#shown = undefined;
			return reading;
		}

		let live = Math.max(0, (this.#anchor ?? reading) - (now - this.#anchorAt) / 1000);

		// Ordinary lateness is absorbed; a real reset is followed.
		if (this.#shown !== undefined && live > this.#shown && live - this.#shown < RESYNC_S) {
			live = this.#shown;
		}

		this.#shown = live;
		return live;
	}
}
