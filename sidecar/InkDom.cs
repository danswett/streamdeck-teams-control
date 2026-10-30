using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace TeamsBridge;

internal static class InkDom
{
    internal sealed record Result(bool Ok, string? Error, string? Tool = null,
        string? Color = null, string? Thickness = null, IReadOnlyList<string>? Palette = null);

    private static bool HasColor(string tool) => tool is "ppt-pen" or "ppt-highlighter" or "ppt-laser";
    private static bool HasThickness(string tool) => tool is "ppt-pen" or "ppt-highlighter";

    internal static string? BuildScript(SelectorConfig config, bool thickness, string? arg, int timeoutMs)
    {
        var text = (arg ?? "").Trim();
        var relative = !thickness || text.StartsWith('+') || text.StartsWith('-');
        double value;
        if (relative)
        {
            if (!int.TryParse(text.Length == 0 && !thickness ? "1" : text,
                NumberStyles.Integer, CultureInfo.InvariantCulture, out var delta)) return null;
            value = delta;
        }
        else if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value) ||
                 !double.IsFinite(value)) return null;
        var colors = (config.PowerPointLive.InkColorNames ?? []).Where(color => !string.IsNullOrWhiteSpace(color))
            .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (colors.Length == 0) return null;

        var tools = config.Controls.Where(entry => entry.Value.ColorFromName &&
            !string.IsNullOrWhiteSpace(entry.Value.AutomationId)).Select(entry => new
            {
                key = entry.Key,
                id = entry.Value.AutomationId,
                color = HasColor(entry.Key),
                thickness = HasThickness(entry.Key)
            }).ToArray();
        if (tools.Length == 0 || tools.Select(tool => tool.id).Distinct().Count() != tools.Length) return null;
        static string Flag(bool value) => value ? "true" : "false";
        var toolData = "[" + string.Join(",", tools.Select(tool =>
            $"{{key:{DomActuator.Js(tool.key)},id:{DomActuator.Js(tool.id)},color:{Flag(tool.color)},thickness:{Flag(tool.thickness)}}}")) + "]";
        var data = "{tools:" + toolData + ",thickness:" + Flag(thickness) + ",relative:" + Flag(relative) +
            ",value:" + value.ToString(CultureInfo.InvariantCulture) +
            ",outside:" + DomActuator.JsArray(config.Controls.Values.Where(spec => !spec.ColorFromName &&
                string.Equals(spec.Surface, config.PowerPointLive.SlideShowSurface, StringComparison.OrdinalIgnoreCase))
                .Select(spec => spec.AutomationId).Append(config.PowerPointLive.ToolbarAutomationId)) +
            ",colors:" + DomActuator.JsArray(colors) + "}";

        return $$"""
        (async function () {
            const data = {{data}};
            const key = '__sdtc_ink_operation', styleId = '__sdtc_ink_suppress';
            const ownedAttribute = 'data-sdtc-ink-owned';
            if (window[key]) return JSON.stringify({ ok: false, error: 'Ink operation still pending' });
            const token = {};
            window[key] = token;
            const out = { ok: false, cleanupOk: false, writeAttempted: false };
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const deadline = Date.now() + {{Math.Max(50, timeoutMs - 1000)}};
            const surfaceSelector = '[role="dialog"],[role="menu"],.fui-PopoverSurface';
            const surfaces = () => [...document.querySelectorAll(surfaceSelector)];
            const disabled = el => el.disabled || el.getAttribute('aria-disabled') === 'true';
            const name = el => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
            const knownColors = data.colors.map(color => color.toLowerCase());
            const selected = () => data.tools.filter(tool =>
                document.getElementById(tool.id)?.getAttribute('aria-selected') === 'true');
            const round = value => {
                const lower = Math.floor(value);
                return value - lower === 0.5 ? lower + (lower % 2 === 0 ? 0 : 1) : Math.round(value);
            };
            const wait = async (test, until = deadline) => {
                while (!test()) {
                    if (Date.now() >= until) throw Error('Ink operation was not confirmed before its deadline');
                    await sleep(20);
                }
            };
            let tool = null, originalOpen = false, initialKnown = false, openAttempted = false;
            let style = null, watchdog = null, observer = null, operationPopup = null, owner = null;
            const host = () => tool ? document.getElementById(tool.id) : null;
            const expanded = () => host()?.getAttribute('aria-expanded');
            const fiber = element => {
                const key = element && Object.keys(element).find(key => key.startsWith('__reactFiber'));
                return key ? element[key] : null;
            };
            const ancestry = node => {
                const nodes = [];
                while (node && typeof node === 'object' && nodes.length < 96 && !nodes.includes(node)) {
                    nodes.push(node);
                    node = node.return;
                }
                return nodes;
            };
            const same = (left, right) => !!left && !!right &&
                (left === right || left.alternate === right || right.alternate === left);
            const popupOwner = () => {
                const outside = data.outside.map(id => ancestry(fiber(document.getElementById(id))))
                    .filter(nodes => nodes.length);
                let branch = null;
                for (const node of ancestry(fiber(host()))) {
                    if (outside.some(nodes => nodes.some(other => same(node, other)))) return branch;
                    branch = node;
                }
                return null;
            };
            const inkPopup = () => {
                // The shared ink portal has no aria-controls link. Read its logical
                // subtree, bounded by neighboring controls; never invoke React handlers.
                const candidates = surfaces().filter(el =>
                    ancestry(fiber(el)).some(node => same(node, owner)));
                const roots = candidates.filter(el => !candidates.some(other => other !== el && other.contains(el)));
                return roots.length === 1 ? roots[0] : null;
            };
            const popup = () => {
                const root = inkPopup();
                return root && surfaces().every(el => root.contains(el) || el.contains(root)) ? root : null;
            };
            const suppressOwnedPopup = () => {
                if (originalOpen || !openAttempted || operationPopup) return;
                const choices = selected();
                if (choices.length !== 1 || choices[0].key !== tool.key) return;
                const scope = inkPopup();
                if (scope) {
                    operationPopup = scope;
                    scope.setAttribute(ownedAttribute, '');
                }
            };
            const live = () => {
                const choices = selected();
                if (choices.length !== 1 || choices[0].key !== tool.key || !host()?.isConnected || disabled(host()))
                    throw Error('The selected drawing tool changed');
                const scope = popup();
                if (expanded() !== 'true' || !scope) throw Error('The drawing-tool popup is not uniquely available');
                if (!originalOpen && scope !== operationPopup) throw Error('The owned ink popup was replaced');
                return scope;
            };
            const palette = scope => {
                const groups = [...scope.querySelectorAll('[role="radiogroup"]')].map(group =>
                    [...group.querySelectorAll('[role="radio"]')]).filter(items =>
                        items.some(item => knownColors.includes(name(item).toLowerCase())));
                if (groups.length !== 1) throw Error('The ink color palette is ambiguous or unavailable');
                const items = groups[0], names = items.map(name);
                const flags = items.map(item => item.getAttribute('aria-checked'));
                if (!items.length || names.some(value => !value) ||
                    new Set(names.map(value => value.toLowerCase())).size !== names.length ||
                    flags.some(value => value !== 'true' && value !== 'false') ||
                    flags.filter(value => value === 'true').length !== 1)
                    throw Error('The current ink color is unknown');
                return { items, names, at: flags.indexOf('true') };
            };
            try {
                const stale = document.getElementById(styleId);
                if (stale) stale.remove();
                for (const element of document.querySelectorAll('[' + ownedAttribute + ']'))
                    element.removeAttribute(ownedAttribute);
                const choices = selected();
                if (choices.length !== 1) throw Error('No unique drawing tool is selected');
                tool = choices[0];
                out.tool = tool.key;
                if (!(data.thickness ? tool.thickness : tool.color))
                    throw Error(data.thickness ? 'This tool has no thickness' : 'This tool has no colors');
                if (disabled(host())) throw Error('The drawing tool is disabled');
                owner = popupOwner();
                if (!owner) throw Error('Drawing-tool popup ownership is unavailable');
                const state = expanded();
                if (state !== 'true' && state !== 'false') throw Error('The drawing-tool popup state is unknown');
                originalOpen = state === 'true';
                if (originalOpen ? !popup() : surfaces().length !== 0)
                    throw Error('Another popup is already open');
                initialKnown = true;
                if (originalOpen) operationPopup = popup();
                if (!originalOpen) {
                    style = document.createElement('style');
                    style.id = styleId;
                    style.textContent = '[' + ownedAttribute + ']{opacity:0!important}';
                    document.head.appendChild(style);
                    watchdog = setTimeout(() => style.remove(), {{Math.Max(100, timeoutMs - 100)}});
                    // Tag the owned popup before paint, without hiding menus opened concurrently.
                    observer = new MutationObserver(suppressOwnedPopup);
                    observer.observe(document.documentElement, {
                        childList: true, subtree: true, attributes: true,
                        attributeFilter: ['aria-expanded', 'aria-selected']
                    });
                    openAttempted = true;
                    host().click();
                    suppressOwnedPopup();
                    await wait(() => expanded() === 'true' && !!operationPopup);
                }
                const beforeName = name(host());
                const scope = live();
                if (data.thickness) {
                    const ranges = [...scope.querySelectorAll('input[type="range"]')];
                    if (ranges.length !== 1) throw Error('The ink thickness slider is ambiguous or unavailable');
                    const slider = ranges[0];
                    const current = Number(slider.value), min = Number(slider.min), max = Number(slider.max);
                    if (!slider.min || !slider.max || !slider.value ||
                        ![current, min, max].every(Number.isFinite) || max <= min || current < min || current > max)
                        throw Error('The ink thickness range is unknown');
                    const wanted = Math.max(min, Math.min(max, round(data.relative ? current + data.value : data.value)));
                    out.value = wanted;
                    if (wanted !== current) {
                        if (!slider.isConnected || disabled(slider)) throw Error('The ink thickness slider is unavailable');
                        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
                        if (!setter) throw Error('The ink thickness slider cannot be set');
                        live();
                        if (Date.now() >= deadline) throw Error('Ink operation deadline expired before writing');
                        out.writeAttempted = true;
                        setter.call(slider, String(wanted));
                        slider.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                } else {
                    const current = palette(live());
                    out.palette = current.names;
                    const index = ((current.at + data.value) % current.items.length + current.items.length) % current.items.length;
                    out.color = current.names[index];
                    if (index !== current.at) {
                        const swatch = current.items[index];
                        if (!swatch.isConnected || disabled(swatch)) throw Error('The ink color is unavailable');
                        if (Date.now() >= deadline) throw Error('Ink operation deadline expired before writing');
                        out.writeAttempted = true;
                        swatch.click();
                    }
                }
                if (out.writeAttempted) await wait(() => !!host() && name(host()) !== beforeName);
                out.ok = true;
            } catch (error) {
                out.error = String(error && error.message || error);
            } finally {
                try {
                    if (initialKnown && (originalOpen || openAttempted)) {
                        const state = expanded();
                        if (state !== 'true' && state !== 'false') throw Error('The drawing-tool popup disappeared during cleanup');
                        if ((state === 'true') !== originalOpen) {
                            const choices = selected();
                            if (choices.length !== 1 || choices[0].key !== tool.key || !host()?.isConnected ||
                                disabled(host()) || state === 'true' && !operationPopup?.isConnected ||
                                state === 'false' && surfaces().length)
                                throw Error('Cannot safely restore the drawing-tool popup');
                            host().click();
                            await wait(() => expanded() === String(originalOpen) &&
                                (originalOpen ? !!inkPopup() : !operationPopup?.isConnected), Date.now() + 700);
                            if (originalOpen) operationPopup = inkPopup();
                        }
                        if (expanded() !== String(originalOpen) ||
                            (originalOpen ? !operationPopup?.isConnected : !!operationPopup?.isConnected))
                            throw Error('The drawing-tool popup was not restored');
                    }
                    out.cleanupOk = true;
                } catch (error) {
                    out.ok = false;
                    out.error = [out.error, String(error && error.message || error)].filter(Boolean).join('; ');
                } finally {
                    if (watchdog !== null) clearTimeout(watchdog);
                    if (observer) observer.disconnect();
                    if (operationPopup) operationPopup.removeAttribute(ownedAttribute);
                    if (style) style.remove();
                    if (window[key] === token) delete window[key];
                }
                if (tool) out.toolName = host() ? name(host()) : null;
            }
            return JSON.stringify(out);
        })()
        """;
    }

    internal static Result Interpret(CdpResult reply, SelectorConfig config, bool thickness)
    {
        if (!reply.Ok) return new(false, $"Direct ink adjustment failed: {reply.Error}; ink settings may already have changed");
        try
        {
            using var doc = JsonDocument.Parse(reply.Json ?? "");
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object) return Invalid();
            string? Text(string key) => root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String
                ? value.GetString() : null;
            if (!root.TryGetProperty("ok", out var ok) || ok.ValueKind != JsonValueKind.True ||
                !root.TryGetProperty("cleanupOk", out var clean) || clean.ValueKind != JsonValueKind.True)
                return new(false, Text("error") ?? "Direct ink adjustment was not confirmed");
            var tool = Text("tool");
            var toolName = Text("toolName");
            if (tool is null || toolName is null || !config.Controls.TryGetValue(tool, out var spec) || !spec.ColorFromName ||
                !(thickness ? HasThickness(tool) : HasColor(tool)))
                return Invalid();
            string? Capture(Regex? pattern)
            {
                var match = pattern?.Match(toolName);
                return match is { Success: true, Groups.Count: > 1 } ? match.Groups[1].Value.Trim() : null;
            }
            var color = Capture(config.PowerPointLive.ToolColorRegex);
            var width = Capture(config.PowerPointLive.ToolThicknessRegex);
            string[]? palette = null;
            if (thickness)
            {
                if (!root.TryGetProperty("value", out var value) || value.ValueKind != JsonValueKind.Number ||
                    !value.TryGetDouble(out var wanted) ||
                    !double.IsFinite(wanted) || !double.TryParse(width, NumberStyles.Float, CultureInfo.InvariantCulture, out var actual) ||
                    actual != wanted) return new(false, "Teams did not confirm the requested ink thickness");
            }
            else
            {
                if (color is null || !string.Equals(color, Text("color"), StringComparison.OrdinalIgnoreCase) ||
                    !root.TryGetProperty("palette", out var colors) || colors.ValueKind != JsonValueKind.Array ||
                    colors.EnumerateArray().Any(item => item.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(item.GetString())))
                    return new(false, "Teams did not confirm the requested ink color");
                palette = colors.EnumerateArray().Select(item => item.GetString()!).ToArray();
                if (palette.Length == 0 || palette.Distinct(StringComparer.OrdinalIgnoreCase).Count() != palette.Length ||
                    !palette.Contains(color, StringComparer.OrdinalIgnoreCase)) return Invalid();
            }
            return new(true, null, tool, color, width, palette);
        }
        catch (JsonException) { return Invalid(); }
        catch (RegexMatchTimeoutException) { return new(false, "Direct ink read-back pattern timed out"); }

        static Result Invalid() => new(false, "Invalid Direct ink result; ink settings may already have changed");
    }
}
