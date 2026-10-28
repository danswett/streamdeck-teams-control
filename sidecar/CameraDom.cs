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

    internal static string? BuildScript(ControlSpec spec, string? arg, bool swap, int timeoutMs)
    {
        // Preference envelopes belong to the preference-aware UIA path.
        // Never treat that JSON as a device ID or select a camera without its settings.
        if (string.IsNullOrWhiteSpace(arg) || arg.TrimStart().StartsWith('{')) return null;
        var devices = swap ? Cameras.ParseSwap(arg) : [arg];
        if (devices is null || string.IsNullOrWhiteSpace(spec.Menu) ||
            string.IsNullOrWhiteSpace(spec.MenuItemContainerDataTid) ||
            !string.IsNullOrEmpty(spec.Submenu) || !string.IsNullOrEmpty(spec.MenuItemName) ||
            !string.IsNullOrEmpty(spec.MenuItemOffName) || !string.IsNullOrEmpty(spec.OffAutomationId) ||
            !string.IsNullOrEmpty(spec.OffName)) return null;
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
            const key = '__sdtc_camera_operation', styleId = '__sdtc_camera_suppress';
            if (window[key]) return JSON.stringify({ ok: false, error: 'Camera operation still pending' });
            const token = {};
            window[key] = token;
            const out = { ok: false, writeAttempted: false, cleanupOk: false };
            const deadline = Date.now() + {{Math.Max(50, timeoutMs - 800)}};
            let owned = false, navigated = false, initialKnown = false, style = null, watchdog = null;
            const containers = () => [...document.querySelectorAll('[data-tid]')]
                .filter(el => el.getAttribute('data-tid') === tid && el.getAttribute('role') === 'listbox');
            const disabled = el => el.disabled || el.getAttribute('aria-disabled') === 'true';
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
                if (owned) {
                    if (document.querySelectorAll('[role="dialog"],[role="menu"]').length)
                        throw new Error('Another Teams flyout is open');
                    document.getElementById(styleId)?.remove();
                    style = document.createElement('style');
                    style.id = styleId;
                    style.textContent = '[role="dialog"]:has([data-tid=' + CSS.escape(tid) + ']){opacity:0!important}';
                    document.head.appendChild(style);
                    watchdog = setTimeout(() => style.remove(), {{Math.Max(100, timeoutMs - 50)}});
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
            } catch (error) {
                out.error = String(error && error.message || error);
                if (out.writeAttempted) out.error += '; webcam selection may already have changed';
            } finally {
                try {
                    if (owned && navigated) {
                        if (host()?.getAttribute('aria-expanded') === 'true') {
                            host().dispatchEvent(new KeyboardEvent('keydown', {
                                key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
                            }));
                        }
                        const until = Date.now() + 600;
                        while ((host()?.getAttribute('aria-expanded') !== 'false' || containers().length) &&
                            Date.now() < until) await sleep(20);
                        out.cleanupOk = host()?.getAttribute('aria-expanded') === 'false' && containers().length === 0;
                    } else out.cleanupOk = true;
                    if (!out.cleanupOk) throw new Error('Could not confirm camera flyout cleanup');
                } catch (error) {
                    out.ok = false;
                    out.error = [out.error, String(error && error.message || error)].filter(Boolean).join('; ');
                    if (out.selectedId !== undefined) out.error = 'Webcam selected, but ' + out.error;
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
