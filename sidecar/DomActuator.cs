using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace TeamsBridge;

/// <summary>
/// Whether the Direct path took the press, and how it went.
///
/// "Declined" is deliberately distinct from "failed": a control the DOM path
/// does not handle — or a port that is not there — is the normal case and must
/// fall through to UI Automation silently, whereas a genuine failure is worth
/// a line in the log before the same fallback happens.
/// </summary>
internal sealed record DomOutcome(bool Handled, bool Ok, string? Error)
{
    public static readonly DomOutcome Declined = new(false, false, null);
    public static DomOutcome Success() => new(true, true, null);
    public static DomOutcome Failed(string why) => new(true, false, why);
}

/// <summary>
/// Drives Teams by evaluating JavaScript in its own page, rather than by
/// walking the accessibility tree and posting synthetic clicks.
///
/// Two things this buys, both of which UI Automation cannot:
///
/// 1. A flyout never appears. Chromium only materializes menu items into the
///    accessibility tree once the popup is genuinely open, so the UIA path has
///    no choice but to open it on screen. From inside the page the same menu
///    can be opened, read, used and closed while styled invisible.
///
/// 2. It works with the window minimized. A posted click needs on-screen
///    bounds, and the UIA fallback for that case activates the Teams window.
///
/// Everything here is best-effort. Any failure returns and the caller runs the
/// UI Automation path, so Direct mode can never make a control less reliable
/// than it was — at worst a press costs one wasted round trip on loopback.
/// </summary>
internal sealed class DomActuator
{
    /// <summary>
    /// Marks the injected stylesheet so a later press can sweep one up that an
    /// earlier press did not get to remove. A crash between injecting and
    /// removing would otherwise leave Teams' own menus invisible to the user,
    /// which is a far worse failure than the one this class exists to fix.
    /// </summary>
    private const string StyleId = "__sdtc_suppress";

    /// <summary>
    /// What to hide while a menu is being driven. Teams renders flyouts as
    /// Fluent popovers; the positional and role selectors catch the rest.
    ///
    /// Opacity rather than display or visibility on purpose: the element still
    /// lays out and still receives the clicks being aimed at it, it simply does
    /// not paint. Hiding it outright would unmount or skip hit-testing and the
    /// item click would land on nothing.
    /// </summary>
    private const string SurfaceSelector =
        ".fui-PopoverSurface,[data-popper-placement],[role=\"menu\"],[role=\"dialog\"]";

    private readonly DirectModeSpec _spec;

    private CdpTarget? _meetingPage;
    private CdpTarget? _slideShow;
    private long _probedUntil;
    private DirectModeStatus _status = DirectModeStatus.Off("not probed yet");

    public DomActuator(DirectModeSpec spec) => _spec = spec;

    public DirectModeStatus Status => _status;

    /// <summary>
    /// Whether a press may use the Direct path right now. Re-probes on a short
    /// TTL because Teams recreates its targets on navigation, and the slideshow
    /// iframe comes and goes with every deck.
    /// </summary>
    public bool IsUsable
    {
        get
        {
            if (!_spec.Enabled) { _status = DirectModeStatus.Off("not enabled"); return false; }
            if (Environment.TickCount64 < _probedUntil) return _status.Usable;
            Probe();
            return _status.Usable;
        }
    }

    /// <summary>
    /// Looks for a usable debugging port and works out which target is the
    /// meeting.
    ///
    /// The ownership check matters: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    /// applies to every WebView2 host the user launches, and only one process
    /// can bind a given port. If OneNote started first, the port answers
    /// perfectly well and belongs to something that is not Teams — attaching to
    /// it would be both useless and a privacy problem, so a port with no Teams
    /// target is treated as no port at all.
    /// </summary>
    public void Probe()
    {
        var wasUsable = _status.Usable;
        _probedUntil = Environment.TickCount64 + _spec.ProbeTtlMs;
        _meetingPage = null;
        _slideShow = null;

        if (!_spec.Enabled) { _status = DirectModeStatus.Off("not enabled"); return; }

        var targets = Cdp.ListTargets(_spec.Port, Math.Min(_spec.TimeoutMs, 1500));
        if (targets is null)
        {
            _status = DirectModeStatus.Off($"no debugging port on {_spec.Port}");
            return;
        }

        // Ask the operating system who holds the socket, rather than asking the
        // socket who it is. The endpoint reports its own targets, so a check
        // against the URL it returns is self-assertion: any local process can
        // claim to be Teams, and a browser with a teams.microsoft.com tab open
        // claims it truthfully while still being the wrong thing to drive.
        //
        // The socket belongs to the WebView2 browser process rather than to
        // Teams itself, so the walk up to the host application is the check
        // that matters, not the direct owner.
        var (owned, owner) = PortOwner.IsOwnedBy(_spec.Port, TeamsProcessName);
        if (!owned)
        {
            _status = DirectModeStatus.Off(owner is null
                ? $"could not establish who owns port {_spec.Port}"
                : $"port {_spec.Port} belongs to {owner}, which is not Teams");
            return;
        }

        var teamsPages = targets
            .Where(t => t.Type == "page" &&
                        t.Url.StartsWith("https://teams.microsoft.com/", StringComparison.OrdinalIgnoreCase))
            .Take(MaxPagesToProbe)
            .ToList();

        if (teamsPages.Count == 0)
        {
            _status = DirectModeStatus.Off(
                $"port {_spec.Port} is open but has no Teams window");
            return;
        }

        // Teams keeps several page targets alive — the main window, chat
        // pop-outs, the meeting. Only one has the meeting toolbar in it, and
        // asking is cheaper and more honest than guessing from the title, which
        // is localized and changes with the meeting subject.
        foreach (var page in teamsPages)
        {
            // Returned as JSON rather than a bare boolean so it is read the
            // same way as every other script result here. A raw CDP boolean
            // arrives as .NET's "True", which is not what a JSON comparison
            // expects.
            var probe = Cdp.Evaluate(page,
                $"JSON.stringify({{ found: !!document.getElementById({Js(_probeElementId)}) }})",
                Math.Min(_spec.TimeoutMs, 1500));

            if (!probe.Ok || probe.Json is null) continue;
            try
            {
                using var doc = JsonDocument.Parse(probe.Json);
                if (doc.RootElement.TryGetProperty("found", out var f) &&
                    f.ValueKind == JsonValueKind.True)
                {
                    _meetingPage = page;
                    break;
                }
            }
            catch (JsonException) { }
        }

        if (_meetingPage is null)
        {
            _status = DirectModeStatus.Off("connected, but no meeting window");
            return;
        }

        _slideShow = targets.FirstOrDefault(t => IsSlideShowTarget(t.Url));

        _status = new DirectModeStatus(
            true,
            $"connected on {_spec.Port}",
            _slideShow is not null,
            Cdp.BrowserVersion(_spec.Port, 500));

        // Logged on the transition rather than per press: useful to know the
        // optional path went live, useless repeated on every key.
        if (!wasUsable)
            Console.Error.WriteLine(
                $"direct mode active on port {_spec.Port} (deck shared: {_slideShow is not null})");
    }

    private string _probeElementId = "microphone-button";

    /// <summary>The process that must own the port before it will be used.</summary>
    private const string TeamsProcessName = "ms-teams";

    /// <summary>
    /// How many candidate pages to interrogate before giving up.
    ///
    /// Each one costs a connect and an evaluation, so an endpoint advertising
    /// a long list of Teams-looking pages turns discovery into a stall on the
    /// single worker thread that also serves key presses: sixty of them was
    /// measured blocking it for ninety seconds. Teams keeps a handful of page
    /// targets, so a small ceiling costs nothing real.
    /// </summary>
    private const int MaxPagesToProbe = 8;

    /// <summary>
    /// Whether a target is genuinely the PowerPoint Live slide show.
    ///
    /// Matched on host and path rather than by looking for "slideshow.aspx"
    /// anywhere in the URL, which a query string can satisfy.
    /// </summary>
    internal static bool IsSlideShowTarget(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        if (uri.Scheme != Uri.UriSchemeHttps) return false;
        if (!uri.Host.EndsWith(".officeapps.live.com", StringComparison.OrdinalIgnoreCase)) return false;
        return uri.AbsolutePath.EndsWith("/slideshow.aspx", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// The element that proves a page target is the meeting window. Taken from
    /// the same config value the UI Automation path probes with, so a Teams
    /// change only has to be corrected in one place.
    /// </summary>
    public void UseProbeElement(string automationId)
    {
        if (!string.IsNullOrWhiteSpace(automationId)) _probeElementId = automationId;
    }

    /// <summary>
    /// The document a control lives in. PowerPoint Live is a separate web
    /// application in an iframe — a different origin, and its own debugging
    /// target — so a slide-show control has to be driven there rather than in
    /// the Teams page.
    /// </summary>
    private CdpTarget? TargetFor(bool slideShowSurface) =>
        slideShowSurface ? _slideShow : _meetingPage;

    /// <summary>
    /// Presses a control without showing its flyout.
    ///
    /// Declines anything it has no better answer for than UI Automation, which
    /// keeps the fallback the common path rather than the exceptional one.
    /// </summary>
    public DomOutcome Invoke(string target, ControlSpec spec, string? arg, bool slideShowSurface,
        out bool? checkedBefore)
    {
        checkedBefore = null;
        if (!IsUsable) return DomOutcome.Declined;

        // Matched by name inside a transient dialog, with no id to find it by.
        // Ending a presentation is one-way, and the UIA path already invokes
        // that button deterministically; there is nothing to gain here.
        if (spec.IsPressOnly) return DomOutcome.Declined;

        var page = TargetFor(slideShowSurface);
        // No target: for a slide-show control that simply means no deck is
        // shared. Either way UI Automation is the answer, not an error.
        if (page is null) return DomOutcome.Declined;

        var script = string.IsNullOrEmpty(spec.Menu)
            ? BuildDirectClick(spec, arg)
            : BuildMenuWalk(spec, arg);

        if (script is null) return DomOutcome.Declined;

        var res = Cdp.Evaluate(page, script, _spec.TimeoutMs);
        if (!res.Ok) return DomOutcome.Failed(res.Error ?? "evaluation failed");

        return Interpret(res.Json, target, out checkedBefore);
    }

    /// <summary>
    /// Reads the structured result every injected script returns.
    /// </summary>
    internal static DomOutcome Interpret(string? json, string target, out bool? checkedBefore)
    {
        checkedBefore = null;
        if (string.IsNullOrWhiteSpace(json)) return DomOutcome.Failed("script returned nothing");

        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;

            if (root.TryGetProperty("checkedBefore", out var cb) &&
                (cb.ValueKind == JsonValueKind.True || cb.ValueKind == JsonValueKind.False))
                checkedBefore = cb.GetBoolean();

            // Teams drops the click handler from a control it has disabled, so
            // a synthetic click on one is silently ignored however it is
            // dispatched. Declining sends the press to UI Automation, which
            // reports "disabled" properly rather than claiming a success the
            // user can see did not happen.
            if (root.TryGetProperty("noHandler", out var nh) && nh.ValueKind == JsonValueKind.True)
                return DomOutcome.Declined;

            if (root.TryGetProperty("ok", out var ok) && ok.ValueKind == JsonValueKind.True)
                return DomOutcome.Success();

            var error = root.TryGetProperty("error", out var e) ? e.GetString() : null;
            return DomOutcome.Failed(error ?? $"'{target}' could not be pressed");
        }
        catch (JsonException) { return DomOutcome.Failed("unreadable script result"); }
    }

    /// <summary>
    /// Jumps straight to a slide by posting PowerPoint Live's own navigation
    /// message into the slide-show iframe.
    ///
    /// This is the command Teams itself sends; the on-screen buttons are only
    /// one way of raising it. The UI Automation path has to invoke a filmstrip
    /// tile instead, which means the grid has to be open for the tile to exist,
    /// so a jump could never be made without putting the grid on screen first.
    ///
    /// The message needs the id agreed during the host/iframe handshake, which
    /// the bootstrapper also writes into the iframe element's own id
    /// ("pptframe-{id}"), so it can simply be read back out of the DOM.
    /// </summary>
    public DomOutcome GoToSlide(int oneBasedSlide)
    {
        if (!IsUsable) return DomOutcome.Declined;
        if (_meetingPage is null || _slideShow is null) return DomOutcome.Declined;
        if (oneBasedSlide < 1) return DomOutcome.Failed($"no slide {oneBasedSlide}");

        // The protocol counts from zero; slide numbers, and this plugin, count
        // from one.
        var index = oneBasedSlide - 1;

        var script = $$"""
        (function () {
            var f = document.querySelector('iframe[id^="pptframe-"]');
            if (!f || !f.contentWindow) return JSON.stringify({ error: 'no PowerPoint Live frame' });
            f.contentWindow.postMessage({
                m_type: 9,
                m_id: f.id.replace('pptframe-', ''),
                m_slideIndex: {{index}},
                m_timeLineMappings: [],
                m_metadata: {}
            }, '*');
            return JSON.stringify({ ok: true });
        })()
        """;

        var res = Cdp.Evaluate(_meetingPage, script, _spec.TimeoutMs);
        if (!res.Ok) return DomOutcome.Failed(res.Error ?? "evaluation failed");
        return Interpret(res.Json, "ppt-goto-slide", out _);
    }

    /// <summary>
    /// Clicks a plain toolbar control.
    ///
    /// Checks for a React click handler before committing. Teams removes the
    /// handler from a control it has disabled — the microphone button in a
    /// meeting that does not allow unmuting reports aria-disabled and carries
    /// no onClick — and a synthetic click on one of those is ignored however it
    /// is dispatched, including through the debugger's own trusted input.
    /// Reporting that honestly lets the caller fall back instead of claiming a
    /// success the user can see did not happen.
    /// </summary>
    internal static string? BuildDirectClick(ControlSpec spec, string? arg)
    {
        var id = Fill(spec.AutomationId, arg);
        if (string.IsNullOrEmpty(id)) return null;

        return $$"""
        (function () {
            var stale = document.getElementById({{Js(StyleId)}});
            if (stale) stale.remove();

            var el = document.getElementById({{Js(id)}});
            if (!el) return JSON.stringify({ error: 'control not found' });
            if (el.disabled || el.getAttribute('aria-disabled') === 'true')
                return JSON.stringify({ error: 'control is disabled' });

            var key = Object.keys(el).find(function (k) { return k.indexOf('__reactProps') === 0; });
            var props = key ? el[key] : null;
            if (!props || (typeof props.onClick !== 'function' && typeof props.onPointerUp !== 'function'))
                return JSON.stringify({ noHandler: true });

            el.click();
            return JSON.stringify({ ok: true });
        })()
        """;
    }

    /// <summary>
    /// Opens a menu, chooses an item and closes it again, with the popup
    /// styled invisible throughout.
    ///
    /// The stylesheet goes up before the menu is opened and comes down in a
    /// finally, so the window in which Teams' own menus could be hidden from
    /// the user is bounded by one press even if the script throws.
    /// </summary>
    internal static string? BuildMenuWalk(ControlSpec spec, string? arg)
    {
        var menu = spec.Menu;
        if (string.IsNullOrEmpty(menu)) return null;

        var ids = new[]
        {
            Fill(spec.MenuItemAutomationId, arg),
            Fill(spec.MenuItemToggleAutomationId, arg)
        }.Where(x => !string.IsNullOrEmpty(x)).ToArray();

        var namePattern = Fill(spec.MenuItemName, arg, forRegex: true);
        var offPattern = spec.MenuItemOffName;

        // Nothing to look for: the UIA path can still find it by other means.
        if (ids.Length == 0 && string.IsNullOrEmpty(namePattern)) return null;

        return $$"""
        (async function () {
            var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
            var SURFACE = {{Js(SurfaceSelector)}};
            var out = {};
            var style = null;

            var accessibleName = function (el) {
                return el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').trim();
            };

            var findItem = function () {
                var ids = {{JsArray(ids)}};
                for (var i = 0; i < ids.length; i++) {
                    var byId = document.getElementById(ids[i]);
                    if (byId) return byId;
                }
                var pattern = {{Js(namePattern)}};
                if (!pattern) return null;
                var rx = new RegExp(pattern, 'i');
                var all = document.querySelectorAll(
                    'button,[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="checkbox"],[role="radio"]');
                for (var j = 0; j < all.length; j++) {
                    if (rx.test(accessibleName(all[j]))) return all[j];
                }
                return null;
            };

            var isOpen = function () { return !!findItem(); };

            try {
                var stale = document.getElementById({{Js(StyleId)}});
                if (stale) stale.remove();

                style = document.createElement('style');
                style.id = {{Js(StyleId)}};
                style.textContent = SURFACE + '{opacity:0 !important;}';
                document.head.appendChild(style);

                var trigger = document.getElementById({{Js(menu)}});
                if (!trigger) { out.error = 'menu not found'; return JSON.stringify(out); }
                trigger.click();

                var item = null;
                var deadline = Date.now() + 1500;
                while (!item && Date.now() < deadline) {
                    item = findItem();
                    if (!item) await sleep(20);
                }
                if (!item) { out.error = 'item not found in menu'; return JSON.stringify(out); }

                if (item.disabled || item.getAttribute('aria-disabled') === 'true') {
                    out.error = 'not available right now';
                    return JSON.stringify(out);
                }

                var checkedAttr = item.getAttribute('aria-checked');
                if (checkedAttr === 'true' || checkedAttr === 'false') out.checkedBefore = checkedAttr === 'true';

                // Background effects are a radio group rather than a toggle:
                // choosing the same entry again leaves it on, so turning it off
                // means choosing the "none" entry instead.
                var offPattern = {{Js(offPattern)}};
                if (offPattern && out.checkedBefore === true) {
                    var offRx = new RegExp(offPattern, 'i');
                    var all = document.querySelectorAll(
                        'button,[role="menuitem"],[role="menuitemcheckbox"],[role="menuitemradio"],[role="option"],[role="checkbox"],[role="radio"]');
                    for (var k = 0; k < all.length; k++) {
                        if (offRx.test(accessibleName(all[k]))) { item = all[k]; out.usedOff = true; break; }
                    }
                }

                item.click();
                out.ok = true;
                return JSON.stringify(out);
            } catch (e) {
                out.error = String(e && e.message ? e.message : e);
                return JSON.stringify(out);
            } finally {
                // Escape has to go to whatever the menu focused, not to the
                // body: Fluent listens on the focused item, and a keydown
                // dispatched anywhere else leaves the popup open.
                try {
                    var closer = (document.activeElement && document.activeElement !== document.body)
                        ? document.activeElement
                        : document.getElementById({{Js(menu)}});
                    if (closer) {
                        closer.dispatchEvent(new KeyboardEvent('keydown', {
                            key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
                            bubbles: true, cancelable: true
                        }));
                    }
                    var until = Date.now() + 600;
                    while (isOpen() && Date.now() < until) await sleep(20);
                    if (isOpen()) {
                        var t = document.getElementById({{Js(menu)}});
                        if (t) t.click();
                        var until2 = Date.now() + 400;
                        while (isOpen() && Date.now() < until2) await sleep(20);
                    }
                } catch (e2) { /* the stylesheet still comes down below */ }

                if (style) style.remove();
            }
        })()
        """;
    }

    /// <summary>
    /// Substitutes a key's configured argument into a selector, matching the
    /// UI Automation path's placeholder so one config serves both.
    ///
    /// <paramref name="forRegex"/> matters: the same <c>{arg}</c> reaches an
    /// id in one place and a name *pattern* in another, and the UI Automation
    /// path escapes it for the latter. Without the same treatment here, one
    /// config entry would mean a literal on one path and live regex syntax on
    /// the other — a different control could match, and a careless value would
    /// reach <c>new RegExp</c> in the page, where there is no match timeout to
    /// stop it wedging the renderer.
    /// </summary>
    internal static string? Fill(string? template, string? arg, bool forRegex = false)
    {
        if (string.IsNullOrEmpty(template) || !template!.Contains("{arg}", StringComparison.Ordinal))
            return template;

        var value = arg ?? "";
        return template.Replace("{arg}", forRegex ? Regex.Escape(value) : value, StringComparison.Ordinal);
    }

    /// <summary>A JavaScript string literal, or null.</summary>
    internal static string Js(string? value) =>
        value is null ? "null" : "\"" + JsonEncodedText.Encode(value) + "\"";

    internal static string JsArray(IEnumerable<string?> values) =>
        "[" + string.Join(",", values.Where(v => !string.IsNullOrEmpty(v)).Select(Js)) + "]";
}
