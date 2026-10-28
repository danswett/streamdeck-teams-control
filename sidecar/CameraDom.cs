using System.Text.Json;

namespace TeamsBridge;

internal static class CameraDom
{
    internal sealed record Result(bool Ok, bool SafeToFallback, string? Error);

    internal static CdpTarget? FindPage(CdpTarget preferred,
        Func<IReadOnlyList<CdpTarget>?> listPages, Func<CdpTarget, CdpResult> probe, int maxPages)
    {
        static bool Eligible(CdpTarget page) => page.Type == "page" &&
            page.Url.StartsWith("https://teams.microsoft.com/", StringComparison.OrdinalIgnoreCase);
        bool Found(CdpTarget page)
        {
            var reply = probe(page);
            if (!reply.Ok || reply.Json is null) return false;
            try
            {
                using var doc = JsonDocument.Parse(reply.Json);
                return doc.RootElement.ValueKind == JsonValueKind.Object &&
                    doc.RootElement.TryGetProperty("found", out var found) && found.ValueKind == JsonValueKind.True;
            }
            catch (JsonException) { return false; }
        }
        if (Eligible(preferred) && Found(preferred)) return preferred;
        foreach (var page in (listPages() ?? []).Where(Eligible).Take(maxPages))
            if (page.WebSocketUrl != preferred.WebSocketUrl && Found(page)) return page;
        return null;
    }

    internal static Result Interpret(CdpResult reply)
    {
        if (!reply.Ok)
            return new(false, false,
                $"Direct camera selection failed: {reply.Error}; webcam selection may already have changed");
        try
        {
            using var doc = JsonDocument.Parse(reply.Json ?? "");
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return Invalid();
            bool Flag(string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
            var hasSelection = root.TryGetProperty("selectedId", out var id);
            var selected = hasSelection && id.ValueKind == JsonValueKind.String &&
                !string.IsNullOrWhiteSpace(id.GetString());
            if (hasSelection && !selected) return Invalid();
            if (Flag("ok") && selected && Flag("cleanupOk")) return new(true, false, null);
            var safe = root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.False &&
                !hasSelection && Flag("safeToFallback") && Flag("cleanupOk") &&
                root.TryGetProperty("writeAttempted", out var write) && write.ValueKind == JsonValueKind.False;
            var error = root.TryGetProperty("error", out var message) && message.ValueKind == JsonValueKind.String
                ? message.GetString() : null;
            return new(false, safe, error ?? "Direct webcam selection was not confirmed");
        }
        catch (JsonException) { return Invalid(); }

        static Result Invalid() => new(false, false, "Invalid Direct camera result; webcam selection may already have changed");
    }

    internal static string? BuildScript(ControlSpec spec, string? arg, bool swap, int timeoutMs,
        CameraVideoSettingsSpec? videoSettings = null)
    {
        var choices = CameraArguments.Parse(arg, swap);
        if (choices is null || string.IsNullOrWhiteSpace(spec.Menu) ||
            string.IsNullOrWhiteSpace(spec.MenuItemContainerDataTid) ||
            !string.IsNullOrEmpty(spec.Submenu) || !string.IsNullOrEmpty(spec.MenuItemName) ||
            !string.IsNullOrEmpty(spec.MenuItemOffName) || !string.IsNullOrEmpty(spec.OffAutomationId) ||
            !string.IsNullOrEmpty(spec.OffName)) return null;
        videoSettings ??= new();
        if (videoSettings.Validate() is not null) return null;
        var devices = choices.Select(camera => camera.Id).ToArray();
        static string Flag(bool? value) => value.HasValue ? (value.Value ? "true" : "false") : "null";
        var preferences = "[" + string.Join(",", choices.Select(camera =>
            $"{{mirror:{Flag(camera.Preferences.Mirror)},softFocus:{Flag(camera.Preferences.SoftFocus)},brightness:{Flag(camera.Preferences.Brightness)}}}")) + "]";
        var hasPreferences = choices.Any(camera => camera.Preferences is not { Mirror: null, SoftFocus: null, Brightness: null });
        var selectors = new List<string[]>();
        foreach (var device in devices)
        {
            if (!TeamsClient.TryItemSelectors(spec, device, out var ids, out _, out _)) return null;
            var usable = ids.Where(id => !string.IsNullOrWhiteSpace(id)).Select(id => id!).Distinct().ToArray();
            if (usable.Length == 0) return null;
            selectors.Add(usable);
        }
        var groups = "[" + string.Join(",", selectors.Select(DomActuator.JsArray)) + "]";

        return $$"""
        (async function () {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const host = () => document.getElementById({{DomActuator.Js(spec.Menu)}});
            const tid = {{DomActuator.Js(spec.MenuItemContainerDataTid)}};
            const devices = {{DomActuator.JsArray(devices)}};
            const groups = {{groups}};
            const preferences = {{preferences}}, hasPreferences = {{(hasPreferences ? "true" : "false")}};
            const video = {
                tabs: {{DomActuator.Js(videoSettings.PaneTabsAutomationId)}},
                paneTid: {{DomActuator.Js(videoSettings.PaneDataTid)}},
                settings: {{DomActuator.Js(videoSettings.SettingsTabName)}},
                mirror: {{DomActuator.Js(videoSettings.MirrorName)}},
                softFocus: {{DomActuator.Js(videoSettings.SoftFocusName)}},
                brightness: {{DomActuator.Js(videoSettings.BrightnessName)}},
                more: {{DomActuator.Js(videoSettings.MoreSettingsName)}},
                close: {{DomActuator.Js(videoSettings.ClosePaneName)}}
            };
            const key = '__sdtc_camera_operation', styleId = '__sdtc_camera_suppress';
            if (window[key]) return JSON.stringify({ ok: false, error: 'Camera operation still pending' });
            const token = {};
            window[key] = token;
            const out = { ok: false, writeAttempted: false, cleanupOk: false };
            const deadline = Date.now() + {{Math.Max(50, timeoutMs - (hasPreferences ? 1000 : 800))}};
            let owned = false, navigated = false, initialKnown = false, style = null, watchdog = null;
            let originalTab = null, paneAttempted = false, paneSeen = false;
            const containers = () => [...document.querySelectorAll('[data-tid]')]
                .filter(el => el.getAttribute('data-tid') === tid && el.getAttribute('role') === 'listbox');
            const disabled = el => el.disabled || el.getAttribute('aria-disabled') === 'true';
            const panels = () => [...document.querySelectorAll('[data-tid]')]
                .filter(el => el.getAttribute('data-tid') === video.paneTid);
            const pane = () => {
                const tabs = document.getElementById(video.tabs);
                const matches = tabs ? panels().filter(el => el.contains(tabs)) : [];
                return matches.length === 1 ? matches[0] : null;
            };
            const nameOf = el => el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent.trim();
            const named = (scope, selector, name) => {
                const matches = scope ? [...scope.querySelectorAll(selector)].filter(el => nameOf(el) === name) : [];
                return matches.length === 1 ? matches[0] : null;
            };
            const dialog = () => {
                const lists = containers();
                return lists.length === 1 ? lists[0].closest('[role="dialog"]') : null;
            };
            const waitFor = async (read, error, until = deadline) => {
                do {
                    const value = read();
                    if (value) return value;
                    await sleep(20);
                } while (Date.now() < until);
                throw new Error(error);
            };
            const suppress = css => {
                if (!style) {
                    document.getElementById(styleId)?.remove();
                    style = document.createElement('style');
                    style.id = styleId;
                    document.head.appendChild(style);
                    watchdog = setTimeout(() => style.remove(), {{Math.Max(100, timeoutMs - 50)}});
                }
                style.textContent += css;
            };
            const optionsCss = '[role="dialog"]:has([data-tid=' + CSS.escape(tid) + ']){opacity:0!important}';
            const paneCss = '[data-tid=' + CSS.escape(video.paneTid) + ']{opacity:0!important}';
            const ensureOptions = async (until = deadline) => {
                const trigger = host();
                if (!trigger || disabled(trigger)) throw new Error('Video options are unavailable');
                const expanded = trigger.getAttribute('aria-expanded');
                if (expanded !== 'true' && expanded !== 'false') throw new Error('Unknown video options state');
                if (expanded === 'false') {
                    if (document.querySelectorAll('[role="dialog"],[role="menu"]').length)
                        throw new Error('Another Teams flyout is open');
                    if (Date.now() >= until) throw new Error('Camera operation deadline elapsed');
                    navigated = true;
                    trigger.click();
                }
                await waitFor(dialog, 'Teams did not expose the camera flyout', until);
            };
            const tabSnapshot = () => {
                const tabs = document.getElementById(video.tabs);
                if (!pane() || !tabs) return null;
                const items = [...tabs.querySelectorAll('[role="tab"]')];
                if (!items.length || items.some(el => !['true', 'false'].includes(el.getAttribute('aria-selected'))))
                    return null;
                const selected = items.filter(el => el.getAttribute('aria-selected') === 'true');
                return selected.length === 1 && nameOf(selected[0]) ? { name: nameOf(selected[0]), items } : null;
            };
            const selectTab = async (name, until = deadline) => {
                await waitFor(tabSnapshot, 'Unknown video settings tab', until);
                const fresh = tabSnapshot();
                const tab = fresh?.items.filter(el => nameOf(el) === name);
                if (!fresh || tab.length !== 1 || disabled(tab[0])) throw new Error('Video settings tab is unavailable');
                if (fresh.name !== name) {
                    if (Date.now() >= until) throw new Error('Camera operation deadline elapsed');
                    tab[0].click();
                }
                await waitFor(() => tabSnapshot()?.name === name, 'Teams did not confirm the video settings tab', until);
            };
            const openPane = async (until = deadline) => {
                if (pane()) { paneSeen = true; return; }
                if (panels().length) throw new Error('Another Teams pane is open');
                if (originalTab === null) suppress(paneCss);
                await ensureOptions(until);
                const more = named(dialog(), 'button', video.more);
                if (!more || disabled(more) || Date.now() >= until) throw new Error('Video settings are unavailable');
                paneAttempted = true;
                more.click();
                await waitFor(pane, 'Teams did not open the video settings pane', until);
                paneSeen = true;
            };
            const toggleSnapshot = (scope, name) => {
                const el = named(scope(), 'input[type="checkbox"][role="switch"]', name);
                if (!el || el.isConnected === false || disabled(el) || el.indeterminate ||
                    typeof el.checked !== 'boolean') return null;
                const aria = el.getAttribute('aria-checked');
                if (aria !== null && (aria !== 'true' && aria !== 'false' || (aria === 'true') !== el.checked))
                    return null;
                return { el, checked: el.checked };
            };
            const setToggle = async (scope, name, wanted) => {
                await waitFor(() => toggleSnapshot(scope, name), 'Unknown state for ' + name);
                const fresh = toggleSnapshot(scope, name);
                if (!fresh) throw new Error('Video preference state changed before writing ' + name);
                if (fresh.checked !== wanted) {
                    if (Date.now() >= deadline) throw new Error('Camera operation deadline elapsed');
                    out.writeAttempted = true;
                    fresh.el.click();
                    await sleep(20);
                }
                await waitFor(() => toggleSnapshot(scope, name)?.checked === wanted, 'Teams did not confirm ' + name);
            };
            const read = () => {
                const trigger = host();
                if (!trigger || trigger.getAttribute('aria-expanded') !== 'true') return null;
                if (disabled(trigger)) throw new Error('Video options became disabled');
                const lists = containers();
                if (lists.length !== 1) return null;
                const options = [...lists[0].querySelectorAll('[role="option"]')];
                if (!options.length || disabled(lists[0])) return null;
                const states = options.map(el => ({ el, selected: el.getAttribute('aria-selected') }));
                if (states.some(item => item.selected !== 'true' && item.selected !== 'false') ||
                    states.filter(item => item.selected === 'true').length !== 1) return null;
                const targets = groups.map(ids => states.filter(item => ids.includes(item.el.id)));
                if (targets.some(items => items.length !== 1)) return null;
                if (targets.length === 2 && targets[0][0].el === targets[1][0].el) return null;
                if (targets.some(items => disabled(items[0].el))) throw new Error('Configured webcam is disabled');
                return targets.map(items => ({ el: items[0].el, selected: items[0].selected === 'true' }));
            };
            const known = async () => {
                do {
                    const state = read();
                    if (state) return state;
                    await sleep(20);
                } while (Date.now() < deadline);
                throw new Error('Teams did not expose a known selection and all configured webcams');
            };
            try {
                const trigger = host();
                if (!trigger || disabled(trigger)) throw new Error('Video options are unavailable');
                const expanded = trigger.getAttribute('aria-expanded');
                if (expanded !== 'true' && expanded !== 'false') throw new Error('Unknown video options state');
                owned = expanded === 'false';
                if (hasPreferences && document.getElementById(video.tabs)) {
                    const original = tabSnapshot();
                    if (!original) throw new Error('Unknown original video settings tab');
                    originalTab = original.name;
                }
                if (owned) {
                    if (document.querySelectorAll('[role="dialog"],[role="menu"]').length)
                        throw new Error('Another Teams flyout is open');
                    suppress(optionsCss);
                    navigated = true;
                    trigger.click();
                }
                const initial = await known();
                initialKnown = true;
                const desired = devices.length === 2 && initial[0].selected ? 1 : 0;
                let fresh = null;
                do {
                    fresh = read();
                    if (fresh) break;
                    await sleep(20);
                } while (Date.now() < deadline);
                if (!fresh) throw new Error('Teams did not expose a fresh webcam selection');
                if (Date.now() >= deadline) throw new Error('Camera operation deadline elapsed');
                // No await between this fresh read and the write: React can
                // replace the option during a promise continuation.
                if (!fresh[desired].selected) {
                    out.writeAttempted = true;
                    fresh[desired].el.click();
                    await sleep(20);
                }
                let reopened = false;
                do {
                    const observed = read();
                    if (observed && observed[desired].selected) {
                        out.selectedId = devices[desired];
                        out.ok = true;
                        break;
                    }
                    // A closing picker may arrive after the write returns.
                    // Reopen once for observation, never repeat the device write.
                    if (out.writeAttempted && !reopened &&
                        host()?.getAttribute('aria-expanded') === 'false' && Date.now() < deadline) {
                        const trigger = host();
                        if (!trigger || disabled(trigger)) throw new Error('Video options became unavailable');
                        reopened = true;
                        trigger.click();
                    }
                    await sleep(20);
                } while (Date.now() < deadline);
                if (!out.ok) throw new Error('Teams did not confirm webcam selection; selection may already have changed');
                const preference = preferences[desired];
                if (Object.values(preference).some(value => value !== null)) {
                    const selectedOptions = () => {
                        const state = read();
                        return state?.[desired].selected ? dialog() : null;
                    };
                    await ensureOptions();
                    for (const [name, wanted] of [[video.softFocus, preference.softFocus], [video.brightness, preference.brightness]]) {
                        if (wanted !== null) await setToggle(selectedOptions, name, wanted);
                    }
                    if (preference.mirror !== null) {
                        if (!read()?.[desired].selected) throw new Error('Webcam selection changed before applying mirror');
                        await openPane();
                        await selectTab(video.settings);
                        await setToggle(pane, video.mirror, preference.mirror);
                    }
                    await ensureOptions();
                    const final = await known();
                    if (!final[desired].selected) throw new Error('Webcam selection changed while applying video preferences');
                }
            } catch (error) {
                out.ok = false;
                out.error = String(error && error.message || error);
                if (out.selectedId !== undefined)
                    out.error = 'Webcam selected, but video preferences failed: ' + out.error + '; some video preferences may already have changed';
                else if (out.writeAttempted) out.error += '; webcam selection may already have changed';
            } finally {
                try {
                    const cleanupErrors = [];
                    const cleanupDeadline = Date.now() + 600;
                    const cleanup = async action => {
                        try { await action(); }
                        catch (error) { cleanupErrors.push(String(error && error.message || error)); }
                    };
                    await cleanup(async () => {
                        if (!hasPreferences) return;
                        const until = cleanupDeadline;
                        if (originalTab !== null) {
                            await openPane(until);
                            await selectTab(originalTab, until);
                        } else if (paneAttempted) {
                            do {
                                const current = pane();
                                if (current) {
                                    paneSeen = true;
                                    const close = named(current, 'button', video.close);
                                    if (!close || disabled(close)) throw new Error('Video settings close button is unavailable');
                                    close.click();
                                    await waitFor(() => !document.getElementById(video.tabs),
                                        'Could not close the video settings pane', until);
                                    break;
                                }
                                if (paneSeen) break;
                                await sleep(20);
                            } while (Date.now() < until);
                        }
                    });
                    await cleanup(async () => {
                        if (hasPreferences && !owned && (navigated || paneAttempted))
                            await ensureOptions(cleanupDeadline);
                        if (!owned || !navigated) return;
                        if (host()?.getAttribute('aria-expanded') === 'true') {
                            host().dispatchEvent(new KeyboardEvent('keydown', {
                                key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
                            }));
                        }
                        const until = cleanupDeadline;
                        while ((host()?.getAttribute('aria-expanded') !== 'false' || containers().length) &&
                            Date.now() < until) await sleep(20);
                        if (host()?.getAttribute('aria-expanded') !== 'false' || containers().length)
                            throw new Error('Could not confirm camera flyout cleanup');
                    });
                    out.cleanupOk = cleanupErrors.length === 0;
                    if (originalTab !== null && tabSnapshot()?.name !== originalTab) out.cleanupOk = false;
                    if (originalTab === null && paneAttempted && document.getElementById(video.tabs)) out.cleanupOk = false;
                    if (!out.cleanupOk) throw new Error(cleanupErrors.join('; ') || 'Could not restore video settings navigation');
                } catch (error) {
                    out.ok = false;
                    out.error = [out.error, String(error && error.message || error)].filter(Boolean).join('; ');
                    if (out.selectedId !== undefined && !out.error.startsWith('Webcam selected, but '))
                        out.error = 'Webcam selected, but ' + out.error;
                } finally {
                    if (watchdog !== null) clearTimeout(watchdog);
                    try { style?.remove(); }
                    finally { if (window[key] === token) delete window[key]; }
                }
                out.safeToFallback = !initialKnown && !out.writeAttempted && !out.ok && out.cleanupOk;
            }
            return JSON.stringify(out);
        })()
        """;
    }
}
