# Teams Meeting Controls for Stream Deck

[![build](https://github.com/danswett/streamdeck-teams-control/actions/workflows/build.yml/badge.svg)](https://github.com/danswett/streamdeck-teams-control/actions/workflows/build.yml)

Control Microsoft Teams meetings from an Elgato Stream Deck — mute, camera,
raise hand, reactions, background blur, screen share, chat, roster and leave —
with **live state on every key**.

Teams does not need to be focused, it is never pulled to the front, and **no
keystrokes are sent**.

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
| **Mute** | ✅ muted / unmuted | Slashed `mic_off` glyph when muted |
| **Camera** | ✅ on / off | Slashed `video_off` glyph when off |
| **Raise Hand** | availability only | Lifts on press. Lives in the React flyout |
| **React: Like / Love / Applause / Laugh / Wow** | availability only | Five separate actions; each pops on press |
| **Background Blur** | availability only | Lives in the video options flyout |
| **Share Screen** | ✅ sharing / not | Opens the share tray |
| **Chat** | availability only | Toggles the meeting chat pane |
| **People** | availability only | Toggles the participant roster |
| **Leave** | availability only | Optional press-and-hold confirmation |

Every key dims to grey when you are not in a meeting, so the deck always
reflects reality.

### PowerPoint Live

A second set of keys appears when someone shares a deck through **PowerPoint
Live**. Teams renders that as an embedded slide-show app rather than as part of
the meeting toolbar, so these controls simply do not exist unless a deck is up —
which is exactly what makes the keys dim on their own, with no special-casing.

Teams gives you a different toolbar depending on whether you are watching or
driving, and the plugin follows suit: each key declares the role it needs and
reports itself unavailable in the other one.

**Either role**

| Action | Live state shown | Notes |
|---|---|---|
| **PPT Live: Slide Counter** | ✅ `3/19` | Not pressable. Turns gold while you are the presenter |
| **PPT Live: Previous / Next Slide** | availability only | Dims at the ends of the deck |
| **PPT Live: Grid View** | availability only | All slides as thumbnails |
| **PPT Live: Zoom In / Out** | availability only | ⚠️ "only for me" as an attendee, **for everyone** while presenting |
| **PPT Live: High Contrast** | availability only | Your screen only |
| **PPT Live: Pop Out** | availability only | Moves the shared content into its own window |

**Watching (attendee)**

| Action | Live state shown | Notes |
|---|---|---|
| **PPT Live: Sync to Presenter** | ✅ lights up when out of sync | Teams only shows this button once you have browsed away, so the key being lit *is* the "you are viewing privately" signal |
| **PPT Live: Take Control** | availability only | ⚠️ Makes you the presenter — see below |

**Driving (presenter)**

| Action | Live state shown | Notes |
|---|---|---|
| **PPT Live: Laser / Pen / Highlighter / Eraser / Cursor** | ✅ active tool | Read from UI Automation's selection, so it tracks a tool you picked in Teams too |
| **PPT Live: Private View** | availability only | Lets attendees browse the deck on their own, or stops them |
| **PPT Live: Presenter View** | availability only | Shows or hides your notes and thumbnails. Your screen only |
| **PPT Live: Present Latest** | availability only | Reloads the deck to pick up saved edits |
| **PPT Live: Copy Link** | availability only | Copies a link to the deck |
| **PPT Live: Layout Content Only / Cameo** | availability only | Cameo dims until your camera is on |
| **PPT Live: Stop Presenting** | availability only | Optional press-and-hold confirmation |

#### Taking control changes your role

**Take control** is the one key that changes which set you get. Press it as an
attendee and Teams makes you the presenter: that key retires, *Sync to
presenter* goes with it, and the drawing tools,
*Private view* and *Stop presenting* light up in their place.

That switch lands a moment after the press returns, so the sidecar takes a
second snapshot ~1.2 s later. Without it a single immediate re-read would report
the old role and leave every key a role behind.

Taking control turns an attendee into the presenter, and the bundled profiles
follow that: the deck swaps to the presenter layout on the same press that
re-lights the keys.

#### Switching profile automatically

The plugin ships **three** profiles and can move the deck between them as a
meeting goes:

| when | profile |
|---|---|
| You join a meeting | **Teams Meeting** — mute, camera, reactions, chat, leave |
| A deck starts, and you are watching | **PowerPoint Live (Attendee)** — navigation, sync, take control |
| A deck starts, and you are presenting | **PowerPoint Live (Presenter)** — navigation, drawing tools, presenter view, stop presenting |
| The deck stops | back to **Teams Meeting** |
| You leave the meeting | back to whichever profile you were on before |

Each PowerPoint Live layout keeps mute, camera and leave within reach, so being
moved onto a presentation layout never costs you the meeting basics.

It is **off by default** — taking over your deck layout unasked is delightful
once and infuriating thereafter. Turn it on in any PowerPoint Live key's
property inspector; the setting is shared by all of them. It applies to 15-key
Stream Decks, and only the deck is handed back at the end — moving between the
bundled profiles switches by name, so the profile Stream Deck returns you to is
the one you were on before any of this started.

Stream Deck only lets a plugin switch to profiles it ships itself, so the
layouts are generated by `tools/build-profile.ts` rather than made by hand.
They are written in Stream Deck's version 3.0 profile format; an earlier
attempt shipped 2.0, which Stream Deck offered to install and then silently
ignored.

### Artwork

Icons are Microsoft's own **Fluent UI System Icons** and **Fluent Emoji**, both
MIT licensed — the same sets Teams itself renders, so the keys match the app.
They are extracted into `src/glyphs.generated.json` at build time and composed
into SVGs at runtime, which is what allows three states per key when Stream Deck
only supports two.

The reaction and raise-hand keys animate when pressed. Stream Deck has no
animated-image support — `setImage` rejects GIF, and the manifest's GIF support
cannot be driven per press — so frames are pushed individually for about 620 ms,
and only while a key is being pressed.

**The action list and the keys use different artwork.** Elgato's guidelines
require action-list icons to be a monochrome white stroke on transparent, and
call out colour as incorrect, so the reactions and raise hand appear there as
Fluent *system* glyphs while the keys themselves show the full-colour emoji.
`tests/marketplace.test.ts` enforces that, because the artwork is generated and
the rule is otherwise only noticed at submission time.

Regenerate after changing the glyph list:

```bash
node tools/build-glyphs.ts     # extract from node_modules -> src/glyphs.generated.json
node tools/generate-icons.ts   # manifest artwork
node tools/preview-icons.ts    # dist/preview/icon-states.png contact sheet
node tools/preview-animation.ts react-like   # filmstrip of the press animation
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

Four details make this work reliably:

1. **Chromium builds its accessibility tree lazily.** A UIA walk of the Teams
   window returns *zero* elements until a client asks for it. The sidecar sends
   `WM_GETOBJECT`/`OBJID_CLIENT` to every Teams window first — the same signal a
   screen reader sends. Without this the tree is empty.

2. **Controls are found by `AutomationId`, not by label.** Teams exposes stable,
   locale-independent ids on its meeting toolbar (`microphone-button`,
   `video-button`, `hangup-button`, `share-button`, `reaction-menu-button`,
   `chat-button`, `roster-button`, `callingButtons-showMoreBtn`), and inside the
   React flyout (`raisehands-button`, `like-button`, `heart-button`,
   `applause-button`, `laugh-button`, `surprised-button`).

3. **Controls are pressed by posting mouse messages, not by UIA `Invoke`.** UIA's
   Invoke works, but Chromium *activates its window* when it runs, so every key
   press yanked Teams to the front. A `WM_LBUTTONDOWN`/`UP` posted straight to
   the child `Chrome_RenderWidgetHostHWND` goes into that window's message queue
   instead of through the window manager: it needs no focus, raises no window and
   moves no cursor. Measured with 10 ms sampling, the foreground window never
   changes. UIA `Invoke` remains the fallback for cases with no on-screen bounds,
   such as a minimised window.

   This is also why the flyouts are no longer disruptive — the popup opens
   *behind* whatever you are working in, so you never see it.

4. **State comes from the accessible name, which is the inverse of state.** The
   label describes the action the button performs, so `Unmute mic` means you are
   *currently muted*. This part **is** localised — see
   [Other languages](#other-languages).

Elements are cached and only re-resolved when they go stale, so a state read
costs a single property read per control.

5. **State is event-driven, not polled.** The sidecar subscribes to UI
   Automation property-change events on the controls it has resolved, so a
   change made in Teams itself reaches the keys without waiting for a tick.
   Measured with a second sidecar performing the toggle so the watcher could
   not shortcut it, an externally-made change showed up in **315 ms on average,
   364 ms worst** over four rounds. The subscriptions themselves are close to
   free: an A/B measurement put them at 0.00% CPU and +0.2 MB.

   Polling remains as a backstop — every 3 s in a meeting, 15 s otherwise —
   because UIA events are not guaranteed to be delivered. It catches anything
   the event path drops rather than driving the normal case.

### Cost

Measured on the machine this was built on, in a live meeting:

| | CPU | working set | private |
|---|---|---|---|
| sidecar | 1.0% | 22.5 MB | 10.5 MB |
| plugin (node) | 0.0% | 59.6 MB | 28.9 MB |

Idle, outside a meeting, the sidecar settles at ~0.6% CPU and ~12 MB. Discovery
is the expensive operation — a *failed* UIA search walks an entire window
subtree — so windows that turn out not to be meetings are cached as such, and a
meeting window is re-resolved only when the cached element goes stale.

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
npx streamdeck link com.bad-duck.teamscontrol.sdPlugin
```

Then **restart the Stream Deck app** — it only discovers newly added plugins at
start-up; `streamdeck restart` alone is not enough the first time.

Copying files in this way deliberately skips Stream Deck's own installer, which
is fast but has one consequence worth knowing: **bundled profiles are only
registered when Stream Deck installs the packaged plugin itself.** A file copy
leaves `switchToProfile` calls silently ignored, because the profile was never
offered for installation. To exercise the profiles, open the packed
`dist/*.streamDeckPlugin` so Stream Deck runs its install flow, then accept the
"contains a/some preconfigured profile(s)" prompt. Each profile is installed the
first time the plugin asks to switch to it, so expect one prompt per profile.

---

## Development

```bash
npm run build:sidecar   # dotnet publish -> *.sdPlugin/bin/sidecar/
npm run build:plugin    # rollup -> *.sdPlugin/bin/plugin.js
npm run watch           # rebuild + restart plugin on change
npm run validate        # streamdeck validate
npm run test            # unit tests, TypeScript and C#
npm run pack            # -> dist/*.streamDeckPlugin
node tools/build-glyphs.ts     # re-extract Fluent artwork
node tools/generate-icons.ts   # regenerate manifest artwork
node tools/build-profile.ts    # rebuild the bundled PowerPoint Live profile
```

### Testing

Most of what this plugin does can only be proven against a running meeting, so
the suite is in two halves.

**Unit tests** run anywhere, and are what CI enforces:

| | covers |
|---|---|
| `tests/protocol.test.ts` | stdout framing (split and merged chunks, CRLF) and state mapping |
| `tests/icons.test.ts` | SVG validity, state artwork, the press animation returning to rest |
| `tests/marketplace.test.ts` | Elgato artwork and manifest guidelines |
| `sidecar/tests/` | selector parsing and overlay, regex validation, snapshot fingerprinting, PowerPoint Live role gating |

**Integration scripts** under `sidecar/` need Teams, and most need a meeting:

| script | meeting? | checks |
|---|---|---|
| `test-recovery.ps1` | no | malformed input, unknown commands, shutdown, respawn after a kill |
| `test-dpi.ps1` | no | the sidecar really is per-monitor DPI aware |
| `test-soak.ps1` | either | handle and memory drift over a long run |
| `test-flyouts.ps1` | yes | hand, reactions and blur, twice each, to catch the swallowed click |
| `test-reactions.ps1` | yes | all five reactions |
| `test-focus-strict.ps1` | yes | foreground never changes, sampled every 10 ms |
| `test-dimming.ps1` | yes | keys stay lit while a flyout is open |
| `test-state-latency-external.ps1` | yes | latency for a change the plugin did not make |
| `measure-perf.ps1` | either | CPU and memory of the installed plugin |

Note that `test-state-latency-external.ps1` defaults to toggling mute; pass
`-Target camera` when audio is unavailable, such as in a remote session.

Logs: `com.bad-duck.teamscontrol.sdPlugin/logs/com.bad-duck.teamscontrol.0.log`

> **Manifest changes need a full Stream Deck app restart.** `streamdeck restart`
> recycles the plugin *process*, but Stream Deck caches `manifest.json` and only
> re-reads it when the app starts. If you add, rename or remove an action and it
> does not show up in the actions list, quit and reopen Stream Deck.

> **Rebuilding the sidecar while the plugin runs** fails with a file lock:
> Stream Deck immediately relaunches a plugin that exits, which respawns the
> sidecar and re-locks the binary. `sidecar/rebuild.ps1` handles this by
> publishing to a staging folder, renaming the running image (Windows allows
> this) and dropping the new one in its place.

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

Useful flags when debugging:

| flag | effect |
|---|---|
| `--selectors <path>` | load a selector override file |
| `--poll <ms>` | override the in-meeting backstop interval |
| `--no-events` | disable UIA subscriptions and poll only |
| `--debug-events` | log every subscription and event to stderr |
| `--no-focus-guard` | skip restoring foreground after the UIA fallback |

`--no-events` is the quickest way to tell whether a state problem is in the
event path or underneath it: if behaviour is identical with it, events were
not the cause.

### Building behind a corporate proxy

If `dotnet restore` cannot reach nuget.org, pass your mirror explicitly:

```powershell
dotnet restore sidecar/TeamsBridge.csproj --source <your-nuget-mirror>
dotnet publish sidecar/TeamsBridge.csproj -c Release --no-restore `
  -o com.bad-duck.teamscontrol.sdPlugin/bin/sidecar
```

The committed `NuGet.config` deliberately points at nuget.org so a clean
checkout builds for everyone else; override it per command rather than editing
it.

### Releasing

Tagging `v*` builds, tests, packages and attaches the plugin to the GitHub
release. The workflow refuses to publish when the tag and the manifest version
disagree.

```bash
# bump "Version" in com.bad-duck.teamscontrol.sdPlugin/manifest.json first
git tag -a v1.4.0 -m "v1.4.0" && git push origin v1.4.0
```

That covers GitHub. **Marketplace is a separate, manual step** — Elgato has no
public API or CLI for submission, so a new version is uploaded by hand in Maker
Console and then waits on review. The full procedure is in
[`marketplace/README.md`](marketplace/README.md#publishing-a-new-version).

Marketplace submission goes through Elgato's
[Maker Console](https://docs.elgato.com/maker-console/submitting-products/) and
takes the same `.streamDeckPlugin` file. **No code signing certificate is
required** — Elgato applies its own DRM to uploaded plugins — so the unsigned
binary is not a blocker, though Windows SmartScreen may still warn on a
sideloaded build.

Everything else the submission needs — app icon, thumbnail, three gallery
images, the listing copy and a pre-flight checklist — lives in
[`marketplace/`](marketplace/README.md). Regenerate the images with
`npm run marketplace`; they are rendered from the same glyph set the keys use,
so the listing cannot drift from what ships.

---

## Stability

This plugin depends on Teams' accessibility tree, which is **not a published
API contract**. A Teams redesign can move or rename controls.

That risk is contained rather than hidden:

- All selectors live in
  [`selectors.json`](com.bad-duck.teamscontrol.sdPlugin/selectors.json) beside the
  manifest. Edit it and restart the plugin — no rebuild needed. Patterns are
  compiled when the file is read, so a mistake is named and skipped at startup
  and the working default is kept, rather than failing on every state read
  afterwards. Matching is also bounded, so a pattern that backtracks badly
  cannot wedge the sidecar.
- The sidecar's stdio protocol carries a `discover` command that dumps the live
  Teams UI tree (ids, names, accelerators, ARIA properties, toggle states), so a
  broken selector can be re-derived in about a minute. Run
  `bin/sidecar/TeamsBridge.exe` from a terminal and send it the line shown in
  [the protocol section](#protocol). It is deliberately not wired to a button:
  a dump lists every control in the meeting window, which is not something to
  put one click away in a shipping UI.
- Invocation falls back `Invoke` → `Toggle` → `LegacyIAccessible.DoDefaultAction`.

Two Teams behaviours are handled explicitly rather than left to chance:

- **A meeting can own two windows.** Alongside the full meeting window Teams may
  keep a *Meeting compact view*, which carries a reduced toolbar with no chat or
  background-effects controls. Both look like meetings, so the sidecar prefers
  whichever window exposes the full toolbar and only settles for the compact one
  if that is all there is — otherwise chat and blur would appear unavailable.
- **A control can exist but be disabled.** With no audio device — a remote
  session, say — `microphone-button` is present but disabled. Mute then reports
  as unavailable and its key dims, instead of appearing to work and doing
  nothing.
- **Dismissing a flyout needs care about where you click.** The meeting toolbar
  is centred along the *top* of the window and the participant tile fills the
  middle, so the two most obvious "empty" spots are the two worst: one re-opens
  the reaction flyout and the other opens a profile card over the meeting. The
  dismissal click is placed in the quiet corners of the content area and checked
  against the controls actually on screen first.
- **A flyout hides the whole toolbar.** A running sidecar rides that out using
  its cached window, but one that *starts* while a flyout is open has no cache,
  so it also looks for the flyout's own buttons before concluding there is no
  meeting.
- **PowerPoint Live publishes your role as a CSS class, not a property.** The
  slide-show root carries `slideshow-app-presenter-role` or
  `slideshow-app-attendee-role`, so the role is matched out of the class name.
  That is a little unusual, but it is locale-independent — unlike the toolbar,
  which is literally titled "Presenter tools" or "Audience tools".
- **Some menu entries are swapped, not checked.** "Hide presenter view" is
  replaced outright by "Show presenter view" under a different id, so a key that
  knew only one id would work once and then fail. Those controls carry both ids.
- **One press can change which keys exist.** Taking control of a deck turns an
  attendee into the presenter, retiring half the PowerPoint Live keys and
  raising the other half. That lands after the press returns, so a second
  snapshot is taken ~1.2 s later.

If Teams breaks something, please
[open an issue](https://github.com/danswett/streamdeck-teams-control/issues)
with a `discover` dump attached.

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

The PowerPoint Live keys need very little translating. Role detection matches
the automation IDs of two meeting-toolbar buttons rather than any label, the
drawing tools report which one is in use through UI Automation's selection
rather than a label, and the slide-translation languages are keyed by endonym
(`Deutsch`, `日本語`, `Original`), which is what Teams uses regardless of its
own display language.

The exception is ink colour. While a drawing tool's flyout is open, Teams
unmounts the tool button whose name carries the colour, so the colour has to be
read from the flyout's swatches — and those carry no automation ID, only a name.
`inkColorNames` lists them, and `arrowOptionPattern` excludes the laser
pointer's arrow options, which share the pen's flyout and always report one of
themselves as selected. Both are in `selectors.json`, and both need translating
for a non-English Teams. Getting them wrong costs only immediacy: the colour
still updates, just when the flyout closes rather than on the click.

### Why not macOS?

The equivalent on macOS is the `AXUIElement` accessibility API, which is a
completely separate implementation and requires the user to grant Accessibility
permission. It is not implemented here yet. The sidecar boundary is deliberately
thin, so a macOS sidecar speaking the same JSON protocol would drop straight in.

---

## Privacy

The plugin talks only to the local Teams window and the local Stream Deck app.
It makes no network calls, collects no telemetry, and reads no message or
meeting content — only the state of the meeting toolbar buttons. The sidecar
opens no TCP or UDP port; it speaks to the plugin over its own stdin and stdout.

The meeting window title is read to tell a meeting window from a chat window,
but it is never written to the log.

**Before attaching a `discover` dump to an issue**, be aware it lists every
interactive control in the meeting window — its automation id, accessible name
and enabled state. Teams labels those by action ("Mute", "Open chat"), so a
dump from an ordinary meeting contains no names, but a pane listing people can
put participant names in a control label. Read it before posting it.

That is also why the dump is not exposed as a button anywhere in the plugin:
it has to be asked for deliberately, by running the sidecar yourself.

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
