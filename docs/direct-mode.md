# Direct mode

**Direct mode is off by default, and this plugin will never turn it on for you.**
Read [What you are agreeing to](#what-you-are-agreeing-to) before you enable it.

---

## What it is

Normally the plugin drives Teams through UI Automation — the same accessibility
layer a screen reader uses — and presses controls by posting mouse messages into
Teams' render widget. That works without focus and without moving your cursor,
but it has one visible cost: **a control that lives inside a flyout needs that
flyout open on screen**. Reactions, background blur, the PowerPoint Live view and
share menus, and the ink colour palette are all like this.

That is not a shortcut anyone chose. Chromium only materialises menu items into
the accessibility tree once the popup is genuinely open, so there is nothing to
find until it is showing.

Direct mode drives the same controls by running JavaScript inside Teams' own
page instead. From in there, a menu can be opened, used and closed while it is
styled invisible, so nothing appears on screen at all.

### What changes

| | Normal | Direct mode |
|---|---|---|
| Reactions, blur, PPT Live menus | flyout visible, up to a few seconds | nothing visible, ~240 ms |
| Camera selection/swap and preferences | camera flyout and, for mirror, video-settings pane | hidden navigation with confirmed single writes |
| Ink colour and thickness dials | palette visible | hidden palette with confirmed single writes |
| Grid View, including pressing the Current Slide dial | UI Automation opens/closes the grid | confirmed Direct open/close; the requested grid remains visible |
| Meeting timer pause/resume/reset | UI Automation invokes the controls | scoped Direct control with confirmed state |
| Stop Presenting hold-to-confirm | UI Automation invokes the dialog button | one Direct confirmation after the existing hold |
| Jump to a slide | needs grid view open | jumps with nothing on screen |
| Teams minimized | falls back to UIA `Invoke`, which raises the window | works, window stays down |
| Everything else | unchanged | unchanged |

Unsupported controls and an unavailable Direct connection use the normal path.
Camera operations fall back only when it is confirmed safe to do so. An
uncertain device or preference write is reported as an error rather than
repeated: retrying a swap could silently undo the first switch. A later
preference or cleanup failure can occur after the camera or earlier preferences
have already changed.

Ink adjustments use the normal path only when Direct is unavailable before an
operation starts. Once a Direct ink operation starts, a timeout, unconfirmed
write, or cleanup failure is reported rather than retried through UI Automation:
repeating a relative colour step could apply it twice. A palette the user
already opened is not hidden and is left open.

Blur, grid view, timer controls, and the final Stop Presenting confirmation also
report failures rather than retrying through UI Automation once their guarded
Direct operation starts. A disconnected debugger does not cancel JavaScript
already running. Check Teams before manually retrying an unconfirmed operation.
The grid and the normal confirmation dialog are intentional UI, not temporary
flyouts to hide. Stop Presenting still requires the existing hold; an ordinary
press does not silently accept the dialog.

---

## What you are agreeing to

Direct mode needs a **local debugging port** on Teams. There is no way to run
script in a page without one.

That port is:

- **loopback only** — nothing on the network can reach it
- **unauthenticated** — local programs that can reach it can attach and read or
  drive your Teams session: your chats, your meetings, messages sent as you

It makes that access convenient and scriptable, and it stays open for as long
as Teams is running.

**Do not enable this on a managed, shared, or kiosk machine, or on any machine
where you are not the one deciding what runs.**

This is not a supported Teams integration API. Microsoft documents WebView2
debugging flags for development and diagnostics, and
[warns against relying on them in production](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags):
they can change or disappear. Teams or WebView2 updates can therefore stop
Direct mode working.

### What the plugin does and does not do

The plugin **only ever consumes a port you opened yourself**. Nothing in it —
not the installer, not an update, not any key — writes an environment variable,
a registry key, or any other machine setting. If you have not run the command
below yourself, enabling the toggle leaves it on **WAITING** and controls use
the normal UI Automation path.

Before using a port, the plugin checks it actually belongs to Teams. Only one
process can hold a given port, and an older, global WebView2 debugging setting
could let another application claim it first. A port belonging to OneNote, for
example, is not a usable Teams connection.

---

## Turning it on

### 1. Configure a Teams-only port

Prefer Microsoft's
[per-application registry override](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-visual-studio-code#using-a-registry-value)
over a user-wide `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` environment variable.
The value below applies to `ms-teams.exe` only, for the current Windows user.
It does not configure other WebView2 applications or require a special Teams
shortcut.

Check for an existing value first. Do not overwrite organization-managed
settings or discard other browser arguments:

```powershell
$path = 'Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
$application = 'ms-teams.exe'
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($path)
try {
    if ($key.GetValueNames() -contains $application) {
        throw 'A Teams override already exists. Review it and preserve unrelated arguments.'
    }
    $key.SetValue($application,
        '--remote-debugging-address=127.0.0.1 --remote-debugging-port=9457',
        [Microsoft.Win32.RegistryValueKind]::String)
} finally {
    $key.Dispose()
}
```

Pick your own port if you like; avoid **9222**, which is the universal default
and the first one anything scanning would try. Whatever you choose has to match
the plugin's setting.

If you previously configured a global debugging environment variable or a
wildcard registry value, remove only its debugging switches, preserving any
unrelated arguments. Otherwise other WebView2 applications can still open
debugging ports.

### 2. Fully quit Teams

Closing the window is not enough — Teams keeps running in the notification area,
and the setting is only read when it launches.

**Notification area → right-click Teams → Quit**, then confirm nothing is left:

```powershell
Get-Process ms-teams -ErrorAction SilentlyContinue    # should print nothing
```

### 3. Start Teams and check

```powershell
(Invoke-RestMethod 'http://127.0.0.1:9457/json/version').Browser
```

A version string such as `Edg/153.0.4234.48` means the port is open. An error
means the setting did not reach Teams — see [Troubleshooting](#troubleshooting).

### 4. Enable it in the plugin

Drag **Direct Mode** from the plugin's action list onto a key. In that key's
settings, set **Debugging port** to the port you opened for Teams (9457 by
default), then click **Save shared port**. The settings pane also links to this
guide.

Press the key, or click **Enable Direct mode** in its settings pane.

The key shows:

| Label | Meaning |
|---|---|
| **OFF** | The plugin will not use Direct mode |
| **WAITING** | Enabled, but the Teams Direct connection is not usable |
| **ACTIVE** | Enabled and connected to a usable Teams meeting target |

The settings pane shows the reason for an unavailable connection. Status
refreshes periodically while enabled; **Refresh status** checks immediately.
When Direct mode is unavailable, controls use the normal UI Automation path.

Enabled state and port are **plugin-wide**: every Direct Mode key stays in sync.
Stream Deck saves them in the plugin's global settings and restores them after
restart or update. Direct mode is off until you enable it. Separately named
preview plugins have their own settings; enabling a preview does not enable
production.

The toggle only controls whether the plugin uses an already-open debugging
port. It never opens or closes that port. The sidecar writes a log line when
the path goes live in a meeting:

```
direct mode active on port 9457 (deck shared: true)
```

---

## Turning it off

Press an enabled **Direct Mode** key, or click **Disable Direct mode** in its
settings pane. Subsequent controls use UI Automation without a Stream Deck
restart. This **leaves the debugging port open**.

To close the port as well, remove the Teams-only value created above:

```powershell
$key = 'HKCU:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
Remove-ItemProperty -LiteralPath $key -Name 'ms-teams.exe'
```

Then quit and relaunch Teams. If you have since added unrelated arguments to
that value, preserve them and remove only the two remote-debugging switches
instead. Do not remove the whole registry key or other applications' values.

**Removing the value on its own does nothing to a running Teams.** The flag was
read at launch, so the port stays open until Teams restarts.

### It stays on until you turn it off

The Teams-specific value has no expiry and is read on later launches, including
normal startup and relaunches after updates while Teams still honors the flags.
This is separate from the plugin's saved enabled state. If you only want Direct
mode for presentations, remove the override and restart Teams afterwards.

---

## Troubleshooting

**`directmode` reports "no debugging port on 9457".**
Teams was not fully restarted after the override was set, or it is on a
different port.
Check the `ms-teams.exe` value under
`HKCU:\Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments`
and confirm it matches the plugin's saved port.

**It reports "port is open but belongs to another application".**
Another application claimed the port first. Check for an older global debugging
environment variable or wildcard registry override, or choose an unused port
for both Teams and the plugin.

**It reports "connected, but no meeting window".**
The port is Teams' and the plugin can reach it, but no meeting window is open
yet. This resolves itself when you join one.

**The setting will not take at all.**
The registry override is read when a new WebView2 environment starts. Fully
quit Teams from the notification area, check the exact `ms-teams.exe` value,
and launch it again. Device policy can restrict these settings; do not bypass
organization policy to enable debugging.

**Something looks wrong and I want to rule this out.**
Disable the **Direct Mode** toggle. Subsequent controls use the normal path.
If the problem persists, Direct mode was not the cause.

**The key stays on WAITING.**
Read the status in the key's settings pane. Confirm its saved port matches
Teams, then click **Refresh status**. The toggle can be enabled before Teams
starts or before joining a meeting; it becomes active when a usable meeting
target is available. If settings cannot be saved or applied, the pane shows
the error and a key press shows an alert.

---

## How it works

Two documents make up a Teams meeting window, and they are separate origins with
separate debugging targets:

```
TeamsWebView
└── https://teams.microsoft.com/v2/            ← toolbar, reactions, mute
    └── https://…officeapps.live.com/slideshow.aspx   ← PowerPoint Live
```

A control declared with `"surface": "slideShow"` is driven in the second; every
other control in the first.

**Menus** are driven by injecting a stylesheet that sets the popup's opacity to
zero, clicking the trigger, waiting for the item, clicking it, and closing with
`Escape`. Opacity rather than `display: none` because the element still has to
lay out and still has to receive the click — it simply does not paint. The
stylesheet is removed in a `finally`, and any stylesheet a previous press left
behind is swept up before the next one starts.

**Jumping to a slide** posts PowerPoint Live's own navigation message into the
slide-show frame, which is what Teams itself does — the on-screen buttons are
only one way of raising it. That is why a jump needs no grid view: the UI
Automation path has to invoke a filmstrip tile, and a tile only exists while the
filmstrip is on screen.

**Ink dials** read the selected tool's own palette or range input in the
slide-show document. Colour uses a single swatch click; thickness uses the
native input-value setter and one input event. Neither is considered successful
until the tool's application-updated name confirms the requested value. Popup
ownership, temporary styles, and an operation lock bound the navigation and
prevent uncertain relative writes from being repeated.

The ink palette is a shared React portal without an `aria-controls` owner link.
Ownership is checked through read-only logical-tree metadata, bounded by the
neighboring slide-toolbar controls; no private event handlers are called.
Missing or ambiguous ownership is reported before navigation rather than hiding
an unrelated popup.

**Controls without stable IDs** use a two-phase operation. The page returns a
bounded list of control names from the intended scope. Configured patterns are
matched in C# with the existing regex timeout, never compiled inside Teams.
Before the single write, the page rechecks the chosen element, its scope and
state. Blur uses the camera popup's logical ownership and hides only a popup
opened by the plugin; a user-open popup stays visible and open.

Grid view confirms that its overlay appeared or disappeared and, when closing,
that the slide toolbar returned. Timer toggles confirm Pause/Resume changed;
reset requires an increased remaining-time reading, not just a successful click.
An unchanged or ambiguous reading is reported as unconfirmed rather than
repeated. Cancel timer is never a substitute for pause or reset. Presentation
confirmation requires the scoped dialog and presenter control to disappear.
Dialog discovery may wait for rendering, but an attempted confirmation is never
automatically retried.

Direct mode never activates the Teams window, so unlike the UI Automation path it
needs no focus guard at all.
