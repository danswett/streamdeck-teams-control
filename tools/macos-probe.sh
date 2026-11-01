#!/usr/bin/env bash
#
# Captures what the macOS sidecar's Windows-parity features read, so a single
# session on a Mac can confirm or correct them.
#
# Every feature the Windows sidecar has is now implemented on macOS, but four
# of them were written against the Windows tree and a guess at how Chromium
# maps it onto macOS accessibility. Each guess is overlayable in
# selectors.json, and this capture is what says whether it needs to be:
#
#   slide jump / next-slide thumbnail
#                  the filmstrip is taken to be slide-sized children of an
#                  AXList (powerPointLive.filmstripItemRoles), the current one
#                  carrying AXSelected.
#   ink colour / thickness
#                  the flyout a drawing tool opens is taken to hold
#                  AXRadioButton swatches and an AXSlider named "Ink thickness".
#   cameras        a camera's menu item is taken to carry AVFoundation's
#                  uniqueID as its DOM id, as Windows' carries the device id.
#   timer          read from button names, as on Windows.
#
# Writing that code without seeing the tree produces something that compiles,
# looks right, and silently finds nothing. This captures the tree instead.
#
# Nothing here changes Teams. Every step is a read, except opening the flyouts
# the operator is asked to look at anyway: the pen's options and the video
# options.
#
# Usage:
#   npm run build:sidecar:macos      # once, to have a binary
#   bash tools/macos-probe.sh        # follow the prompts
#
# Produces macos-probe.json. It records element ids, roles, accessible names,
# selection state and screen rectangles from Teams' own UI, and the names and
# ids of the cameras macOS reports. Accessible names are localized, so the
# capture reflects the UI language of the machine it ran on. It contains no
# meeting content: no slide images, no chat, no participant list.
set -euo pipefail

APP=""
CANDIDATES=(
	# A local build, if this is a checkout that has run build:sidecar:macos.
	"com.bad-duck.teamscontrol.sdPlugin/bin/sidecar/TeamsBridge.app/Contents/MacOS/TeamsBridge"
	# An installed plugin, which is the common case: download the test build,
	# install it, run this. No toolchain, no checkout of the Swift package.
	"$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.bad-duck.teamscontrol.sdPlugin/bin/sidecar/TeamsBridge.app/Contents/MacOS/TeamsBridge"
)

for candidate in "${CANDIDATES[@]}"; do
	# -f, not -x. An installed sidecar arrives without its execute bit, because
	# streamdeck pack writes every zip entry 0644 (#7). Testing for -x found
	# nothing and sent the tester off to build a toolchain they were promised
	# they would not need.
	if [ -f "$candidate" ]; then
		APP="$candidate"
		break
	fi
done

if [ -z "$APP" ]; then
	echo "Could not find the sidecar. Looked in:"
	for candidate in "${CANDIDATES[@]}"; do echo "  $candidate"; done
	echo
	echo "Either install the macOS test build, or build it here with:"
	echo "  npm run build:sidecar:macos"
	exit 1
fi

# The plugin repairs this itself before spawning (#7); the probe runs the binary
# directly, so it has to try. It will usually fail, and that is not a bug:
# com.apple.macl on the .app restricts writes inside the bundle to the app that
# created it, which is Stream Deck. A chmod from a shell gets EPERM however the
# file is owned. Starting Stream Deck is the real remedy - the plugin is inside
# the process tree that TCC allows.
if [ ! -x "$APP" ]; then
	echo "Sidecar is not executable - packaging strips the bit."
	if chmod +x "$APP" 2>/dev/null; then
		echo "Restored it."
	else
		echo
		echo "chmod was refused, which is expected: macOS restricts writes inside"
		echo "TeamsBridge.app to Stream Deck, the app that extracted it."
		echo
		echo "Start Stream Deck once and let the plugin load. It repairs the bit"
		echo "on its first spawn. Then run this again."
		exit 1
	fi
fi

echo "Using: $APP"
OUT="macos-probe.json"

FIFO="$(mktemp -u)"
mkfifo "$FIFO"
: > "$OUT.raw"

# The sidecar speaks JSON lines over stdin/stdout, so the probe drives it the
# same way the plugin does rather than through some other path that might
# behave differently.
"$APP" < "$FIFO" >> "$OUT.raw" 2>"$OUT.err" &
SIDECAR=$!
exec 3> "$FIFO"
rm -f "$FIFO"

cleanup() {
	echo '{"id":999,"cmd":"shutdown"}' >&3 2>/dev/null || true
	exec 3>&- 2>/dev/null || true
	wait "$SIDECAR" 2>/dev/null || true
}
trap cleanup EXIT

send() { echo "$1" >&3; sleep 2; }

step() {
	echo
	echo "─────────────────────────────────────────────"
	echo "$1"
	echo "─────────────────────────────────────────────"
	read -r -p "Press return when ready (or s to skip): " answer
	[ "$answer" = "s" ]
}

echo "Probing the Teams tree for the macOS parity features."
echo "macOS will ask to allow your terminal under Accessibility; the probe cannot read Teams without it."
# The helper never prompts by itself; running this probe is the explicit choice.
echo '{"id":0,"cmd":"permissions","arg":"request-accessibility"}' >&3
sleep 2

step "1/8  Teams running, NOT in a meeting." || send '{"id":1,"cmd":"discover"}'
step "2/8  Join a meeting with your camera on. Do not present yet." || send '{"id":2,"cmd":"discover"}'

# menu presses the named element first, which is how the flyout is opened
# before the tree is walked - its items only exist while it is open.
step "3/8  Still in the meeting. The probe will open the video options (camera list)." || send '{"id":3,"cmd":"discover","menu":"video-button-configure"}'
step "4/8  Close that menu. Start a meeting timer if your Teams offers one (skip if not)." || send '{"id":4,"cmd":"discover"}'
step "5/8  Present a deck through PowerPoint Live with presenter view (the slide strip) showing. Go to slide 2 or later." || send '{"id":5,"cmd":"discover"}'
step "6/8  Select the PEN by hand. The probe will open its options (colours and thickness)." || send '{"id":6,"cmd":"discover","menu":"ink-tool-0"}'
step "7/8  Leave the pen's options open." || send '{"id":7,"cmd":"discover"}'

# The cameras macOS reports, to compare against the menu item ids in step 3.
step "8/8  Close the pen's options. The probe lists the cameras macOS reports." || send '{"id":8,"cmd":"cameras"}'

echo
echo "Collecting..."
sleep 2
cleanup
trap - EXIT

# One file, with the step each capture came from, so it can be read without
# the operator having to explain what they were doing at the time.
python3 - "$OUT.raw" "$OUT" <<'PY'
import json, sys

labels = {
    1: "teams running, no meeting",
    2: "in a meeting, nobody presenting",
    3: "video options open",
    4: "meeting timer running",
    5: "presenting, presenter view showing",
    6: "pen options opened",
    7: "pen options still open",
}

captures = []
cameras = []
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    if msg.get("type") == "cameras":
        cameras = msg.get("cameras", [])
        continue
    if msg.get("type") != "discover":
        continue
    captures.append({
        "step": msg.get("id"),
        "what": labels.get(msg.get("id"), ""),
        "menu": msg.get("menu", ""),
        "elements": msg.get("elements", []),
    })

json.dump({"captures": captures, "cameras": cameras}, open(sys.argv[2], "w", encoding="utf-8"), indent=2)

def size(e):
    try:
        _, _, w, h = (int(v) for v in e.get("frame", "").split(","))
        return w, h
    except ValueError:
        return 0, 0

camera_ids = {c.get("id") for c in cameras}
print()
for c in captures:
    els = c["elements"]
    tiles = [e for e in els if e.get("parentRole") == "AXList" and size(e)[0] >= 100 and size(e)[1] >= 60]
    roles = sorted({e.get("role", "") for e in tiles})
    sliders = [e for e in els if e.get("role") == "AXSlider"]
    swatches = [e for e in els if e.get("role") == "AXRadioButton"]
    timer = [e for e in els if "timer" in (e.get("name") or "").lower()]
    camera_items = [e for e in els if e.get("id") in camera_ids]
    print(f"  step {c['step']:<2} {c['what']:<36} {len(els):>5} elements"
          f"  slide tiles:{len(tiles)} {roles}  sliders:{len(sliders)}  radios:{len(swatches)}"
          f"  timer:{len(timer)}  camera items:{len(camera_items)}")
print(f"  cameras macOS reports: {len(cameras)}")
PY

rm -f "$OUT.raw"
echo
echo "Wrote $OUT"
echo
echo "Check it before sending: it holds element ids, roles, accessible names,"
echo "selection state and screen rectangles from the Teams UI, plus your camera"
echo "names, and no meeting content. Names are localized, so it reflects this"
echo "machine's UI language."
[ -s "$OUT.err" ] && echo "Sidecar diagnostics in $OUT.err"
exit 0
