import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.resolve(__dirname, "..", "sidecar", "MusicModeDom.cs"), "utf8");
const script = source.slice(source.indexOf("(async function () {"), source.lastIndexOf("})()") + 4)
	.replaceAll("{{DomActuator.Js(spec.Menu)}}", JSON.stringify("audio"))
	.replaceAll("{{DomActuator.Js(spec.MenuItemDataTid)}}", JSON.stringify("music"))
	.replaceAll("{{Math.Max(50, timeoutMs - 800)}}", "1700")
	.replaceAll("{{Math.Max(100, timeoutMs - 50)}}", "2450");

type Options = {
	active?: boolean;
	expanded?: boolean;
	missing?: boolean;
	duplicate?: boolean;
	disabled?: boolean;
	indeterminate?: boolean;
	changeBeforeRecheck?: boolean;
	changeAfterRecheck?: boolean;
	replaceAfterRecheck?: boolean;
	disabledAfterRecheck?: boolean;
	staleAtFinalRead?: boolean;
	unknownAfterRecheck?: boolean;
	expireAtFinalRead?: boolean;
	staleBefore?: number;
	staleAfter?: number;
	unknownAfterInitial?: boolean;
	unconfirmed?: boolean;
	clickThrows?: boolean;
	cleanupFails?: boolean;
	busy?: boolean;
};

async function exercise(options: Options = {}) {
	let now = 0, finds = 0, afterWrite = 0, writes = 0, opens = 0, closes = 0;
	let active = options.active ?? false;
	let expanded = options.expanded ?? false;
	let disabled = options.disabled ?? false;
	let generation = 0;
	let disappeared = false;
	const styles = new Set<object>();
	const pending = new Set<object>();
	const window: Record<string, unknown> = options.busy ? { __sdtc_music_operation: {} } : {};
	const initialLease = window.__sdtc_music_operation;
	const input = () => {
		const currentGeneration = generation;
		return {
			tagName: "INPUT", type: "checkbox", get checked() { return active; },
			indeterminate: options.indeterminate ?? false, disabled,
			getAttribute: (name: string) => name === "data-tid" ? "music" : name === "role" ? "switch" : null,
			click() {
				writes++;
				if (currentGeneration !== generation) throw new Error("pressed a replaced control");
				if (options.clickThrows) throw new Error("provider failed after possible write");
				if (!options.unconfirmed) active = !active;
			},
			dispatchEvent() {
				closes++;
				if (!options.cleanupFails) expanded = false;
			}
		};
	};
	const host = {
		getAttribute: (name: string) => name === "aria-expanded" ? String(expanded) : null,
		click() { opens++; expanded = !expanded; },
		dispatchEvent() { closes++; if (!options.cleanupFails) expanded = false; }
	};
	const document = {
		getElementById: (id: string) => id === "audio" ? host : null,
		querySelectorAll() {
			finds++;
			if (!expanded || options.missing || disappeared || finds <= (options.staleBefore ?? 0)) return [];
			if (options.unknownAfterInitial && finds > 1) return [];
			if (options.changeBeforeRecheck && finds === 2) active = !active;
			if (finds === 2) queueMicrotask(() => {
				if (options.changeAfterRecheck) active = !active;
				if (options.replaceAfterRecheck) generation++;
				if (options.disabledAfterRecheck) disabled = true;
				if (options.unknownAfterRecheck) disappeared = true;
			});
			if (options.expireAtFinalRead && finds === 3 && !writes) now = 1700;
			if (options.staleAtFinalRead && finds === 3) return [];
			if (writes && ++afterWrite <= (options.staleAfter ?? 0)) return [];
			return options.duplicate ? [input(), input()] : [input()];
		},
		createElement: () => ({ remove() { styles.delete(this); } }),
		head: { appendChild(style: object) { styles.add(style); } }
	};
	const result = JSON.parse(await runInNewContext(script, {
		document, window,
		Date: { now: () => now },
		KeyboardEvent: class { },
		setTimeout(callback: () => void, ms: number) {
			const timer = {};
			if (ms === 20) { now += ms; queueMicrotask(callback); }
			else pending.add(timer);
			return timer;
		},
		clearTimeout(timer: object) { pending.delete(timer); }
	})) as { ok: boolean; active?: boolean; safeToFallback?: boolean; error?: string };
	expect(styles.size).toBe(0);
	expect(pending.size).toBe(0);
	if (options.busy) expect(window.__sdtc_music_operation).toBe(initialLease);
	else expect(window.__sdtc_music_operation).toBeUndefined();
	return { result, active, expanded, writes, opens, closes };
}

describe("the actual Direct music-mode JavaScript", () => {
	it.each([false, true])("confirms %s -> opposite with exactly one click and Escape-only cleanup", async active => {
		const run = await exercise({ active });
		expect(run.result).toMatchObject({ ok: true, active: !active });
		expect(run.writes).toBe(1);
		expect(run.opens).toBe(1);
		expect(run.closes).toBe(1);
		expect(run.expanded).toBe(false);
	});

	it("preserves an audio flyout that the user already had open", async () => {
		const run = await exercise({ expanded: true });
		expect(run.result.ok).toBe(true);
		expect(run.expanded).toBe(true);
		expect(run.opens).toBe(0);
		expect(run.closes).toBe(0);
	});

	it("re-finds after stale reads before and after the single write", async () => {
		const run = await exercise({ staleBefore: 3, staleAfter: 3 });
		expect(run.result).toMatchObject({ ok: true, active: true });
		expect(run.writes).toBe(1);
	});

	it("does not undo a change already made between the initial read and fresh recheck", async () => {
		const run = await exercise({ changeBeforeRecheck: true });
		expect(run.result).toMatchObject({ ok: true, active: true });
		expect(run.writes).toBe(0);
	});

	it.each([false, true])("does not undo a queued state update after the awaited recheck from %s", async active => {
		const run = await exercise({ active, changeAfterRecheck: true });
		expect(run.result).toMatchObject({ ok: true, active: !active });
		expect(run.active).toBe(!active);
		expect(run.writes).toBe(0);
	});

	it("re-finds a control replaced while the awaited recheck resumes", async () => {
		const run = await exercise({ replaceAfterRecheck: true });
		expect(run.result).toMatchObject({ ok: true, active: true });
		expect(run.writes).toBe(1);
	});

	it("does not press a control disabled while the awaited recheck resumes", async () => {
		const run = await exercise({ disabledAfterRecheck: true });
		expect(run.result).toMatchObject({ ok: false, safeToFallback: false });
		expect(run.result.error).toMatch(/disabled/);
		expect(run.writes).toBe(0);
	});

	it("retries reads when the synchronous final recheck is stale, never the write", async () => {
		const run = await exercise({ staleAtFinalRead: true });
		expect(run.result).toMatchObject({ ok: true, active: true });
		expect(run.writes).toBe(1);
	});

	it("does not use the awaited value when the final recheck remains unavailable", async () => {
		const run = await exercise({ unknownAfterRecheck: true });
		expect(run.result).toMatchObject({ ok: false, safeToFallback: false });
		expect(run.writes).toBe(0);
	});

	it("does not write when the final synchronous read reaches the deadline", async () => {
		const run = await exercise({ expireAtFinalRead: true });
		expect(run.result).toMatchObject({ ok: false, safeToFallback: false });
		expect(run.result.error).toMatch(/deadline/);
		expect(run.writes).toBe(0);
	});

	it.each([
		{ missing: true }, { duplicate: true }, { disabled: true }, { indeterminate: true }
	])("does not click an unknown or unusable control: %o", async options => {
		const run = await exercise(options);
		expect(run.result).toMatchObject({ ok: false, safeToFallback: true });
		expect(run.result.error).toBeTruthy();
		expect(run.writes).toBe(0);
		expect(run.expanded).toBe(false);
	});

	it("cannot blindly fall back after establishing an initial desired state", async () => {
		const run = await exercise({ unknownAfterInitial: true });
		expect(run.result).toMatchObject({ ok: false, safeToFallback: false });
		expect(run.writes).toBe(0);
	});

	it.each([{ unconfirmed: true }, { clickThrows: true }])("never retries an uncertain write: %o", async options => {
		const run = await exercise(options);
		expect(run.result).toMatchObject({ ok: false, safeToFallback: false });
		expect(run.writes).toBe(1);
		expect(run.expanded).toBe(false);
	});

	it("reports partial success explicitly and removes suppression when cleanup fails", async () => {
		const run = await exercise({ cleanupFails: true });
		expect(run.result).toMatchObject({ ok: false, active: true, safeToFallback: false });
		expect(run.result.error).toMatch(/cleanup/);
		expect(run.writes).toBe(1);
		expect(run.opens).toBe(1);
	});

	it("does not start another action while a timed-out script is still running", async () => {
		const run = await exercise({ busy: true });
		expect(run.result.ok).toBe(false);
		expect(run.writes).toBe(0);
		expect(run.opens).toBe(0);
	});
});
