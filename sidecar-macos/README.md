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

Known gaps vs Windows, all of which now *say so* rather than failing as though
something were broken: polling instead of AXObserver; `AXPress` raises the Teams
window for ~300ms (then we `AXRaise` the previous app); slide capture (`thumb`),
ink colour and thickness actuation (`ppt-ink-color` / `ppt-ink-thickness`),
slide jumping (`ppt-goto-slide`), the meeting timer (`timer-toggle` /
`timer-reset`) and direct mode are not implemented.

Ink colour, ink thickness and the slide counter are *read* and published in the
snapshot context, so keys and dials display correctly even where they cannot yet
be driven.
