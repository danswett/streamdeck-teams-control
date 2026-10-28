using System.Text.Json;

namespace TeamsBridge;

internal static class MusicModeDom
{
    internal sealed record Result(bool Ok, bool? Active, bool SafeToFallback, string? Error);

    // The minimized mini-meeting also has a microphone button, but no audio-options host.
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
        if (!reply.Ok) return new(false, null, false, reply.Error ?? "Direct music-mode evaluation failed");
        try
        {
            using var doc = JsonDocument.Parse(reply.Json ?? "");
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
                return new(false, null, false, "Invalid Direct music-mode result");
            var active = root.TryGetProperty("active", out var state) &&
                state.ValueKind is JsonValueKind.True or JsonValueKind.False ? (bool?)state.GetBoolean() : null;
            var ok = root.TryGetProperty("ok", out var success) && success.ValueKind == JsonValueKind.True;
            if (ok && active.HasValue) return new(true, active, false, null);
            var error = root.TryGetProperty("error", out var message) && message.ValueKind == JsonValueKind.String
                ? message.GetString() : "Direct music-mode result was not confirmed";
            var safe = !ok && !active.HasValue && root.TryGetProperty("safeToFallback", out var fallback) &&
                fallback.ValueKind == JsonValueKind.True;
            return new(false, active, safe, error);
        }
        catch (JsonException ex) { return new(false, null, false, $"Invalid Direct music-mode result: {ex.Message}"); }
    }

    internal static string? BuildScript(ControlSpec spec, int timeoutMs)
    {
        if (string.IsNullOrWhiteSpace(spec.Menu) || string.IsNullOrWhiteSpace(spec.MenuItemDataTid)) return null;
        return $$"""
        (async function () {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const host = () => document.getElementById({{DomActuator.Js(spec.Menu)}});
            const tid = {{DomActuator.Js(spec.MenuItemDataTid)}};
            const key = '__sdtc_music_operation';
            const styleId = '__sdtc_music_suppress';
            if (window[key]) return JSON.stringify({ ok: false, error: 'Music mode operation still pending' });
            const token = {};
            window[key] = token;
            const out = { ok: false };
            const deadline = Date.now() + {{Math.Max(50, timeoutMs - 800)}};
            let owned = false, initialKnown = false, writeAttempted = false, style = null, watchdog = null, cleanupOk = false;
            const find = () => {
                if (host()?.getAttribute('aria-expanded') !== 'true') return null;
                const matches = [...document.querySelectorAll('[data-tid]')].filter(el => el.getAttribute('data-tid') === tid);
                if (matches.length !== 1) return null;
                const el = matches[0];
                if (el.tagName !== 'INPUT' || el.type !== 'checkbox' || el.getAttribute('role') !== 'switch') return null;
                return el;
            };
            const read = () => {
                const el = find();
                if (!el) return null;
                if (el.disabled || el.getAttribute('aria-disabled') === 'true') throw new Error('Music mode is disabled');
                return el.indeterminate || typeof el.checked !== 'boolean' ? null : { el, active: el.checked };
            };
            const known = async () => {
                do {
                    const value = read();
                    if (value) return value;
                    await sleep(20);
                } while (Date.now() < deadline);
                throw new Error('Teams did not expose a known music-mode state');
            };
            try {
                const trigger = host();
                if (!trigger || trigger.disabled || trigger.getAttribute('aria-disabled') === 'true')
                    throw new Error('Audio options are unavailable');
                const expanded = trigger.getAttribute('aria-expanded');
                if (expanded !== 'true' && expanded !== 'false') throw new Error('Unknown audio options state');
                if (expanded === 'false') {
                    document.getElementById(styleId)?.remove();
                    style = document.createElement('style');
                    style.id = styleId;
                    style.textContent = '.fui-PopoverSurface,[data-popper-placement],[role="menu"],[role="dialog"]{opacity:0!important}';
                    document.head.appendChild(style);
                    watchdog = setTimeout(() => style.remove(), {{Math.Max(100, timeoutMs - 50)}});
                    owned = true;
                    trigger.click();
                }
                const initial = await known();
                initialKnown = true;
                const desired = !initial.active;
                let fresh;
                do {
                    await known();
                    // Awaiting even a known value yields; re-find synchronously before the write.
                    fresh = read();
                    if (Date.now() >= deadline) throw new Error('Music-mode operation deadline elapsed');
                } while (!fresh);
                if (fresh.active !== desired) {
                    writeAttempted = true;
                    fresh.el.click();
                    await sleep(20);
                }
                do {
                    const observed = read();
                    if (observed && observed.active === desired) {
                        out.active = desired;
                        out.ok = true;
                        break;
                    }
                    await sleep(20);
                } while (Date.now() < deadline);
                if (!out.ok) throw new Error('Teams did not confirm the music-mode change');
            } catch (error) {
                out.error = String(error && error.message || error);
            } finally {
                try {
                    if (owned) {
                        if (host()?.getAttribute('aria-expanded') !== 'false') {
                            const closer = find() || host();
                            if (closer) closer.dispatchEvent(new KeyboardEvent('keydown', {
                                key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
                            }));
                            const until = Date.now() + 600;
                            while (host()?.getAttribute('aria-expanded') !== 'false' && Date.now() < until) await sleep(20);
                        }
                        cleanupOk = host()?.getAttribute('aria-expanded') === 'false';
                    } else cleanupOk = true;
                    if (!cleanupOk) throw new Error('Could not confirm audio flyout cleanup');
                } catch (error) {
                    out.ok = false;
                    out.error = [out.error, String(error && error.message || error)].filter(Boolean).join('; ');
                } finally {
                    if (watchdog !== null) clearTimeout(watchdog);
                    style?.remove();
                    if (window[key] === token) delete window[key];
                }
                out.safeToFallback = !initialKnown && !writeAttempted && !out.ok && cleanupOk && out.active === undefined;
            }
            return JSON.stringify(out);
        })()
        """;
    }
}
