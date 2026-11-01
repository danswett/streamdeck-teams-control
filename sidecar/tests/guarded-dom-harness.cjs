const assert = require('node:assert/strict');
const readline = require('node:readline');
const vm = require('node:vm');

async function main() {
    const [kind, scenario] = process.argv.slice(2);
    const localized = scenario === 'localized';
    const originalOpen = scenario.startsWith('user-popup');
    let writes = 0, clock = 0, nextTimer = 0, popup = null, foreign = null;
    let blurOn = scenario === 'blur-off', running = scenario !== 'paused';
    const timers = new Map(), observers = new Set(), all = [], window = {};
    let queued = false;
    const rootFiber = { return: null }, toolbarFiber = { return: rootFiber };
    const cameraOwner = { return: toolbarFiber }, timerOwner = { return: rootFiber };
    let body, head, context;
    const styles = () => head.children.filter(el => el.tag === 'style');
    const notify = () => {
        if (queued) return;
        queued = true;
        queueMicrotask(() => {
            queued = false;
            for (const observer of observers) observer.callback();
            if (popup?.isConnected && !originalOpen && styles().length) {
                assert.ok(popup.hasAttribute('data-sdtc-guarded-owned'), 'owned blur popup must be hidden before paint');
            }
            if (foreign?.isConnected) assert.ok(!foreign.hasAttribute('data-sdtc-guarded-owned'), 'never hide a foreign popup');
        });
    };
    class Element {
        constructor(tag, attrs = {}, fiber = rootFiber) {
            this.tag = tag; this.attrs = { ...attrs }; this.children = []; this.parentElement = null;
            this.disabled = false; this.textContent = ''; this.root = false;
            this.__reactFiber$guard = { return: fiber };
            all.push(this);
        }
        get id() { return this.attrs.id || ''; }
        set id(value) { this.attrs.id = value; }
        get isConnected() { return this.root || !!this.parentElement?.isConnected; }
        getAttribute(name) { return this.attrs[name] ?? null; }
        hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
        setAttribute(name, value) { this.attrs[name] = String(value); notify(); }
        removeAttribute(name) { delete this.attrs[name]; notify(); }
        getClientRects() { return this.isConnected && !this.hidden ? [{}] : []; }
        appendChild(el) {
            if (el.parentElement) el.remove();
            this.children.push(el); el.parentElement = this; notify(); return el;
        }
        remove() {
            if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(el => el !== this);
            this.parentElement = null; notify();
        }
        contains(el) { return this === el || this.children.some(child => child.contains(el)); }
        matches(selector) {
            if (selector === '.fui-PopoverSurface') return (this.attrs.class || '').split(' ').includes('fui-PopoverSurface');
            if (selector === 'input[type="radio"]') return this.tag === 'input' && this.attrs.type === 'radio';
            const attr = /^\[([^\]=]+)(?:="([^"]*)")?\]$/.exec(selector);
            if (attr) return attr[2] === undefined ? this.hasAttribute(attr[1]) : this.getAttribute(attr[1]) === attr[2];
            return this.tag === selector;
        }
        querySelectorAll(selector) {
            const selectors = selector.split(',').map(value => value.trim());
            const result = [];
            const walk = el => {
                for (const child of el.children) {
                    if (selectors.some(selector => child.matches(selector))) result.push(child);
                    walk(child);
                }
            };
            walk(this); return result;
        }
        closest(selector) {
            for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el;
            return null;
        }
        click() { if (this.onClick) this.onClick(); }
    }
    body = new Element('body'); body.root = true;
    head = new Element('head'); head.root = true;
    const document = {
        body, head, documentElement: body,
        createElement: tag => new Element(tag),
        getElementById: id => all.find(el => el.isConnected && el.id === id) || null,
        querySelectorAll: selector => [...head.querySelectorAll(selector), ...body.querySelectorAll(selector)]
    };
    const button = (parent, name, id = '', owner = rootFiber) =>
        parent.appendChild(new Element('button', { 'aria-label': name, id }, owner));
    for (const id of ['microphone-button', 'video-button', 'share-button', 'chat-button', 'roster-button', 'hangup-button'])
        button(body, id, id, id === 'video-button' ? cameraOwner : toolbarFiber);
    const trigger = button(body, 'Video options', 'video-button-configure', cameraOwner);
    trigger.setAttribute('aria-expanded', 'false');
    if (scenario === 'missing-owner' && kind === 'Blur') delete trigger.__reactFiber$guard;
    const addForeign = () => {
        foreign = body.appendChild(new Element('div', { role: 'dialog' }));
        button(foreign, 'Standard blur');
        return foreign;
    };
    const write = callback => {
        assert.equal(writes++, 0, 'a command must never repeat an uncertain write');
        if (scenario !== 'ignored-write' && scenario !== 'native-ignored') callback();
        if (scenario === 'throw-after-write') throw Error('uncertain click after applying the change');
    };
    const openBlur = () => {
        popup = body.appendChild(new Element('div', { role: 'dialog' }, cameraOwner));
        popup.appendChild(new Element('div', { 'data-tid': 'camera-settings', role: 'listbox' }, cameraOwner));
        const names = localized ? ['Weichzeichnung', 'Kein Effekt'] : ['Standard blur', 'No background effect'];
        const choices = names.map((name, index) => {
            let radio;
            if (scenario.startsWith('native-')) {
                radio = popup.appendChild(new Element('input', { type: 'radio' }, cameraOwner));
                const label = popup.appendChild(new Element('label', {}, cameraOwner));
                label.textContent = name;
                radio.labels = [label];
                radio.checked = index === 0 ? blurOn : !blurOn;
                radio.__reactProps$guard = { checked: radio.checked };
            } else {
                radio = scenario === 'role-radio'
                    ? popup.appendChild(new Element('div', { 'aria-label': name }, cameraOwner))
                    : button(popup, name, '', cameraOwner);
                radio.setAttribute('role', scenario === 'role-radio' ? 'menuitemradio' : 'radio');
                radio.setAttribute('aria-checked', scenario === 'unknown-state' ? 'mixed' : String(index === 0 ? blurOn : !blurOn));
            }
            radio.onClick = () => {
                if (radio.tag === 'input') radio.checked = true;
                write(() => {
                    blurOn = index === 0;
                    for (const [at, item] of choices.entries()) {
                        if (item.tag === 'input') {
                            item.checked = at === index;
                            item.__reactProps$guard = { checked: item.checked };
                        } else item.setAttribute('aria-checked', String(at === index));
                    }
                    if (scenario.endsWith('auto-close')) { popup.remove(); trigger.setAttribute('aria-expanded', 'false'); }
                    if (scenario === 'foreign-after-write') addForeign();
                });
            };
            return radio;
        });
        if (scenario === 'ambiguous') button(popup, names[0], '', cameraOwner);
        trigger.setAttribute('aria-expanded', 'true');
    };
    trigger.onClick = () => {
        if (popup?.isConnected) {
            if (scenario === 'cleanup-fails') return;
            popup.remove(); trigger.setAttribute('aria-expanded', 'false');
        } else {
            if (!originalOpen) {
                assert.equal(styles().length, 1, 'suppression must precede owned navigation');
                assert.equal(styles()[0].textContent, '[data-sdtc-guarded-owned]{opacity:0!important}');
            } else assert.equal(styles().length, 0, 'never hide an already open popup');
            openBlur();
            if (scenario === 'foreign-batched-open') addForeign();
        }
    };
    let grid = null;
    const retainedRoot = scenario.startsWith('retained-root');
    if (retainedRoot) body.appendChild(new Element('div', { id: 'ppt-previewer-root' }));
    const gridButton = button(body, 'Grid view', 'gridViewToolbarButton');
    const openGrid = () => {
        if (retainedRoot) gridButton.hidden = true;
        else gridButton.remove();
        grid = body.appendChild(new Element('aside', { id: 'fluent-grid-view', role: 'dialog',
            ...(retainedRoot ? { 'aria-hidden': 'true' } : {}) }));
        button(grid, 'Close grid view').onClick = () => write(() => {
            grid.remove(); gridButton.hidden = false; body.appendChild(gridButton);
        });
    };
    gridButton.onClick = () => write(openGrid);
    if (kind === 'Grid' && ['grid-close', 'grid-close-foreign', 'selector-fallback','retained-root-close'].includes(scenario)) openGrid();
    const timer = body.appendChild(new Element('div', {}, timerOwner));
    const controlName = seconds => (localized ? 'Zeitsteuerung' : 'Timer controls') +
        ', ' + Math.floor(seconds / 60) + ' min, ' + seconds % 60 + ' sec remaining';
    const expired = scenario === 'expired' || scenario === 'cancel-mapped';
    // full-duration: a reset from the full five minutes reads the same afterwards.
    const controls = button(timer, controlName(expired ? 0 : scenario === 'full-duration' ? 300 : 120), '', timerOwner);
    if (scenario === 'missing-owner' && kind.startsWith('Timer')) delete controls.__reactFiber$guard;
    const toggle = button(timer, '', '', timerOwner);
    const setToggle = () => toggle.setAttribute('aria-label', expired && !running
        ? 'Cancel timer for everyone' : running ? localized ? 'Anhalten' : 'Pause timer'
            : localized ? 'Fortsetzen' : 'Resume timer');
    if (expired) running = false;
    setToggle();
    toggle.onClick = () => {
        assert.notEqual(toggle.getAttribute('aria-label'), 'Cancel timer for everyone', 'never cancel a timer to toggle it');
        write(() => { running = !running; setToggle(); });
    };
    if (scenario === 'split-fiber') toggle.__reactFiber$guard = { return: rootFiber };
    if (scenario === 'wrong-scope') {
        body.appendChild(toggle);
        toggle.__reactFiber$guard = { return: rootFiber };
    }
    button(timer, 'Reset timer', '', timerOwner).onClick = () => write(() => {
        controls.setAttribute('aria-label', controlName(300));
        running = true; setToggle();
    });
    if (scenario === 'ambiguous' && kind.startsWith('Timer')) button(timer, controls.getAttribute('aria-label'), '', timerOwner);
    if (originalOpen && kind.startsWith('Timer')) {
        timer.setAttribute('role', 'dialog');
    }
    let presenter = null, confirmation = null;
    if (kind === 'ConfirmPresentation') {
        presenter = button(body, 'Stop presenting', 'stopPresentingPptBtn');
        const addConfirmation = () => {
            const dialog = body.appendChild(new Element('div', { role: 'dialog', class: 'ui-dialog' }));
            button(dialog, 'Cancel').onClick = () => assert.fail('never cancel or accept another control');
            button(dialog, 'Stop presenting').onClick = () => write(() => { dialog.remove(); presenter.remove(); });
            return dialog;
        };
        if (scenario !== 'missing-dialog') confirmation = addConfirmation();
        if (scenario === 'ambiguous') addConfirmation();
    }
    if (kind === 'Blur' && originalOpen) openBlur();
    if (scenario === 'foreign-popup' || scenario === 'grid-close-foreign') addForeign();
    const schedule = (callback, ms) => {
        const id = ++nextTimer;
        timers.set(id, { callback, due: clock + ms });
        if (ms <= 20) queueMicrotask(() => {
            clock += ms;
            for (const [key, timer] of timers) {
                if (timer.due <= clock) { timers.delete(key); timer.callback(); }
            }
        });
        return id;
    };
    context = vm.createContext({
        window, document, Date: { now: () => clock }, setTimeout: schedule, clearTimeout: id => timers.delete(id),
        MutationObserver: class {
            constructor(callback) { this.callback = callback; }
            observe() { observers.add(this); }
            disconnect() { observers.delete(this); }
        },
        getComputedStyle: el => ({ display: el.hidden ? 'none' : 'block', visibility: 'visible' }),
        console: { error: message => process.stderr.write(message + '\n') }
    });
    let requests = 0;
    for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
        try {
            const script = JSON.parse(line);
            const value = await vm.runInContext(script, context, { timeout: 5000 });
            process.stdout.write(JSON.stringify({ value }) + '\n');
            if (++requests === 1 && scenario === 'expired-before-write') clock = 10_000;
        } catch (error) {
            process.stdout.write(JSON.stringify({ error: error.stack }) + '\n');
        }
    }
    await Promise.resolve();
    assert.ok(!window.__sdtc_guarded_operation, 'operation token must be cleaned');
    assert.equal(styles().length, 0, 'no hidden styles may survive');
    assert.equal(observers.size, 0, 'no observer may survive');
    assert.equal(timers.size, 0, 'no watchdog may survive');
    assert.ok(all.every(el => !el.hasAttribute('data-sdtc-guarded-owned')), 'no owned markers may survive');
    const prewriteFailures = new Set(['foreign-popup', 'foreign-batched-open', 'grid-close-foreign',
        'unknown-state', 'ambiguous', 'missing-owner', 'missing-dialog', 'cancel-mapped', 'expired-before-write']);
    const noWrite = (prewriteFailures.has(scenario) && !(kind.startsWith('Timer') && scenario === 'missing-owner')) ||
        scenario === 'wrong-scope' || kind === 'TimerToggle' && scenario === 'expired';
    assert.equal(writes, noWrite ? 0 : 1, 'observe exactly the intended write count, including uncertain results');
    if (kind === 'Blur' && scenario !== 'cleanup-fails')
        assert.equal(!!popup?.isConnected, originalOpen, 'restore only the original popup state');
    if (foreign) assert.ok(foreign.isConnected, 'preserve unrelated UI');
    if (kind === 'TimerToggle' && originalOpen) assert.ok(timer.isConnected && timer.getAttribute('role') === 'dialog');
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
