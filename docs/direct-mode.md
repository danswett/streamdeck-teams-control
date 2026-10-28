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
| Ink colour | palette visible | nothing visible |
| Jump to a slide | needs grid view open | jumps with nothing on screen |
| Teams minimized | falls back to UIA `Invoke`, which raises the window | works, window stays down |
| Everything else | unchanged | unchanged |

Direct mode is only ever used where it is better. Anything it cannot improve —
or cannot do at all — silently uses the normal path, so **the worst case is the
behaviour you already have**.

---

## What you are agreeing to

Direct mode needs a **local debugging port** on Teams. There is no way to run
script in a page without one.

That port is:

- **loopback only** — nothing on the network can reach it
- **unauthenticated** — any program running under your Windows account can
  attach to it and read or drive your Teams session: your chats, your meetings,
  messages sent as you

It does not grant anything a program running as you could not already reach by
other means, but it makes it convenient and scriptable, and it is a known
technique. It stays open for as long as Teams is running.

**Do not enable this on a managed, shared, or kiosk machine, or on any machine
where you are not the one deciding what runs.**

### What the plugin does and does not do

The plugin **only ever consumes a port you opened yourself**. Nothing in it —
not the installer, not an update, not any key — writes an environment variable,
a registry key, or any other machine setting. If you have not run the command
below yourself, Direct mode is unavailable and the toggle does nothing.

Before using a port, the plugin checks it actually belongs to Teams. That matters:
the setting below applies to **every** WebView2 application you launch, and only
one process can hold a given port. If OneNote started first, the port answers
perfectly well and belongs to OneNote — the plugin treats that as no port at all.

---

## Turning it on

### 1. Open the port

```powershell
[Environment]::SetEnvironmentVariable(
    'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','--remote-debugging-port=9457','User')
```

Pick your own port if you like; avoid **9222**, which is the universal default
and the first one anything scanning would try. Whatever you choose has to match
the plugin's setting.

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

To close the port as well:

```powershell
[Environment]::SetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',$null,'User')
```

then quit and relaunch Teams.

**Removing the variable on its own does nothing to a running Teams.** The flag
was read at launch, so the port stays open until Teams restarts.

### It stays on until you turn it off

Every later Teams launch reopens the port, including after a Teams update. There
is no expiry. If you only want it for presentations, treat it as something you
switch on before one and off afterwards — restarting Teams costs nothing when you
are not in a meeting.

---

## Troubleshooting

**`directmode` reports "no debugging port on 9457".**
Teams was not restarted after the variable was set, or it is on a different port.
Check the variable with `[Environment]::GetEnvironmentVariable('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS','User')`.

**It reports "port is open but belongs to another application".**
Another WebView2 application claimed the port first. Quit it and restart Teams,
or pick a different port for both.

**It reports "connected, but no meeting window".**
The port is Teams' and the plugin can reach it, but no meeting window is open
yet. This resolves itself when you join one.

**The setting will not take at all.**
The variable is written to your user environment, but the process that launches
Teams may have been started before that and still hold the old environment. Sign
out and back in.

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

Direct mode never activates the Teams window, so unlike the UI Automation path it
needs no focus guard at all.
