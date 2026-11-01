# TeamsBridge (macOS)

Swift accessibility sidecar. Same JSON-lines protocol as `sidecar/` (.NET).

See [#4](https://github.com/danswett/streamdeck-teams-control/issues/4) for the
probe results this is based on.

```bash
npm run build:sidecar:macos   # build the signed .app bundle
npm run test:sidecar:macos    # unit tests (also run by CI on every push)
```

`TeamsBridgeCore` holds everything that can be reasoned about without a Mac in
a live meeting — the selector map, the markers that decide whether a window is
a meeting, the rule for reaching a control — so it can be tested. The
`TeamsBridge` executable is only the stdin/stdout loop.

Writes `com.bad-duck.teamscontrol.sdPlugin/bin/sidecar/TeamsBridge`. CI copies that Mach-O next to `TeamsBridge.exe` and packs on macOS so the executable bit survives.

Accessibility permission is required (typically granted to Stream Deck.app, the
responsible process when it spawns this helper). Do not sandbox the binary.

## Flyouts

Teams removes the **whole meeting toolbar** from the accessibility tree while a
popup is open, leaving only the popup's own buttons. Two things follow, and the
sidecar would be broken without either:

- A meeting is recognised by any of `meetingMarkerAutomationIds`, not by the
  mic button alone. Probing for one toolbar button reads as "meeting ended"
  every time a menu opens. The markers that only exist inside a flyout count
  for a minute after the toolbar was last seen for certain — a popup can only
  be covering a toolbar that was there a moment ago, and a press clears an open
  flyout and looks again however long it has been up.
- Pressing a flyout item through accessibility fires its handler but not the
  outside click that normally dismisses the popup, so the sidecar closes it
  itself after answering. Leaving it open wedges every later press, reactions
  and mute alike — the symptom reported twice on
  [#7](https://github.com/danswett/streamdeck-teams-control/issues/7).

Dismissal runs after the result is sent, so it does not show up as a key that
stays lit, and it is bounded so a popup that will not close cannot stall the
queue. It is logged: look for `flyout dismissed by …` in the plugin log.

A meeting that drops out of the accessibility tree is re-checked every half
second and only reported as ended once it has been missing for three readings
over at least two seconds, because ending a meeting hands the deck back to
app-specific profile switching ([#52](https://github.com/danswett/streamdeck-teams-control/issues/52)).
Teams quitting ends it at once. The plugin log records `meeting detected`,
`meeting not found; re-checking …`, `meeting found again …` and `meeting
ended …`, each with window counts and flags (never titles) showing what the
sidecar could see.

Every Windows feature except Direct mode now has a macOS implementation:
slide thumbnails (`thumb` / `forget`, through ScreenCaptureKit), ink colour and
thickness (`ppt-ink-color` / `ppt-ink-thickness`), slide jumping
(`ppt-goto-slide`), the meeting timer (`timer-toggle` / `timer-reset`, and the
`timer.*` context), and cameras (`cameras` through AVFoundation, plus
`camera-select` / `camera-swap`). They mirror the Windows rules and error
messages, and none has been run against a live Teams on a Mac yet.
`tools/macos-probe.sh` captures what each one depends on, and every guess below
is overlayable in `selectors.json`:

- **Filmstrip.** Slide jumps and the next-slide thumbnail take the presenter
  view's slides to be slide-sized children of an `AXList`, the current one
  carrying `AXSelected`. The roles counted are
  `powerPointLive.filmstripItemRoles`. Because that is a guess, a jump is
  refused until the deck's slide counter has been read and the strip holds
  exactly that many slides - stricter than Windows, which jumps when the count
  is unknown.
- **Ink flyout.** Swatches are taken to be `AXRadioButton`s and thickness an
  `AXSlider` named by `powerPointLive.inkThicknessPattern`; the laser's arrow
  options are excluded by `arrowOptionPattern`, as on Windows.
- **Cameras.** A camera's menu item is taken to carry AVFoundation's
  `uniqueID` as its DOM id, the way Windows' carries the device id. Mirror,
  soft focus and brightness preferences are not applied yet; a key that sets
  them still switches camera and logs a warning.
- **Timer.** Read from button names, so the `timer` block of `selectors.json`
  localizes it.

**Permissions are opt-in, one at a time.** The sidecar never prompts on its
own: the only path to a macOS permission prompt is the `permissions` command,
and the plugin sends it only after an explicit choice.

- **Accessibility**, which every Teams key needs, follows the plugin-wide
  **Allow Teams control on this Mac** setting. A native dialog asks once when
  the plugin first runs, so it is settled before the first meeting, and any
  Teams key's settings can change it later. Until it is on, presses and
  captures are refused with a reason and keys show a setup tile.
- **Screen Recording**, for slide thumbnails (macOS 14 or later), is held
  separately: it is asked for only when a slide dial's **Show the slide on the
  touch strip** box is ticked.
- **Camera access is never needed.** Listing cameras does not prompt; only
  opening one would, and the sidecar never does.

Remaining gaps vs Windows: polling instead of AXObserver; `AXPress` raises the
Teams window for ~300ms (then we `AXRaise` the previous app); camera video
preferences; and Direct mode, which answers `usable: false` with a reason.
Teams for Mac is reportedly built on Edge WebView too, but whether it honours
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…` is unverified,
and the port's ownership check is the security boundary, so it waits for a Mac
to confirm the port opens at all.
