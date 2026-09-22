#!/usr/bin/env bash
#
# Captures the accessibility tree PowerPoint Live presents on macOS.
#
# Two features are missing from the macOS sidecar and both are blocked on the
# same thing: nobody has seen the tree they would have to read.
#
#   ink colour     Windows keys off ink-tool-0..4 and reports ppt.color.<tool>,
#                  ppt.thickness.<tool> and ppt.palette.<tool>. Whether those
#                  ids surface on macOS, and what the swatches are named, is
#                  unknown.
#
#   slide thumbs   PowerPoint Live exposes no image of a slide, only its name,
#                  so a thumbnail has to be taken off the screen. That needs a
#                  rectangle, and possibly Screen Recording permission - a
#                  second, scarier prompt than Accessibility. Worth knowing
#                  whether the slide surface is even addressable before asking
#                  a user for that.
#
# Writing that code without seeing the tree produces something that compiles,
# looks right, and silently finds nothing. This captures the tree instead, so
# it can be written against fact.
#
# Nothing here changes Teams. Every step is a read, except opening the flyouts
# the tool palette lives in - which is what the operator is asked to do anyway.
#
# Usage:
#   npm run build:sidecar:macos      # once, to have a binary
#   bash tools/macos-probe.sh        # follow the prompts
#
# Produces macos-probe.json. It records element ids, roles, accessible names
# and screen rectangles from Teams' own UI. Accessible names are localized, so
# the capture reflects the UI language of the machine it ran on. It contains no
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
	if [ -x "$candidate" ]; then
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

echo "Probing the macOS PowerPoint Live tree."
echo "Grant Accessibility to your terminal if macOS asks."
sleep 2

step "1/6  Teams running, NOT in a meeting." || send '{"id":1,"cmd":"discover"}'
step "2/6  Join a meeting. Do not present yet." || send '{"id":2,"cmd":"discover"}'
step "3/6  Someone presents a deck through PowerPoint Live (you can present to yourself)." || send '{"id":3,"cmd":"discover"}'

# menu presses the named element first, which is how the flyout is opened
# before the tree is walked - the tools only exist while it is open, exactly as
# on Windows.
step "4/6  You are the presenter. The probe will open the drawing-tools flyout itself." || send '{"id":4,"cmd":"discover","menu":"ppt-tools-button"}'
step "5/6  Select the PEN, then the probe opens the ink-colour flyout." || send '{"id":5,"cmd":"discover","menu":"ink-color-button"}'
step "6/6  Leave the ink flyout open on the colour swatches." || send '{"id":6,"cmd":"discover"}'

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
    3: "someone presenting a deck",
    4: "drawing-tools flyout open",
    5: "ink-colour flyout open",
    6: "ink-colour flyout still open",
}

captures = []
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    if msg.get("type") != "discover":
        continue
    captures.append({
        "step": msg.get("id"),
        "what": labels.get(msg.get("id"), ""),
        "menu": msg.get("menu", ""),
        "elements": msg.get("elements", []),
    })

json.dump({"captures": captures}, open(sys.argv[2], "w", encoding="utf-8"), indent=2)

print()
for c in captures:
    ink = [e for e in c["elements"] if "ink" in (e.get("id") or "").lower()]
    ppt = [e for e in c["elements"] if (e.get("id") or "").startswith("ppt")]
    print(f"  step {c['step']:<2} {c['what']:<32} {len(c['elements']):>5} elements"
          f"  ppt:{len(ppt):<3} ink:{len(ink)}")
PY

rm -f "$OUT.raw"
echo
echo "Wrote $OUT"
echo
echo "Check it before sending: it holds element ids, roles, accessible names and"
echo "screen rectangles from the Teams UI, and no meeting content. Names are"
echo "localized, so it reflects this machine's UI language."
[ -s "$OUT.err" ] && echo "Sidecar diagnostics in $OUT.err"
exit 0
