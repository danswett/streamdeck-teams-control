const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

async function main() {
    const { script, scenario } = JSON.parse(fs.readFileSync(0, 'utf8'));
    let clock = 0, selected = scenario === 'swap-first' ? 0 : scenario === 'swap-second' ? 1 :
        scenario === 'camera-noop' ? 0 : 2;
    const desired = scenario === 'swap-first' ? 1 : 0;
    const originalPane = scenario.startsWith('user-pane');
    const originalFlyout = scenario.startsWith('user-flyout');
    const cleanupFailures = new Set(['ignored-close', 'throw-close', 'missing-close', 'user-pane-restore-fails']);
    const originalTab = scenario === 'user-pane-settings' ? 'Settings' : 'Video effects';
    let expanded = originalFlyout, paneVisible = originalPane, tab = originalTab;
    let cameraWrites = 0, opens = 0, paneOpens = 0, paneCloses = 0, dismisses = 0, tabWrites = 0;
    const values = { 'Mirror my video': desired === 1, 'Soft focus': desired === 0, 'Adjust brightness': desired === 1 };
    if (scenario === 'preferences-noop') Object.assign(values, {
        'Mirror my video': true, 'Soft focus': false, 'Adjust brightness': true
    });
    const writes = Object.fromEntries(Object.keys(values).map(name => [name, 0]));
    const reads = Object.fromEntries(Object.keys(values).map(name => [name, 0]));
    const generations = { ...reads };
    const timers = new Map(), styles = new Map(), window = {};
    let timerId = 0;
    const schedule = (callback, ms) => {
        const id = ++timerId;
        timers.set(id, { callback, due: clock + ms });
        if (ms <= 20) queueMicrotask(() => {
            clock += ms;
            for (const [key, timer] of timers) {
                if (timer.due <= clock) { timers.delete(key); timer.callback(); }
            }
        });
        return id;
    };
    const attr = (name, values) => values[name] ?? null;
    const css = () => [...styles.values()].map(style => style.textContent).join('');
    const button = (name, click, title = false) => ({
        textContent: title ? '' : name,
        getAttribute: attribute => attr(attribute, { [title ? 'title' : 'aria-label']: name }),
        click
    });
    const toggles = scope => Object.keys(values).flatMap(name => {
        if ((scope === 'flyout') === (name === 'Mirror my video')) return [];
        if (scope === 'pane' && tab !== 'Settings') return [];
        if (scenario === 'missing-switch' && name === 'Soft focus') return [];
        const generation = ++generations[name];
        reads[name]++;
        if (scenario === 'fresh-already-desired' && name === 'Soft focus' && reads[name] === 2)
            values[name] = false;
        if (scenario === 'detach-before-write') queueMicrotask(() => generations[name]++);
        const trouble = name === 'Soft focus';
        const unknown = trouble && (scenario === 'unknown-initial' ||
            scenario === 'unknown-before-write' && reads[name] === 2 ||
            scenario === 'unknown-after-write' && writes[name] ||
            scenario === 'stale-after-write' && writes[name] && reads[name] <= 4);
        const checked = values[name];
        return [{
            isConnected: true, checked, textContent: '', disabled: trouble && scenario === 'disabled-switch',
            indeterminate: trouble && scenario === 'indeterminate',
            getAttribute: attribute => attr(attribute, {
                'aria-label': name,
                'aria-checked': unknown ? 'mixed' : trouble && scenario === 'contradictory-state' ? String(!checked) : null
            }),
            click() {
                assert.equal(selected, desired, 'preferences must apply only to the selected destination');
                assert.equal(generation, generations[name], 'must re-find the checkbox immediately before writing');
                assert.equal(writes[name]++, 0, 'must never repeat a preference write');
                assert.ok(clock < 1500, 'must not write after the operation deadline');
                if (!(trouble && scenario === 'ignored-write') &&
                    !(name === 'Mirror my video' && scenario === 'mirror-ignored-write')) values[name] = !checked;
                if (trouble && scenario === 'throw-write') throw Error('uncertain preference write');
                if (trouble && scenario === 'camera-changed') selected = 2;
                if (name === 'Mirror my video' && scenario === 'camera-changed-after-mirror') selected = 2;
            }
        }];
    });
    const tabs = {
        querySelectorAll(selector) {
            assert.equal(selector, '[role="tab"]');
            return ['Video effects', 'Avatars', 'Settings'].filter(name =>
                !(scenario.endsWith('missing-tab') && name === 'Settings')).map(name => ({
                textContent: name,
                getAttribute: attribute => attr(attribute, {
                    'aria-label': name,
                    'aria-selected': scenario === 'unknown-tab' ? null : String(tab === name)
                }),
                click() {
                    tabWrites++;
                    if (scenario !== 'ignored-tab') tab = name;
                }
            }));
        }
    };
    const close = button('Close video effects and settings pane', () => {
        paneCloses++;
        if (scenario === 'throw-close') throw Error('close failed');
        if (scenario !== 'ignored-close') paneVisible = false;
    }, true);
    const panel = {
        getAttribute: name => attr(name, { 'data-tid': 'calling-right-side-panel', role: 'complementary' }),
        contains: el => el === tabs,
        querySelectorAll(selector) {
            if (selector === 'button') return scenario === 'missing-close' ? [] : [close];
            assert.equal(selector, 'input[type="checkbox"][role="switch"]');
            return toggles('pane');
        }
    };
    const more = button('More video effects and settings', () => {
        paneOpens++;
        if (!originalPane) assert.match(css(), /calling-right-side-panel/, 'hide before opening the pane');
        else assert.doesNotMatch(css(), /calling-right-side-panel/, 'do not hide a user-owned pane');
        if (scenario === 'pane-open-fails') return;
        if (scenario === 'late-pane') {
            schedule(() => { paneVisible = true; expanded = false; }, 1600 - clock);
            return;
        }
        if (scenario === 'user-pane-restore-fails' && paneOpens > 1) return;
        paneVisible = true;
        expanded = false;
        tab = 'Video effects';
    });
    const flyout = {
        querySelectorAll(selector) {
            if (selector === 'button') return [more];
            assert.equal(selector, 'input[type="checkbox"][role="switch"]');
            return toggles('flyout');
        }
    };
    const host = {
        getAttribute: name => attr(name, { 'aria-expanded': String(expanded) }),
        click() {
            opens++;
            if (!originalFlyout) assert.match(css(), /camera-settings/, 'hide before opening camera options');
            expanded = !expanded;
            if (expanded && (!cleanupFailures.has(scenario) || scenario === 'user-pane-restore-fails'))
                paneVisible = false;
        },
        dispatchEvent(event) {
            assert.equal(event.key, 'Escape');
            dismisses++;
            expanded = false;
        }
    };
    const list = {
        getAttribute: name => attr(name, { 'data-tid': 'camera-settings', role: 'listbox' }),
        closest(selector) { assert.equal(selector, '[role="dialog"]'); return flyout; },
        querySelectorAll(selector) {
            assert.equal(selector, '[role="option"]');
            return ['one', 'two', 'third'].map((id, index) => ({
                id,
                getAttribute: name => attr(name, { 'aria-selected': String(selected === index) }),
                click() {
                    assert.equal(cameraWrites++, 0, 'must not repeat the camera write');
                    selected = index;
                }
            }));
        }
    };
    const document = {
        getElementById(id) {
            if (id === 'video-button-configure') return host;
            if (id === 'video-effects-and-settings-menu') return paneVisible ? tabs : null;
            return styles.get(id) ?? null;
        },
        querySelectorAll(selector) {
            if (selector === '[role="dialog"],[role="menu"]') return [];
            assert.equal(selector, '[data-tid]');
            const other = { getAttribute: name => attr(name, { 'data-tid': 'calling-right-side-panel' }),
                contains: () => false };
            return [...expanded ? [list] : [], ...paneVisible ? [panel] : [], ...scenario === 'other-pane' ? [other] : []];
        },
        createElement(tag) {
            assert.equal(tag, 'style');
            return { textContent: '', remove() { styles.delete(this.id); } };
        },
        head: { appendChild(style) { styles.set(style.id, style); } }
    };
    const result = JSON.parse(await vm.runInNewContext(script, {
        document, window, CSS: { escape: value => value }, Date: { now: () => clock },
        KeyboardEvent: function (_, values) { Object.assign(this, values); },
        setTimeout: schedule, clearTimeout: id => timers.delete(id)
    }, { timeout: 1000 }));
    const failures = new Set([
        'unknown-initial', 'unknown-before-write', 'unknown-after-write', 'disabled-switch',
        'indeterminate', 'contradictory-state', 'missing-switch', 'ignored-write', 'mirror-ignored-write', 'throw-write',
        'missing-tab', 'unknown-tab', 'ignored-tab', 'pane-open-fails', 'late-pane', 'ignored-close',
        'throw-close', 'missing-close', 'user-flyout-missing-tab', 'user-pane-missing-tab',
        'user-pane-restore-fails', 'camera-changed', 'camera-changed-after-mirror', 'other-pane'
    ]);
    assert.equal(result.ok, !failures.has(scenario), JSON.stringify(result));
    assert.equal(cameraWrites, scenario === 'camera-noop' ? 0 : 1);
    assert.equal(result.safeToFallback, false, 'no fallback after a confirmed camera selection');
    assert.equal(result.selectedId, desired === 1 ? 'two' : 'one');
    assert.equal(styles.size, 0, 'always remove hiding styles');
    assert.equal(window.__sdtc_camera_operation, undefined, 'always release the operation lock');
    if (result.ok) {
        assert.equal(selected, desired);
        const unchanged = scenario === 'unchanged';
        const focusOnly = scenario === 'focus-only', brightnessOnly = scenario === 'brightness-only';
        const mirrorOnly = scenario === 'mirror-only';
        if (!unchanged) {
            if (!focusOnly && !brightnessOnly) assert.equal(values['Mirror my video'], desired === 0);
            if (!brightnessOnly && !mirrorOnly) assert.equal(values['Soft focus'], desired === 1);
            if (!focusOnly && !mirrorOnly) assert.equal(values['Adjust brightness'], desired === 0);
        }
        for (const [name, count] of Object.entries(writes)) {
            const skip = unchanged || scenario === 'preferences-noop' ||
                focusOnly && name !== 'Soft focus' || brightnessOnly && name !== 'Adjust brightness' ||
                mirrorOnly && name !== 'Mirror my video' || scenario === 'fresh-already-desired' && name === 'Soft focus';
            assert.equal(count, skip ? 0 : 1, name);
        }
        if (unchanged || focusOnly || brightnessOnly) assert.equal(paneOpens, 0);
    } else {
        assert.match(result.error, /Webcam selected, but /);
        if (writes['Soft focus'] && !cleanupFailures.has(scenario)) assert.match(result.error, /may already have changed/);
        if (scenario === 'ignored-write' || scenario === 'throw-write' || scenario === 'unknown-after-write')
            assert.equal(writes['Soft focus'], 1);
        if (scenario === 'unknown-before-write') assert.equal(writes['Soft focus'], 0);
    }
    if (!cleanupFailures.has(scenario)) {
        assert.equal(paneVisible, originalPane, 'restore original pane ownership');
        if (originalPane) assert.equal(tab, originalTab, 'restore the user-selected tab');
    } else {
        assert.equal(result.cleanupOk, false);
        assert.equal(dismisses, 1, 'still dismiss action-owned flyout when pane cleanup fails');
    }
    assert.equal(expanded, originalFlyout, 'restore original flyout ownership');
    if (originalFlyout) assert.equal(dismisses, 0);
    if (scenario === 'late-pane') assert.equal(paneCloses, 1, 'close a pane arriving after navigation timed out');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
