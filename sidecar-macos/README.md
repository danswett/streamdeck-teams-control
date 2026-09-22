# TeamsBridge (macOS)

Swift accessibility sidecar. Same JSON-lines protocol as `sidecar/` (.NET).

See [#4](https://github.com/danswett/streamdeck-teams-control/issues/4) for the
probe results this is based on.

```bash
npm run build:sidecar:macos
```

Writes `com.bad-duck.teamscontrol.sdPlugin/bin/sidecar/TeamsBridge`. CI copies that Mach-O next to `TeamsBridge.exe` and packs on macOS so the executable bit survives.

Accessibility permission is required (typically granted to Stream Deck.app, the
responsible process when it spawns this helper). Do not sandbox the binary.

Known gaps vs Windows: polling instead of AXObserver; `AXPress` raises the Teams
window for ~300ms (then we `AXRaise` the previous app); PowerPoint Live ink /
slide thumbnails (`thumb` / `forget`) are not implemented.
