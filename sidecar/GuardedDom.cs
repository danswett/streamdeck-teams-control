using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace TeamsBridge;

internal static class GuardedDom
{
    internal enum Kind { Blur, Grid, TimerToggle, TimerReset, ConfirmPresentation }
    internal sealed record Result(bool Ok, string? Error, bool? State = null);
    internal sealed record GridObservation(bool Open, bool Available);
    private sealed record Candidate(int Index, string Id, string Name, bool? Checked);
    private sealed record Snapshot(IReadOnlyList<Candidate> Candidates, bool GridOpen);
    private sealed record Choice(Candidate Item, int Anchor = -1, bool? State = null,
        bool? Running = null, int? Seconds = null);

    internal static Result Run(SelectorConfig config, Kind kind,
        Func<string, int, CdpResult> evaluate, int timeoutMs)
    {
        var token = Guid.NewGuid().ToString("N");
        var clock = Stopwatch.StartNew();
        int Remaining() => Math.Max(1, timeoutMs - (int)clock.ElapsedMilliseconds);
        var started = false;
        var cleaned = false;
        var result = new Result(false, "Direct operation did not complete");
        try
        {
            var script = BuildPrepare(config, kind, token, timeoutMs);
            started = true;
            using var prepared = Read(evaluate(script, Remaining()));
            Require(Flag(prepared.RootElement, "ready"), Message(prepared.RootElement));
            var before = SnapshotOf(prepared.RootElement);
            var choice = Select(config, kind, before);
            Require(Remaining() > 800, "Direct operation deadline elapsed before writing");
            using var completed = Read(evaluate(BuildFinish(token, choice.Item.Index,
                choice.Item.Name, choice.Item.Checked, choice.Anchor), Remaining()));
            var root = completed.RootElement;
            cleaned = Flag(root, "cleanupOk");
            Require(Flag(root, "ok") && Flag(root, "confirmed") && cleaned, Message(root));
            var after = SnapshotOf(root);
            if (kind == Kind.TimerToggle)
            {
                var running = Unique(after, Pattern(config.Timer.PausePattern), false);
                var paused = Unique(after, Pattern(config.Timer.ResumePattern), false);
                Require(choice.Running == true ? paused is not null && running is null :
                    running is not null && paused is null, "Teams did not confirm the requested timer state");
            }
            if (kind == Kind.TimerReset)
            {
                var controls = Unique(after, Pattern(config.Timer.ControlsPattern))!;
                var seconds = TeamsClient.ParseRemaining(controls.Name, config.Timer);
                Require(seconds.HasValue && seconds > choice.Seconds &&
                    Unique(after, Pattern(config.Timer.CancelPattern), false) is null,
                    "Teams did not confirm that the timer restarted");
            }
            if (kind == Kind.Grid)
                Require(after.GridOpen == choice.State, "Teams did not confirm the grid state");
            result = new(true, null, choice.State);
        }
        catch (Exception ex)
        {
            result = new(false, $"Direct {kind} failed: {ex.Message}; the operation may already have changed Teams");
        }
        finally
        {
            if (started && !cleaned)
            {
                try
                {
                    using var cleanup = Read(evaluate(BuildAbort(token), Math.Max(800, Remaining())));
                    if (!Flag(cleanup.RootElement, "cleanupOk"))
                        result = result with { Ok = false, Error = result.Error + "; " + Message(cleanup.RootElement) };
                }
                catch (Exception ex)
                {
                    result = result with { Ok = false, Error = result.Error + "; cleanup failed: " + ex.Message };
                }
            }
        }
        return result;
    }

    private static Choice Select(SelectorConfig config, Kind kind, Snapshot before)
    {
        var items = before.Candidates;
        if (kind == Kind.Blur)
        {
            var spec = config.Controls["blur"];
            var on = ByIdOrName(items, spec.MenuItemAutomationId, spec.MenuItemRegex);
            var off = ByIdOrName(items, null, spec.MenuItemOffRegex);
            Require(on.Index != off.Index && on.Checked.HasValue, "The current blur state is unknown");
            return new(on.Checked == true ? off : on, State: !on.Checked.Value);
        }
        if (kind == Kind.Grid)
        {
            var spec = config.Controls["ppt-grid"];
            var selected = before.GridOpen
                ? ByIdOrName(items, spec.OffAutomationId, spec.OffRegex)
                : Single(items.Where(item => item.Id == spec.AutomationId));
            return new(selected, State: !before.GridOpen);
        }
        if (kind == Kind.ConfirmPresentation)
            return new(Single(items.Where(item =>
                string.Equals(item.Name, config.Controls["ppt-stop-presenting-confirm"].Name,
                    StringComparison.OrdinalIgnoreCase))));

        var anchor = Unique(before, Pattern(config.Timer.ControlsPattern))!;
        var seconds = TeamsClient.ParseRemaining(anchor.Name, config.Timer);
        Require(seconds is >= 0, "The current timer reading is unknown");
        if (kind == Kind.TimerReset)
        {
            var reset = Unique(before, Pattern(config.Timer.ResetPattern))!;
            Require(!Pattern(config.Timer.CancelPattern).IsMatch(reset.Name), "A timer reset must not cancel the timer");
            return new(reset, anchor.Index, Seconds: seconds);
        }
        var pause = Unique(before, Pattern(config.Timer.PausePattern), false);
        var resume = Unique(before, Pattern(config.Timer.ResumePattern), false);
        Require((pause is null) != (resume is null),
            Unique(before, Pattern(config.Timer.CancelPattern), false) is not null
                ? "time is up; hold to reset" : "No unique running or paused timer is available");
        var toggle = pause ?? resume!;
        Require(!Pattern(config.Timer.CancelPattern).IsMatch(toggle.Name), "A timer toggle must not cancel the timer");
        return new(toggle, anchor.Index, Running: pause is not null);
    }

    private static Regex Pattern(string text) => new(text,
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, ControlSpec.MatchTimeout);

    private static Candidate? Unique(Snapshot snapshot, Regex pattern, bool required = true)
    {
        var matches = snapshot.Candidates.Where(item => pattern.IsMatch(item.Name)).ToArray();
        Require(matches.Length <= 1 && (!required || matches.Length == 1),
            "The named Direct control is missing or ambiguous");
        return matches.SingleOrDefault();
    }

    private static Candidate Single(IEnumerable<Candidate> candidates)
    {
        var matches = candidates.Take(2).ToArray();
        Require(matches.Length == 1, "The named Direct control is missing or ambiguous");
        return matches[0];
    }

    private static Candidate ByIdOrName(IReadOnlyList<Candidate> candidates, string? id, Regex? pattern)
    {
        if (!string.IsNullOrEmpty(id))
        {
            var identified = candidates.Where(item => item.Id == id).Take(2).ToArray();
            Require(identified.Length <= 1, "The Direct control ID is ambiguous");
            if (identified.Length == 1) return identified[0];
        }
        return Single(candidates.Where(item => pattern?.IsMatch(item.Name) == true));
    }

    private static Snapshot SnapshotOf(JsonElement root)
    {
        Require(root.TryGetProperty("candidates", out var candidates) && candidates.ValueKind == JsonValueKind.Array &&
            candidates.GetArrayLength() <= 256, "Invalid Direct control snapshot");
        var rows = new List<Candidate>();
        foreach (var item in candidates.EnumerateArray())
        {
            Require(item.ValueKind == JsonValueKind.Object &&
                item.TryGetProperty("index", out var index) && index.TryGetInt32(out _) &&
                item.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String &&
                item.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String,
                "Invalid Direct control candidate");
            var number = item.GetProperty("index").GetInt32();
            var label = item.GetProperty("name").GetString()!;
            var automationId = item.GetProperty("id").GetString()!;
            Require(number >= 0 && label.Length <= 1024 && automationId.Length <= 1024 &&
                rows.All(row => row.Index != number), "Invalid Direct control identity");
            bool? selected = null;
            if (item.TryGetProperty("checked", out var check) && check.ValueKind != JsonValueKind.Null)
            {
                Require(check.ValueKind is JsonValueKind.True or JsonValueKind.False, "Unknown Direct selection state");
                selected = check.GetBoolean();
            }
            rows.Add(new(number, automationId, label, selected));
        }
        Require(root.TryGetProperty("gridOpen", out var grid) &&
            grid.ValueKind is JsonValueKind.True or JsonValueKind.False, "Invalid Direct grid snapshot");
        return new(rows, grid.GetBoolean());
    }

    private static JsonDocument Read(CdpResult reply)
    {
        Require(reply.Ok && !string.IsNullOrWhiteSpace(reply.Json), reply.Error ?? "Direct operation returned no result");
        var document = JsonDocument.Parse(reply.Json!);
        if (document.RootElement.ValueKind == JsonValueKind.Object) return document;
        document.Dispose();
        throw new InvalidDataException("Invalid Direct operation result");
    }

    private static bool Flag(JsonElement root, string key) =>
        root.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.True;
    private static string Message(JsonElement root) =>
        root.TryGetProperty("error", out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()! : "Direct operation was not confirmed";
    private static void Require([DoesNotReturnIf(false)] bool condition, string message)
    {
        if (!condition) throw new InvalidDataException(message);
    }

    internal static GridObservation? ReadGrid(CdpResult reply, SelectorConfig config)
    {
        try
        {
            using var document = Read(reply);
            if (!Flag(document.RootElement, "known")) return null;
            var snapshot = SnapshotOf(document.RootElement);
            var spec = config.Controls["ppt-grid"];
            var id = snapshot.GridOpen ? spec.OffAutomationId : spec.AutomationId;
            var identified = string.IsNullOrEmpty(id) ? [] :
                snapshot.Candidates.Where(item => item.Id == id).Take(2).ToArray();
            var available = identified.Length == 1;
            if (identified.Length == 0 && snapshot.GridOpen && spec.OffRegex is { } pattern)
                available = snapshot.Candidates.Count(item => pattern.IsMatch(item.Name)) == 1;
            return new(snapshot.GridOpen, available);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Direct grid observation failed: {ex.Message}");
            return null;
        }
    }

    internal static string BuildGridObservation(SelectorConfig config)
    {
        var spec = config.Controls["ppt-grid"];
        return $$"""
        (function() {
            const grid=document.getElementById({{DomActuator.Js(spec.ActiveWhenPresentAutomationId)}});
            const opener=document.getElementById({{DomActuator.Js(spec.AutomationId)}});
            const visible=element=>{
                if(!element?.getClientRects().length)return false;
                for(let node=element;node;node=node.parentElement){
                    const css=getComputedStyle(node);
                    if(css.display==='none'||css.visibility==='hidden')return false;
                }
                return true;
            };
            const open=visible(grid);
            const elements=open?[...grid.querySelectorAll('button,[role="button"]')]:opener?[opener]:[];
            if(elements.length>256)return JSON.stringify({error:'Too many grid controls'});
            const candidates=elements.filter(element=>visible(element)&&!element.disabled&&
                element.getAttribute('aria-disabled')!=='true').map((element,index)=>{
                    const labelled=(element.getAttribute('aria-labelledby')||'').split(' ').filter(Boolean)
                        .map(id=>document.getElementById(id)?.textContent||'').join(' ').trim();
                    return {index,id:element.id||'',name:(labelled||element.getAttribute('aria-label')||
                        element.getAttribute('title')||element.textContent||'').trim(),checked:null};
                });
            return JSON.stringify({known:open||visible(opener),gridOpen:open,candidates});
        })()
        """;
    }

    internal static string BuildFinish(string token, int index, string name, bool? selected, int anchor = -1) =>
        $"window.__sdtc_guarded_operation?.token === {DomActuator.Js(token)} ? " +
        $"window.__sdtc_guarded_operation.finish({index},{DomActuator.Js(name)}," +
        $"{(selected.HasValue ? selected.Value ? "true" : "false" : "null")},{anchor}) : " +
        """JSON.stringify({error:'Direct operation expired or was replaced'})""";

    internal static string BuildAbort(string token) =>
        $"(async()=>{{const op=window.__sdtc_guarded_operation;if(!op)return JSON.stringify({{cleanupOk:true}});" +
        $"if(op.token!=={DomActuator.Js(token)})return JSON.stringify({{error:'Another Direct operation owns cleanup'}});" +
        "return op.abort();})()";

    internal static string BuildPrepare(SelectorConfig config, Kind kind, string token, int timeoutMs)
    {
        var blur = config.Controls["blur"];
        var grid = config.Controls["ppt-grid"];
        var confirm = config.Controls["ppt-stop-presenting-confirm"];
        var cameraId = config.Controls["camera"].AutomationId;
        var cameraTid = config.Controls["camera-select"].MenuItemContainerDataTid;
        Require(kind != Kind.Blur || !string.IsNullOrWhiteSpace(blur.Menu) &&
            !string.IsNullOrWhiteSpace(cameraTid) && string.IsNullOrEmpty(blur.Submenu),
            "Unsupported Direct blur selectors");
        Require(kind != Kind.Grid || !string.IsNullOrWhiteSpace(grid.AutomationId) &&
            !string.IsNullOrWhiteSpace(grid.ActiveWhenPresentAutomationId), "Unsupported Direct grid selectors");
        Require(kind != Kind.ConfirmPresentation || !string.IsNullOrWhiteSpace(confirm.Name) &&
            !string.IsNullOrWhiteSpace(confirm.WithinClass), "Confirmation must be scoped to its dialog");
        var outside = config.Controls.Where(entry => entry.Value.Surface != config.PowerPointLive.SlideShowSurface)
            .SelectMany(entry => new[] { entry.Value.AutomationId, entry.Value.Menu })
            .Where(id => !string.IsNullOrWhiteSpace(id) && (kind != Kind.Blur || id != cameraId && id != blur.Menu))
            .Distinct().ToArray();
        var data = "{kind:" + DomActuator.Js(kind.ToString()) + ",token:" + DomActuator.Js(token) +
            ",menu:" + DomActuator.Js(blur.Menu) + ",cameraTid:" + DomActuator.Js(cameraTid) +
            ",grid:" + DomActuator.Js(grid.ActiveWhenPresentAutomationId) +
            ",gridButton:" + DomActuator.Js(grid.AutomationId) +
            ",dialogClass:" + DomActuator.Js(confirm.WithinClass) +
            ",presenter:" + DomActuator.Js(config.PowerPointLive.PresenterMarkerAutomationId) +
            ",outside:" + DomActuator.JsArray(outside) + "}";
        return $$"""
        (async function () {
            const data = {{data}}, key = '__sdtc_guarded_operation';
            if (window[key]) return JSON.stringify({error:'Another Direct operation is pending'});
            const attribute = 'data-sdtc-guarded-owned', styleId = '__sdtc_guarded_suppress';
            const surfaceSelector = '[role="dialog"],[role="alertdialog"],[role="menu"],.fui-PopoverSurface';
            const buttons = 'button,[role="button"],[role="radio"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],input[type="radio"]';
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const until = Date.now() + {{Math.Max(50, timeoutMs - 800)}};
            const operation = {token:data.token};
            let rows = [], owner = null, ownedPopup = null, timerOwner = null, timerScope = null, dialog = null;
            let originalOpen = false, knownOpen = false, opened = false, writeAttempted = false;
            let style = null, observer = null, watchdog = null, cleaned = false, reopened = false, finishing = false;
            const host = () => document.getElementById(data.menu);
            const initialHost = host();
            const originalGridOpen = !!document.getElementById(data.grid);
            const surfaces = () => [...document.querySelectorAll(surfaceSelector)];
            const disabled = el => !el || el.disabled || el.getAttribute('aria-disabled') === 'true';
            const name = el => {
                const labelled = (el.getAttribute('aria-labelledby') || '').split(' ').filter(Boolean)
                    .map(id => document.getElementById(id)?.textContent || '').join(' ').trim();
                const labels = el.labels ? [...el.labels].map(label => label.textContent || '').join(' ').trim() : '';
                return (labelled || el.getAttribute('aria-label') || labels || el.getAttribute('title') ||
                    el.textContent || '').trim();
            };
            const props = el => {
                const key = Object.keys(el).find(key => key.startsWith('__reactProps'));
                return key ? el[key] : null;
            };
            const checked = el => {
                for (const key of ['aria-checked','aria-selected','aria-pressed']) {
                    const value = el.getAttribute(key);
                    if (value !== null) return value === 'true' ? true : value === 'false' ? false : null;
                }
                const value = props(el)?.checked;
                return typeof value === 'boolean' && value === el.checked ? value : null;
            };
            const fiber = el => {
                const key = el && Object.keys(el).find(key => key.startsWith('__reactFiber'));
                return key ? el[key] : null;
            };
            const ancestry = node => {
                const nodes = [];
                while (node && typeof node === 'object' && nodes.length < 96 && !nodes.includes(node)) {
                    nodes.push(node); node = node.return;
                }
                return nodes;
            };
            const same = (left,right) => !!left && !!right &&
                (left === right || left.alternate === right || right.alternate === left);
            const belongs = (el,branch) => !!branch && ancestry(fiber(el)).some(node => same(node,branch));
            const branchFor = el => {
                const outside = data.outside.map(id => document.getElementById(id)).filter(other => other && other !== el)
                    .map(other => ancestry(fiber(other))).filter(nodes => nodes.length);
                if (!outside.length) return null;
                let branch = null;
                for (const node of ancestry(fiber(el))) {
                    if (outside.some(nodes => nodes.some(other => same(node,other)))) return branch;
                    branch = node;
                }
                return null;
            };
            const wait = async (test, deadline = until) => {
                while (!test()) {
                    if (Date.now() >= deadline) throw Error('Teams did not confirm the Direct operation before its deadline');
                    await sleep(20);
                }
            };
            const visible = el => {
                if (el.isConnected === false || !el.getClientRects().length) return false;
                for (let node = el; node; node = node.parentElement) {
                    const css = getComputedStyle(node);
                    // The visible background grid is aria-hidden to accessibility.
                    if (css.display === 'none' || css.visibility === 'hidden')
                        return false;
                }
                return true;
            };
            const blurPopup = () => {
                const lists = [...document.querySelectorAll('[data-tid]')].filter(el =>
                    el.getAttribute('data-tid') === data.cameraTid && el.getAttribute('role') === 'listbox');
                const roots = [...new Set(lists.map(el => el.closest('[role="dialog"]')).filter(el => el && belongs(el,owner)))];
                return roots.length === 1 ? roots[0] : null;
            };
            const markPopup = () => {
                if (originalOpen || !opened || ownedPopup) return;
                const popup = blurPopup();
                if (popup) { ownedPopup = popup; popup.setAttribute(attribute,''); }
            };
            const foreign = scope => surfaces().some(el => !(scope && (scope.contains(el) || el.contains(scope))));
            const remember = el => {
                let index = rows.indexOf(el);
                if (index < 0) { index = rows.length; rows.push(el); }
                return {index,id:el.id || '',name:name(el),checked:checked(el)};
            };
            const candidates = () => {
                let scope = document;
                if (data.kind === 'Blur') scope = blurPopup();
                if (data.kind === 'Grid' && document.getElementById(data.grid)) scope = document.getElementById(data.grid);
                if (data.kind === 'ConfirmPresentation') scope = dialog;
                if (!scope) throw Error('The Direct control scope disappeared');
                let elements = [...scope.querySelectorAll(buttons)].filter(visible);
                if (data.kind === 'TimerToggle' || data.kind === 'TimerReset')
                    elements = elements.filter(el => timerScope ? timerScope.contains(el) :
                        !timerOwner || belongs(el,timerOwner));
                if (data.kind === 'Grid' && scope === document)
                    elements = elements.filter(el => el.id === data.gridButton);
                if (elements.length > 256) throw Error('Too many candidate Direct controls');
                return elements.map(remember);
            };
            const snapshot = () => ({candidates:candidates(),gridOpen:!!document.getElementById(data.grid)});
            const restorePopup = async () => {
                if (data.kind !== 'Blur' || !knownOpen) return;
                const expanded = host()?.getAttribute('aria-expanded');
                if (host() !== initialHost || !['true','false'].includes(expanded))
                    throw Error('The video options host changed during cleanup');
                if ((expanded === 'true') === originalOpen) return;
                if (expanded === 'true' && (!ownedPopup?.isConnected || blurPopup() !== ownedPopup) ||
                    expanded === 'false' && surfaces().length)
                    throw Error('Cannot safely restore the owned video options');
                host().click();
                await wait(() => host()?.getAttribute('aria-expanded') === String(originalOpen),
                    Date.now()+600);
            };
            const cleanup = async () => {
                if (cleaned) return;
                let failure;
                try { await restorePopup(); }
                catch (error) { failure = error; }
                finally {
                    if (watchdog !== null) clearTimeout(watchdog);
                    observer?.disconnect();
                    ownedPopup?.removeAttribute(attribute);
                    style?.remove();
                    if (window[key] === operation) delete window[key];
                    cleaned = true;
                }
                if (failure) throw failure;
            };
            operation.abort = async () => {
                try { await cleanup(); return JSON.stringify({cleanupOk:true}); }
                catch (error) { return JSON.stringify({error:String(error.message || error)}); }
            };
            operation.finish = async (index, expectedName, beforeChecked, anchorIndex) => {
                if (finishing) return JSON.stringify({error:'A Direct write is already pending'});
                finishing = true;
                const out = {ok:false,confirmed:false,cleanupOk:false};
                try {
                    if (cleaned || window[key] !== operation || Date.now() >= until || writeAttempted)
                        throw Error('The Direct operation expired or already attempted its write');
                    const item = rows[index];
                    if (!item || !visible(item) || disabled(item) || name(item) !== expectedName ||
                        beforeChecked !== null && checked(item) !== beforeChecked)
                        throw Error('The chosen Direct control changed before writing');
                    if (data.kind === 'Blur') {
                        const popup = blurPopup();
                        if (!popup || foreign(popup) || !popup.contains(item) ||
                            !originalOpen && popup !== ownedPopup)
                            throw Error('The blur popup is no longer uniquely owned');
                    }
                    if (data.kind === 'Grid') {
                        const grid = document.getElementById(data.grid);
                        if (!!grid !== originalGridOpen || foreign(grid) ||
                            (grid ? !grid.contains(item) : item.id !== data.gridButton))
                            throw Error('The grid state or its control scope changed');
                    }
                    if (data.kind === 'TimerToggle' || data.kind === 'TimerReset') {
                        const anchor = rows[anchorIndex];
                        if (!anchor?.isConnected) throw Error('The timer controls disappeared');
                        const outside = data.outside.map(id => document.getElementById(id)).filter(Boolean);
                        if (!outside.length) throw Error('The timer scope boundary is unavailable');
                        let scope = anchor;
                        while (scope && !scope.contains(item)) {
                            if (outside.some(element => scope.contains(element))) { scope = null; break; }
                            scope = scope.parentElement;
                        }
                        if (scope && !outside.some(element => scope.contains(element))) timerScope = scope;
                        else timerOwner = branchFor(anchor);
                        if (!(timerScope || timerOwner && belongs(item,timerOwner)) ||
                            surfaces().some(el => timerScope
                                ? !timerScope.contains(el) && !el.contains(timerScope)
                                : !belongs(el,timerOwner)))
                            throw Error('The timer controls are not uniquely scoped');
                    }
                    if (data.kind === 'ConfirmPresentation' &&
                        (!dialog?.isConnected || foreign(dialog) || !dialog.contains(item) ||
                            !document.getElementById(data.presenter)))
                        throw Error('The presentation confirmation changed');
                    const gridOpen = !!document.getElementById(data.grid);
                    const anchorName = anchorIndex >= 0 ? name(rows[anchorIndex]) : '';
                    if (Date.now() >= until) throw Error('The invocation deadline elapsed before writing');
                    writeAttempted = true;
                    item.click();
                    if (data.kind === 'Blur') {
                        if (!blurPopup() || host()?.getAttribute('aria-expanded') === 'false') {
                            if (reopened || host() !== initialHost || disabled(host()) || surfaces().length)
                                throw Error('Cannot observe the selected background effect safely');
                            reopened = true;
                            ownedPopup?.removeAttribute(attribute);
                            ownedPopup = null;
                            host().click(); markPopup();
                            await wait(() => !!blurPopup());
                            if (!originalOpen) { ownedPopup = blurPopup(); ownedPopup.setAttribute(attribute,''); }
                        }
                        await wait(() => {
                            const popup = blurPopup();
                            return popup && [...popup.querySelectorAll(buttons)]
                                .some(el => name(el) === expectedName && checked(el) === true);
                        });
                    } else if (data.kind === 'Grid') {
                        await wait(() => !!document.getElementById(data.grid) !== gridOpen &&
                            (gridOpen ? !!document.getElementById(data.gridButton) : true));
                    } else if (data.kind === 'ConfirmPresentation') {
                        await wait(() => !dialog.isConnected && !document.getElementById(data.presenter));
                    } else if (data.kind === 'TimerToggle') {
                        await wait(() => item.isConnected === false || name(item) !== expectedName);
                    } else {
                        await wait(() => rows[anchorIndex]?.isConnected === false ||
                            name(rows[anchorIndex]) !== anchorName);
                    }
                    Object.assign(out,snapshot());
                    out.confirmed = true; out.ok = true;
                } catch (error) { out.error = String(error.message || error); }
                finally {
                    try { await cleanup(); out.cleanupOk = true; }
                    catch (error) { out.ok = false; out.error = [out.error,String(error.message || error)].filter(Boolean).join('; '); }
                }
                return JSON.stringify(out);
            };
            window[key] = operation;
            watchdog = setTimeout(() => {
                operation.abort().then(reply => {
                    const result = JSON.parse(reply);
                    if (!result.cleanupOk) console.error('Direct cleanup watchdog: '+result.error);
                });
            }, {{Math.Max(100, timeoutMs - 100)}});
            try {
                if (data.kind === 'Blur') {
                    if (!initialHost || disabled(initialHost)) throw Error('Video options are unavailable');
                    owner = branchFor(initialHost);
                    if (!owner) throw Error('Video popup ownership is unavailable');
                    const expanded = initialHost.getAttribute('aria-expanded');
                    if (!['true','false'].includes(expanded)) throw Error('The video options state is unknown');
                    originalOpen = expanded === 'true';
                    if (originalOpen ? !blurPopup() || foreign(blurPopup()) : surfaces().length)
                        throw Error('Another Teams popup is open');
                    knownOpen = true;
                    if (originalOpen) ownedPopup = blurPopup();
                    else {
                        style = document.createElement('style'); style.id = styleId;
                        style.textContent = '['+attribute+']{opacity:0!important}';
                        document.head.appendChild(style);
                        observer = new MutationObserver(markPopup);
                        observer.observe(document.documentElement,{childList:true,subtree:true,attributes:true,
                            attributeFilter:['aria-expanded']});
                        opened = true; initialHost.click(); markPopup();
                        await wait(() => initialHost.getAttribute('aria-expanded') === 'true' && !!ownedPopup);
                    }
                }
                if (data.kind === 'ConfirmPresentation') {
                    await wait(() => {
                        const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"]')]
                            .filter(el => (el.getAttribute('class') || '').toLowerCase()
                                .includes(data.dialogClass.toLowerCase()));
                        if (dialogs.length > 1) throw Error('The presentation confirmation is ambiguous');
                        dialog = dialogs.length === 1 ? dialogs[0] : null;
                        return dialog && !!document.getElementById(data.presenter);
                    });
                }
                return JSON.stringify({ready:true,...snapshot()});
            } catch (error) {
                const out = {error:String(error.message || error)};
                try { await cleanup(); out.cleanupOk = true; }
                catch (failure) { out.error += '; '+String(failure.message || failure); }
                return JSON.stringify(out);
            }
        })()
        """;
    }
}
