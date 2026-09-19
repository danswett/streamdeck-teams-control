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
| **Leave** | availability only | Press opens Teams' confirmation; hold to answer it |

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
| **PPT Live: Grid View** | ✅ open / closed | All slides as thumbnails |
| **PPT Live: High Contrast** | availability only | Your screen only |
| **PPT Live: Pop Out** | availability only | Moves the shared content into its own window |

**Watching (attendee)**

| Action | Live state shown | Notes |
|---|---|---|
| **PPT Attendee: Sync** | ✅ lights up when out of sync | Teams only shows this button once you have browsed away, so the key being lit *is* the "you are viewing privately" signal |
| **PPT Attendee: Take Control** | availability only | ⚠️ Makes you the presenter — see below |

**Driving (presenter)**

| Action | Live state shown | Notes |
|---|---|---|
| **PPT Presenter: Laser / Pen / Highlighter / Eraser / Cursor** | ✅ active tool | Read from UI Automation's selection, so it tracks a tool you picked in Teams too |
| **PPT Presenter: Private Viewing** | ✅ on / off | Lets attendees browse the deck on their own, or stops them. Read from the button's tooltip, which is the only place Teams reports it |
| **PPT Presenter: Presenter View** | ✅ showing / hidden | Shows or hides your notes and thumbnails. Your screen only |
| **PPT Presenter: Present Latest** | availability only | Reloads the deck to pick up saved edits |
| **PPT Presenter: Copy Link** | availability only | Copies a link to the deck |
| **PPT Presenter: Content Only / Layout Cameo** | availability only | Cameo dims until your camera is on |
| **PPT Presenter: Stop Presenting** | availability only | Press opens Teams' confirmation; hold to answer it |

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

The plugin ships **three** profiles for every deck it has a layout for, and can
move the deck between them as a meeting goes:

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
property inspector; the setting is shared by all of them. Only the deck is
handed back at the end — moving between the bundled profiles switches by name,
so the profile Stream Deck returns you to is the one you were on before any of
this started.

##### The decks that have a layout

| deck | `DeviceType` | model | grid | file suffix |
|---|---|---|---|---|
| Stream Deck | 0 | `20GBA9901` | 5 × 3 | none |
| Stream Deck + XL | 13 | `20GBX9901` | 9 × 4, 6 dials | ` (+ XL)` |

Any other deck is left alone entirely. Switching a Mini or a Pedal to a layout
built for a grid it does not have would push most of the keys off the edge of
it, so those decks keep whatever they are showing.

The model names are worth reading twice: `20GAT9901` is the Stream Deck XL and
`20GBX9901` is the Stream Deck + XL, and Stream Deck matches a profile to
hardware on that string alone.

On the 15-key each of the three layouts fills the deck, so a switch redraws all
fifteen keys. Nine columns is wide enough to stop doing that: on the + XL the
**left four columns are the meeting and are identical in all three profiles**,
so mute stays under the same finger whether or not anyone is presenting, and
only the right five columns change. `tests/profiles.test.ts` enforces that the
meeting half really is identical across the three, because it is the kind of
thing that drifts one key at a time.

The extra width also buys the presenter layout a row it could not have before:
all five drawing tools sit in one unbroken row. They are a single-select group —
picking one drops the last — so they should read as one control rather than as
five scattered keys. *Stop presenting* sits alone in the far corner, since it
ends the presentation for everyone.

Stream Deck only lets a plugin switch to profiles it ships itself, so the
layouts are generated by `tools/build-profile.ts` rather than made by hand.
They are written in Stream Deck's version 3.0 profile format; an earlier
attempt shipped 2.0, which Stream Deck offered to install and then silently
ignored. A deck with dials also needs an `Encoder` controller in every page,
even an empty one, which is the same class of quiet failure.

##### Shipping a changed layout

**Stream Deck installs a bundled profile once and never looks at the shipped
copy again.** Change a layout, publish the update, and every existing user
stays on the old one — the switch still succeeds, so nothing is reported
anywhere. It was found only by noticing that a + XL was sitting on a profile
whose `Encoder` controller was `null` long after dials had been added.

It identifies an installed profile by the plugin that installed it and the
**path** it came from, which it writes into the installed copy's
`PreconfiguredName`. A path it has not seen is the only thing it treats as new.

So a profile carries a `revision`, and `tools/build-profile.ts` appends it to
the file name once it is above 1:

```ts
{
    name: "PowerPoint Live (Presenter)",
    device: PLUS_XL,
    revision: 2,          // -> profiles/PowerPoint Live (Presenter) (+ XL) r2
    ...
}
```

**Bump it whenever keys or dials move.** The profile's own name is left alone,
so the revision never reaches the user; only the file changes. Their previous
copy stays behind as an ordinary profile they can delete, because a plugin
cannot remove one.

Forgetting to bump it is the one mistake this scheme invites, and the failure
is silent — the update simply reaches nobody. So each profile records a
`layoutHash`, a fingerprint of the deck it targets and every key and dial on
it, and **the build fails** when that moves and the revision does not:

```
1 profile(s) changed without a revision bump.

  PowerPoint Live (Presenter) (+ XL)
      layout changed but revision is still 1
      bump revision to 2, and set layoutHash: "211ff6d3"
```

`npm run build` runs the profile builder, so this is enforced before anything
is packaged, in CI as well as locally.

**Do not retry a switch to a profile that may still be installing.** An install
holds Stream Deck's profile lock for as long as it takes, and a second ask
during one is answered with `Another operation is already in progress` — which
costs the install that was already running. The retries that exist to rescue a
dropped switch cannot tell the two apart, so they are suppressed for 30s after
the first ask for a path, and only a genuine change of target asks again
immediately. On a two-deck machine that took the refusals per app start from two
to zero.

The fingerprint deliberately ignores the plugin version. Tying the path to the
version would change it on every release, including the many that never touch
a layout, and each change hands every user a new profile and strands whatever
they had customised on the old one. It covers what the user actually sees:
positions, actions and settings.

The manifest's `Profiles` list is written by the same tool, so the declared
path and the file on disk cannot drift apart, and `src/profiles.ts` reads the
path back out of the manifest rather than rebuilding it — two places deciding
which revision shipped is exactly the disagreement this is meant to prevent.

Verified end to end: bumping a revision produced
`Profile profiles/PowerPoint Live (Presenter) (+ XL) r2 installed for
@(1)[4057/198/...]` in Stream Deck's log, and the new layout appeared. Note
that Stream Deck re-reads the manifest when the **application** starts, not
when plugin files change on disk, so a development install needs the app
restarting before a newly declared profile is noticed.

`tools/check-profile.mjs` compares a generated profile against one Stream Deck
wrote itself for the same model, which is the only way to catch a profile that
is almost right:

```bash
node tools/build-profile.ts
node tools/check-profile.mjs "com.bad-duck.teamscontrol.sdPlugin/profiles/Teams Meeting (+ XL).streamDeckProfile"
```

#### Dials

The + XL has six. The PowerPoint Live presenter layout uses the first four and
leaves the last two empty, for whatever you want there:

| dial | shows | turn |
|---|---|---|
| **Current slide** | the slide being presented, bordered red | — |
| **Next slide** | the slide after it | — |
| **Ink thickness** | 1 to 6, Teams' own range | sets it |
| **Ink color** | the tool's palette, wrapping | sets it |

The + XL ships with Elgato's Volume Controller, and its input and output dials
sit naturally in the two spare slots — but a bundled profile is installed once
and never reconciled, so anything placed there is placed permanently. Leaving
them empty is the reversible choice.

The ink dials act on whichever drawing tool is selected rather than owning one,
so picking the pen points both of them at the pen. They go quiet for tools that
have nothing to set: the laser has a color but no thickness, and the cursor and
eraser have neither.

**A dial is not a key with a different shape.** A key press is one discrete
request, and `TeamsAction` already refuses a second while one is in flight. A
dial produces a stream of ticks, and everything behind this plugin is a UI
Automation walk. One press per tick would queue a whole spin and go on driving
the deck long after the user let go, which is the failure `#inFlight` exists to
stop. So turning and pressing are kept apart: ticks accumulate into a local
offset, the touch strip shows where the dial thinks it is straight away, and the
work that makes it true is issued once the dial goes still. Color and thickness
are each a single call, so a whole gesture collapses into one command.

Ink color and thickness turned out to be proper UI Automation patterns rather
than menu items — thickness is a slider carrying `RangeValue` over 1..6, and
every color is a radio button carrying `SelectionItem` — so neither needs a
posted click, and a change measures around 375 ms against the ~4.5 s a flyout
walk costs. `sidecar/probe-ink-flyout.ps1` is what established that, and will
re-establish it when Teams moves something.

Three things about that flyout are worth knowing before touching it:

- **The palette belongs to the tool.** The pen offers Dark yellow, Magenta and
  Dark red where the highlighter offers Pink, Faded green, Faded blue and Faded
  red. `inkColorNames` in `selectors.json` is a union of both and matches
  neither, so the open flyout is always the authority; what was seen is
  published as `ppt.palette.<tool>` for the dial to preview.
- **Expanding a tool is not reliable once.** Teams hides the slide-show toolbar
  when the pointer is away and rebuilds it on demand, and an expand landing
  mid-rebuild does nothing at all. The sidecar asks twice.
- **An open flyout unmounts the whole slide-show subtree.** A deck that is still
  being presented then looks exactly like one that has stopped, so the flyout is
  always closed again and the close is confirmed by watching the subtree return.

#### Slide thumbnails

The two leftmost dials show the deck itself. PowerPoint Live exposes no image of
a slide anywhere in the accessibility tree — only its name — so the picture is
taken off the Teams window with `PrintWindow(PW_RENDERFULLCONTENT)`, which draws
the window on request and is therefore occlusion-proof. `CopyFromScreen` was
tried first and captured whatever happened to be on top.

**This is the one part of the plugin that reads meeting content rather than
controls, so it is off until the user turns it on** — per dial, in the property
inspector. Everything else here reads which controls exist and what state they
are in; starting to read the slides themselves because somebody installed a
plugin for the mute button is not a reasonable default.

It is deliberately narrow: a rectangle inside the Teams window, scaled straight
into the 200 × 100 slot it will occupy, sent to the deck on the desk. Nothing is
uploaded, written to disk, or recorded in any log, and each picture is replaced
by the next.

Three things make that last claim true rather than merely intended:

- **Turning the setting off tears down everything in flight**, not just the
  picture — the pending capture, the fade, the watch loop, and the frame the
  sidecar keeps to fade out of. A capture armed before the box was unticked
  would otherwise still fire up to five seconds later. `#capture` re-checks
  consent itself, so every route into reading a slide fails closed.
- **A slide is never held longer than it is shown.** The sidecar keeps the last
  frame per slot so a change can cross-fade; `forget` drops it when the deck
  stops or the setting goes off, rather than leaving meeting content resident in
  a process that lives for the whole session — where a crash dump would find it.
- **The log cannot quote the channel.** A thumbnail is the largest message the
  sidecar sends and is always split across several reads, so a sidecar that dies
  mid-write leaves half a message in the buffer — and the fields ahead of the
  image are the slide's own name. The unparsable-line warning reports the shape
  and length only, and the buffer is dropped when a sidecar is respawned.

Switching a thumbnail on or off is logged at info, so "was this ever on, and
when" is answerable from an ordinary log.

The two slots come from different places, which is the whole point:

- **Current slide** is the live slide surface — the 16:9 image inside
  `slideshow-app-container`, matched on shape because it carries neither name
  nor id. Being the live render, it shows the slide *as the room sees it*: a
  build that has not fired yet is missing here too, and ink appears as it is
  drawn. It does not need presenter view.
- **Next slide** can only come from the presenter-view filmstrip, so it needs
  presenter view open, and it shows that slide **fully built** — a slide that has
  not been reached has no live render to read. It is the next *slide*, not the
  next build.

A filmstrip item reports its whole rectangle whether or not it has been scrolled
into view, and UI Automation only calls it offscreen once *none* of it is
showing. A half-scrolled slide is therefore offered at a rectangle that runs off
the side of the list and over whatever is beside it — which is how a thumbnail
came back with the chat pane down one edge. So the item is clipped to the list
it sits in, and anything much short of whole is refused rather than cropped:
half a slide is not a useful preview. `SlideClipTests` pins the geometry to the
coordinates that filmstrip actually reported.

Running off the end of the deck is reported as its own signal rather than as a
failure, because the two want opposite handling. A failure should leave the last
picture alone and retry; running out of slides means the picture is now of a
slide the presenter has already left, so it has to go. The same rule applies to
any failed capture once the deck has moved — **a stale thumbnail is only honest
while the slide has not changed.**

The strip clips a caption rather than shrinking it, and says nothing when it
does, so "that slide is scrolled out of view" arrived on the deck cut in half.
Captions now wrap and step down in size to fit. SVG offers no way to measure
text, so the fit is estimated from a constant calibrated by rasterising the real
thing; `tests/icons.test.ts` renders every caption the plugin can produce and
fails if any of it touches the edge of the slot.

##### Watching a slide that is not moving

Ink and builds both change the slide without changing anything Teams reports —
not the slide number, not any control's state. The sidecar emits state **only on
change**, so a thumbnail waiting to be told would sit on a picture without the
ink until the deck moved. Measured: one state message in fifteen seconds while
sitting on a slide.

So the live slot keeps its own clock. A capture costs about 80 ms, so the rate
is tied to whether there is any reason to expect a change:

| when | re-read every |
|---|---|
| a pen, highlighter or eraser is selected | 250 ms |
| something changed in the last 12 s | 700 ms |
| otherwise | 3 s |

None of it runs at all unless a thumbnail has been switched on.

Selecting a marking tool re-arms the timer immediately rather than waiting out
the slow interval. The laser is deliberately excluded: it moves constantly and
leaves nothing behind, so following it would spend the whole budget redrawing a
dot. An unchanged slide encodes byte-identical, so idling costs no traffic to
the deck.

Slide changes cross-fade — six JPEG frames of about 6 KiB, blended in the
sidecar where the bitmaps already are, at 40 ms each. Polled re-reads land
immediately instead: ink should appear under the presenter's hand, not dissolve
into view.

`PrintWindow` has to draw the whole Teams window to hand back any part of it, so
each capture needs a bitmap the size of that window — around 14 MB. Allocating
one per capture put that straight onto the large object heap four times a second
while a pen was in hand. It is now reused between captures and released thirty
seconds after the last one, which measured 17% cheaper per capture and gives the
memory back when nobody is presenting.

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
call out color as incorrect, so the reactions and raise hand appear there as
Fluent *system* glyphs while the keys themselves show the full-color emoji.
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
the automation IDs of two meeting-toolbar buttons rather than any label, and the
drawing tools report which one is in use through UI Automation's selection
rather than a label.

The exception is ink color. While a drawing tool's flyout is open, Teams
unmounts the tool button whose name carries the color, so the color has to be
read from the flyout's swatches — and those carry no automation ID, only a name.
`inkColorNames` lists them, and `arrowOptionPattern` excludes the laser
pointer's arrow options, which share the pen's flyout and always report one of
themselves as selected. Both are in `selectors.json`, and both need translating
for a non-English Teams. Getting them wrong costs only immediacy: the color
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
