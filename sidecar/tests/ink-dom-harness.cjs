const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function main() {
    const { script, scenario } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const originalOpen = scenario.startsWith('user-popup');
    let open = originalOpen, color = scenario === 'color-wrap' ? 0 : 1, thickness = 2;
    let titleColor = color, foreignOpen = scenario === 'foreign-popup';
    let currentTool = scenario === 'laser' ? 'ink-tool-3' : scenario === 'unsupported-tool' ? 'ink-tool-4' : 'ink-tool-0';
    let colorWrites = 0, rangeWrites = 0, inputEvents = 0, opens = 0, closes = 0, clock = 0, timerId = 0;
    let domValue = '2';
    const styles = new Map(), timers = new Map(), window = {}, markers = new Set(), observers = new Set();
    const names = ['Black', 'Blue', 'Red'];
    const originalColor = color;
    const errors = new Set(['unknown-color', 'ignored-color', 'ignored-input', 'throw-after-write',
        'foreign-popup', 'foreign-after-open', 'foreign-batched-open', 'foreign-batched-range',
        'cleanup-fails', 'lock', 'unsupported-tool']);
    const token = {};
    if (scenario === 'lock') window.__sdtc_ink_operation = token;
    const css = () => [...styles.values()].map(style => style.textContent).join('');
    const checkHidden = () => {
        if (originalOpen) assert.equal(styles.size, 0, 'never hide a user-owned popup');
        else {
            assert.match(css(), /data-sdtc-ink-owned/, 'install scoped suppression before opening an owned popup');
            if (open) assert.ok(markers.has(popup), 'hide only the identified owned popup');
        }
    };
    let deliveryQueued = false;
    const notify = () => {
        if (deliveryQueued) return;
        deliveryQueued = true;
        queueMicrotask(() => {
            deliveryQueued = false;
            for (const observer of observers) observer.callback();
            if (open && !originalOpen && styles.size) {
                assert.ok(markers.has(popup), 'the owned popup must be hidden before paint after batched mutations');
            }
            if (foreignOpen) assertForeignVisible();
        });
    };
    const assertForeignVisible = () => {
        assert.doesNotMatch(css(), /\[role="dialog"\].*opacity/, 'never hide all dialogs');
        assert.ok(!markers.has(foreign), 'never mark an unrelated user popup for suppression');
    };
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
    const attr = (attribute, values) => values[attribute] ?? null;
    const hosts = new Map(['ink-tool-0', 'ink-tool-1', 'ink-tool-2', 'ink-tool-3', 'ink-tool-4'].map(id => [id, {
        isConnected: true, disabled: false,
        getAttribute(attribute) {
            return attr(attribute, {
                'aria-selected': String(currentTool === id),
                'aria-expanded': String(open),
                title: `${id === 'ink-tool-3' ? 'Laser pointer' : 'Pen'}: ${names[titleColor]}${id === 'ink-tool-3' ? '' : ', Thickness ' + thickness}`,
            });
        },
        click() {
            assert.equal(currentTool, id, 'never change the selected drawing tool to drive its options');
            if (open) {
                closes++;
                if (scenario === 'cleanup-fails') return;
                open = false;
            } else {
                checkHidden();
                opens++;
                open = true;
                notify();
                if (scenario === 'foreign-after-open') {
                    queueMicrotask(() => {
                        foreignOpen = true;
                        notify();
                        assertForeignVisible();
                    });
                }
                if (scenario === 'foreign-batched-open' || scenario === 'foreign-batched-range') {
                    foreignOpen = true;
                    notify();
                    assertForeignVisible();
                }
            }
        },
    }]));
    const radios = names.map((value, index) => ({
        isConnected: true, disabled: false,
        getAttribute(attribute) {
            return attr(attribute, { 'aria-label': value,
                'aria-checked': scenario === 'unknown-color' ? 'mixed' : String(color === index) });
        },
        click() {
            checkHidden();
            assert.equal(colorWrites++, 0, 'never repeat a color write');
            if (scenario !== 'ignored-color') {
                color = index;
                if (scenario === 'foreign-during-confirmation' || scenario === 'user-popup-foreign') {
                    foreignOpen = true;
                    notify();
                    assertForeignVisible();
                    schedule(() => { titleColor = index; }, 40);
                } else titleColor = index;
            }
            if (scenario === 'auto-close' || scenario === 'user-popup-auto-close') open = false;
            if (scenario === 'throw-after-write') throw Error('uncertain color click');
        },
    }));
    const arrows = ['No arrow', 'Single arrow'].map(value => ({
        getAttribute(attribute) { return attr(attribute, { 'aria-label': value, 'aria-checked': 'true' }); },
        click() { assert.fail('an arrow option must never be treated as an ink color'); },
    }));
    const groups = [radios, arrows].map(items => ({
        querySelectorAll(selector) { assert.equal(selector, '[role="radio"]'); return items; },
    }));
    function HTMLInputElement() {}
    Object.defineProperty(HTMLInputElement.prototype, 'value', {
        get() { return domValue; },
        set(value) {
            checkHidden();
            assert.equal(rangeWrites++, 0, 'never repeat a slider value write');
            domValue = value;
        },
    });
    const slider = new HTMLInputElement();
    Object.assign(slider, {
        isConnected: true, disabled: false, min: '1', max: '6',
        getAttribute() { return null; },
        dispatchEvent(event) {
            assert.equal(event.type, 'input');
            assert.equal(inputEvents++, 0, 'dispatch one application update');
            if (scenario !== 'ignored-input') thickness = Number(domValue);
        },
    });
    const popup = {
        get isConnected() { return open; },
        setAttribute(attribute) { assert.equal(attribute, 'data-sdtc-ink-owned'); markers.add(popup); },
        removeAttribute(attribute) { assert.equal(attribute, 'data-sdtc-ink-owned'); markers.delete(popup); },
        contains(element) { return element === popup || groups.includes(element) || radios.includes(element) || element === slider; },
        querySelector() { return groups[0]; },
        querySelectorAll(selector) {
            if (selector === '[role="radiogroup"]') return groups;
            assert.equal(selector, 'input[type="range"]');
            return [slider];
        },
    };
    const foreign = {
        querySelector: () => scenario === 'foreign-batched-range' ? slider : null,
        querySelectorAll: () => [],
        contains: element => element === foreign,
    };
    const document = {
        documentElement: {},
        getElementById(id) { return hosts.get(id) ?? styles.get(id) ?? null; },
        querySelectorAll(selector) {
            if (selector === '[data-sdtc-ink-owned]') return [...markers];
            assert.equal(selector, '[role="dialog"],[role="menu"],.fui-PopoverSurface');
            return [...open ? [popup] : [], ...foreignOpen ? [foreign] : []];
        },
        createElement(tag) {
            assert.equal(tag, 'style');
            return { textContent: '', remove() { styles.delete(this.id); } };
        },
        head: { appendChild(style) { styles.set(style.id, style); } },
    };
    const result = JSON.parse(await vm.runInNewContext(script, {
        document, window, HTMLInputElement,
        Event: class { constructor(type) { this.type = type; } },
        Date: { now: () => clock },
        setTimeout: schedule,
        clearTimeout: id => timers.delete(id),
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() { observers.add(this); }
            disconnect() { observers.delete(this); }
        },
    }, { timeout: 1000 }));
    assert.equal(result.ok, !errors.has(scenario), `${scenario}: ${JSON.stringify(result)}`);
    assert.equal(styles.size, 0, 'temporary hiding styles must always come down');
    assert.equal(markers.size, 0, 'remove the popup ownership marker');
    assert.equal(observers.size, 0, 'disconnect the popup-suppression observer');
    if (foreignOpen) assertForeignVisible();
    if (scenario === 'lock') assert.equal(window.__sdtc_ink_operation, token, 'do not clear another operation');
    else assert.equal(window.__sdtc_ink_operation, undefined, 'release the operation guard');
    if (scenario === 'foreign-popup' || scenario === 'foreign-after-open' || scenario === 'foreign-batched-open' ||
        scenario === 'foreign-batched-range' ||
        scenario === 'unknown-color' || scenario === 'unsupported-tool' || scenario === 'lock') {
        assert.equal(colorWrites + rangeWrites, 0, 'unknown/foreign state must not be written');
    } else if (scenario.startsWith('thickness') || scenario === 'ignored-input') {
        const expected = scenario === 'thickness-relative' ? 3 : scenario === 'thickness-clamp' ? 6 :
            scenario === 'thickness-round' ? 4 : scenario === 'thickness-noop' || scenario === 'ignored-input' ? 2 : 5;
        assert.equal(thickness, expected);
        assert.equal(rangeWrites, scenario === 'thickness-noop' ? 0 : 1);
        assert.equal(inputEvents, rangeWrites);
        assert.equal(colorWrites, 0);
    } else {
        assert.equal(colorWrites, scenario === 'color-noop' ? 0 : 1);
        assert.equal(rangeWrites, 0);
        assert.equal(color, scenario === 'ignored-color' || scenario === 'color-noop' ? originalColor : 2);
    }
    if (scenario === 'cleanup-fails') {
        assert.equal(result.cleanupOk, false);
        assert.equal(open, true);
    } else {
        assert.equal(open, originalOpen, 'restore only the popup state the operation owned');
        if (originalOpen) {
            assert.equal(closes, 0);
            assert.equal(opens, scenario === 'user-popup-auto-close' ? 1 : 0);
        }
    }
    if (errors.has(scenario)) assert.ok(result.error);
}

main().catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
