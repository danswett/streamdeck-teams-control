const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

async function main() {
    const { script, scenario } = JSON.parse(fs.readFileSync(0, 'utf8'));
    let clock = 0, reads = 0, generation = 0, writes = 0, opens = 0, closes = 0, removed = 0;
    let expanded = scenario.startsWith('user-open');
    let selected = scenario === 'swap-first' || scenario === 'fresh-already-desired' ||
        scenario === 'select-noop' || scenario === 'user-open-noop' ? 0 :
        scenario === 'swap-second' ? 1 : 2;
    const window = scenario === 'lock' ? { __sdtc_camera_operation: {} } : {};
    const styles = new Map(), timers = new Map();
    let timerId = 0;
    const attr = (name, values) => values[name] ?? null;
    const host = {
        disabled: false,
        getAttribute: name => attr(name, { 'aria-expanded': String(expanded) }),
        click() {
            opens++;
            if (scenario === 'throw-open') { expanded = true; throw Error('navigation failed'); }
            if (scenario !== 'failed-open') expanded = !expanded;
        },
        dispatchEvent(event) {
            assert.equal(event.key, 'Escape');
            closes++;
            if (scenario === 'throw-cleanup') throw Error('cleanup threw');
            if (scenario !== 'cleanup-fails') expanded = false;
        }
    };
    const list = {
        getAttribute: name => attr(name, { 'data-tid': 'camera-settings', role: 'listbox' }),
        querySelectorAll(selector) {
            assert.equal(selector, '[role="option"]');
            reads++;
            const currentGeneration = ++generation;
            if (scenario === 'detach-after-read' && reads === 2) queueMicrotask(() => generation++);
            if (scenario === 'fresh-already-desired' && reads === 2) selected = 1;
            return ['one', 'two', 'third'].flatMap((id, index) => {
                if (scenario === 'missing-second' && index === 1) return [];
                const element = {
                    id,
                    getAttribute(name) {
                        let state = index === selected ? 'true' : 'false';
                        if (scenario === 'unknown-initial' ||
                            (scenario === 'unknown-before-write' && reads >= 2 && !writes) ||
                            (scenario === 'unknown-after-write' && writes) ||
                            (scenario === 'stale-before' && reads >= 2 && reads <= 3) ||
                            (scenario === 'stale-after' && writes && reads <= 4)) state = null;
                        if (scenario === 'both-selected' && index === 0) state = 'true';
                        return attr(name, {
                            'aria-selected': state,
                            'aria-disabled': (scenario === 'disabled-target' ||
                                (scenario === 'disabled-before-write' && reads >= 2)) && index === 0 ? 'true' : null
                        });
                    },
                    click() {
                        assert.equal(currentGeneration, generation, 'must re-find the item immediately before writing');
                        assert.equal(writes++, 0, 'must not retry a camera write');
                        if (scenario === 'throw-write') { selected = index; throw Error('uncertain write'); }
                        if (scenario === 'delayed-auto-close') {
                            timers.set(++timerId, {
                                callback: () => { selected = index; expanded = false; }, due: clock + 40
                            });
                            return;
                        }
                        if (scenario !== 'ignored-write') selected = index;
                        if (scenario === 'auto-close' || scenario === 'user-open-auto-close') expanded = false;
                    }
                };
                if (scenario === 'disabled-second' && index === 1) element.disabled = true;
                return scenario === 'duplicate-id' && index === 0 ? [element, element] : [element];
            });
        }
    };
    const document = {
        getElementById: id => id === 'video-button-configure' ? host : styles.get(id) ?? null,
        querySelectorAll(selector) {
            if (selector === '[role="dialog"],[role="menu"]') return scenario === 'other-dialog' ? [{}] : [];
            assert.equal(selector, '[data-tid]');
            return expanded ? scenario === 'duplicate-container' ? [list, list] : [list] : [];
        },
        createElement(tag) {
            assert.equal(tag, 'style');
            return { remove() { removed++; styles.delete(this.id); } };
        },
        head: { appendChild(style) { styles.set(style.id, style); } }
    };
    const context = {
        document, window, CSS: { escape: value => value }, Date: { now: () => clock },
        KeyboardEvent: function (_, values) { Object.assign(this, values); },
        setTimeout(callback, ms) {
            const id = ++timerId;
            timers.set(id, { callback, due: clock + ms });
            if (ms <= 20) queueMicrotask(() => {
                clock += ms;
                for (const [key, timer] of timers) {
                    if (timer.due <= clock) { timers.delete(key); timer.callback(); }
                }
            });
            return id;
        },
        clearTimeout: id => timers.delete(id)
    };
    const result = JSON.parse(await vm.runInNewContext(script, context, { timeout: 1000 }));
    const failures = new Set([
        'unknown-initial', 'unknown-before-write', 'unknown-after-write', 'disabled-before-write', 'missing-second', 'both-selected',
        'disabled-target', 'disabled-second', 'duplicate-container', 'duplicate-id', 'ignored-write', 'throw-write',
        'other-dialog', 'failed-open', 'throw-open', 'cleanup-fails', 'throw-cleanup', 'lock'
    ]);
    assert.equal(result.ok, !failures.has(scenario), JSON.stringify(result));
    const noWrite = new Set([
        'select-noop', 'fresh-already-desired', 'user-open-noop', 'unknown-initial', 'unknown-before-write',
        'disabled-before-write', 'missing-second', 'both-selected', 'disabled-target', 'disabled-second', 'duplicate-container',
        'duplicate-id', 'other-dialog', 'failed-open', 'throw-open', 'lock'
    ]);
    assert.equal(writes, noWrite.has(scenario) ? 0 : 1);
    if (result.ok) {
        const wanted = scenario === 'swap-first' || scenario === 'fresh-already-desired' ? 'two' : 'one';
        assert.equal(result.selectedId, wanted);
        assert.equal(selected, wanted === 'two' ? 1 : 0);
    }
    if (scenario.startsWith('user-open')) {
        assert.equal(opens, scenario === 'user-open-auto-close' ? 1 : 0, 'must preserve user-owned navigation');
        assert.equal(closes, 0, 'must not close a user-owned flyout');
        assert.equal(removed, 0, 'must not hide a user-owned flyout');
        assert.equal(expanded, true);
    } else if (scenario !== 'lock' && scenario !== 'other-dialog') {
        assert.ok(opens >= 1);
        assert.ok(removed >= 1, 'must remove hiding styles even on failure');
        if (scenario !== 'cleanup-fails' && scenario !== 'throw-cleanup') assert.equal(expanded, false);
    }
    const safe = new Set([
        'unknown-initial', 'disabled-target', 'disabled-second', 'missing-second', 'both-selected',
        'duplicate-container', 'duplicate-id', 'other-dialog', 'failed-open', 'throw-open'
    ]);
    assert.equal(result.safeToFallback === true, safe.has(scenario), JSON.stringify(result));
    assert.equal(styles.size, 0, 'no hiding stylesheet may survive');
    if (scenario === 'throw-write' || scenario === 'ignored-write' || scenario === 'unknown-after-write')
        assert.match(result.error, /may already have changed/);
    if (scenario === 'cleanup-fails' || scenario === 'throw-cleanup')
        assert.match(result.error, /^Webcam selected, but /);
    if (scenario !== 'lock') assert.equal(window.__sdtc_camera_operation, undefined);
    if (scenario === 'auto-close' || scenario === 'delayed-auto-close')
        assert.equal(opens, 2, 'reopen only for fresh confirmation');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
