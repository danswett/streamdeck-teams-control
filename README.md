# Teams Meeting Controls for Stream Deck

Control Microsoft Teams meetings from an Elgato Stream Deck — mute, camera,
raise hand, reactions, background blur, screen share, chat, roster and leave —
with **live state on every key**.

Teams does not need to be focused, and **no keystrokes are sent**.

> **Windows only.** See [Why not macOS?](#why-not-macos).

---

## Why this plugin exists

Microsoft retired the local Teams third-party API (`ws://localhost:8124`) on
**30 June 2026** under message centre notice **MC1266901**. That API is what
powered Microsoft's own official Teams Stream Deck plugin, MuteMe, Dell's
collaboration keyboards and most other hardware Teams integrations.

Microsoft shipped **no replacement**. The retirement notice says only that
"published Microsoft Graph APIs" are unaffected — but Graph cannot mute your
local Teams client. The guidance every vendor landed on was *"use keyboard
shortcuts"*, which requires the Teams window to be focused and gives no state
feedback at all.

This plugin takes a different route: it drives Teams through **UI Automation**,
the same accessibility layer screen readers use.

| | Old local API | Keyboard shortcuts | This plugin (UIA) |
|---|---|---|---|
| Still works after Jun 2026 | ❌ | ✅ | ✅ |
| Works when Teams is unfocused | ✅ | ❌ | ✅ |
| Sends synthetic keystrokes | ❌ | ✅ | ❌ |
| Reports live mute/camera state | ✅ | ❌ | ✅ |
| Officially supported contract | was | ✅ | ❌ (see [Stability](#stability)) |

---

## Actions

| Action | Live state shown | Notes |
|---|---|---|
| **Mute** | ✅ muted / unmuted | Red `mic_off` glyph when muted |
| **Camera** | ✅ on / off | Red `video_off` glyph when off |
| **Raise Hand** | availability only | Lives in the React flyout |
| **React: Like / Love / Applause / Laugh / Wow** | availability only | Five separate actions, one per reaction |
| **Background Blur** | availability only | Lives in the video options flyout |
| **Share Screen** | ✅ sharing / not | Opens the share tray |
| **Chat** | availability only | Toggles the meeting chat pane |
| **People** | availability only | Toggles the participant roster |
| **Leave** | availability only | Optional press-and-hold confirmation |

Every key dims to grey when you are not in a meeting, so the deck always
reflects reality.

### Artwork

Icons are Microsoft's own **Fluent UI System Icons** and **Fluent Emoji**, both
MIT licensed — the same sets Teams itself renders, so the keys match the app.
They are extracted into `src/glyphs.generated.json` at build time and composed
into SVGs at runtime, which is what allows three states per key when Stream Deck
only supports two.

Regenerate after changing the glyph list:

```bash
node tools/build-glyphs.ts    # extract from node_modules -> src/glyphs.generated.json
node tools/generate-icons.ts  # manifest artwork
node tools/preview-icons.ts   # dist/preview/icon-states.png contact sheet
```

---

## How it works

```
Stream Deck app
      │  (Stream Deck WebSocket protocol)
      ▼
plugin.js ── Node 24, @elgato/streamdeck v2
      │  (JSON lines over stdin/stdout)
      ▼
TeamsBridge.exe ── .NET 10 + FlaUI (UIA3)
      │  (UI Automation / COM)
      ▼
Microsoft Teams (ms-teams.exe, WebView2)
```

Three details make this work reliably:

1. **Chromium builds its accessibility tree lazily.** A UIA walk of the Teams
   window returns *zero* elements until a client asks for it. The sidecar sends
   `WM_GETOBJECT`/`OBJID_CLIENT` to every Teams window first — the same signal a
   screen reader sends. Without this the tree is empty.

2. **Controls are found by `AutomationId`, not by label.** Teams exposes stable,
   locale-independent ids on its meeting toolbar (`microphone-button`,
   `video-button`, `hangup-button`, `share-button`, `reaction-menu-button`,
   `chat-button`, `roster-button`, `callingButtons-showMoreBtn`).

3. **State comes from the accessible name, which is the inverse of state.** The
   label describes the action the button performs, so `Unmute mic` means you are
   *currently muted*. This part **is** localised — see
   [Other languages](#other-languages).

Elements are cached and only re-resolved when they go stale, so the ~400 ms
state poll costs a single property read per control.

---

## Install

### From a release

Download the `.streamDeckPlugin` file from
[Releases](https://github.com/danswett/streamdeck-teams-control/releases) and
double-click it.

### From source

Requires **Node 24+**, **.NET 10 SDK**, and **Stream Deck 7.1+**.

```bash
git clone https://github.com/danswett/streamdeck-teams-control.git
cd streamdeck-teams-control
npm install
npm run build          # builds the sidecar, then the plugin bundle
npx streamdeck link com.dswett.teamscontrol.sdPlugin
```

Then **restart the Stream Deck app** — it only discovers newly added plugins at
start-up; `streamdeck restart` alone is not enough the first time.

---

## Development

```bash
npm run build:sidecar   # dotnet publish -> *.sdPlugin/bin/sidecar/
npm run build:plugin    # rollup -> *.sdPlugin/bin/plugin.js
npm run watch           # rebuild + restart plugin on change
npm run validate        # streamdeck validate
npm run pack            # -> dist/*.streamDeckPlugin
node tools/build-glyphs.ts     # re-extract Fluent artwork
node tools/generate-icons.ts   # regenerate manifest artwork
```

Logs: `com.dswett.teamscontrol.sdPlugin/logs/com.dswett.teamscontrol.0.log`

The sidecar also runs standalone, which is the quickest way to debug UIA:

```powershell
./sidecar/test-bridge.ps1
```

It speaks line-delimited JSON:

```jsonc
>>> {"id":1,"cmd":"status"}
<<< {"type":"state","teamsRunning":true,"inMeeting":true,"windowTitle":"…",
     "states":{"mute":true,"camera":false},"available":{"mute":true,…}}

>>> {"id":2,"cmd":"invoke","target":"mute"}
<<< {"type":"result","id":2,"ok":true}

>>> {"id":3,"cmd":"discover","menu":"reaction-menu-button"}
<<< {"type":"discover","elements":[…]}
```

### Building behind a corporate proxy

If `dotnet restore` cannot reach nuget.org, pass your mirror explicitly:

```powershell
dotnet restore sidecar/TeamsBridge.csproj --source <your-nuget-mirror>
dotnet publish sidecar/TeamsBridge.csproj -c Release --no-restore `
  -o com.dswett.teamscontrol.sdPlugin/bin/sidecar
```

---

## Stability

This plugin depends on Teams' accessibility tree, which is **not a published
API contract**. A Teams redesign can move or rename controls.

That risk is contained rather than hidden:

- All selectors live in
  [`selectors.json`](com.dswett.teamscontrol.sdPlugin/selectors.json) beside the
  manifest. Edit it and restart the plugin — no rebuild needed.
- Every action's property inspector has a **Diagnostics** panel that dumps the
  live Teams UI tree (ids, names, accelerators, ARIA properties, toggle states)
  into the plugin log, so a broken selector can be re-derived in about a minute.
- Invocation falls back `Invoke` → `Toggle` → `LegacyIAccessible.DoDefaultAction`.

If Teams breaks something, please
[open an issue](https://github.com/danswett/streamdeck-teams-control/issues)
with a Diagnostics dump attached.

### Other languages

`AutomationId`s are locale-independent, so **pressing** every control works in
any Teams language out of the box. Only the mute/camera/share **state
indicators** read English labels. To localise, edit the `activePattern` /
`inactivePattern` regexes in `selectors.json`. For example, German:

```jsonc
"mute": {
  "automationId": "microphone-button",
  "activePattern": "^\\s*stumm(schaltung)?\\s*auf",
  "inactivePattern": "^\\s*stumm\\s*schalten"
}
```

PRs adding language packs are very welcome.

### Why not macOS?

The equivalent on macOS is the `AXUIElement` accessibility API, which is a
completely separate implementation and requires the user to grant Accessibility
permission. It is not implemented here yet. The sidecar boundary is deliberately
thin, so a macOS sidecar speaking the same JSON protocol would drop straight in.

---

## Privacy

The plugin talks only to the local Teams window and the local Stream Deck app.
It makes no network calls, collects no telemetry, and reads no message or
meeting content — only the state of the meeting toolbar buttons.

---

## Third-party

- [`@elgato/streamdeck`](https://github.com/elgatosf/streamdeck) — MIT
- [FlaUI](https://github.com/FlaUI/FlaUI) — MIT (UI Automation wrapper)
- [sdpi-components](https://sdpi-components.dev) — MIT (property inspector UI)
- [Fluent UI System Icons](https://github.com/microsoft/fluentui-system-icons) — MIT (control glyphs)
- [Fluent Emoji](https://github.com/microsoft/fluentui-emoji) — MIT (reactions)

Not affiliated with or endorsed by Microsoft or Elgato. No proprietary Microsoft
or Elgato artwork is bundled; all icons come from the MIT-licensed Fluent sets
above.

## License

[MIT](LICENSE)
