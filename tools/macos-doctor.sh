#!/usr/bin/env bash
#
# Reports why the macOS helper is or is not running. Diagnostic only - it
# repairs nothing, because the thing most worth knowing is the state the
# plugin was actually left in.
#
# Written after #7, where the helper could not launch and every key showed the
# alert triangle. That looks identical to Gatekeeper refusing the binary, and
# separating the two took two rounds of asking testers to type commands by
# hand. This runs them all at once.
#
#   curl -fsSL https://raw.githubusercontent.com/danswett/streamdeck-teams-control/main/tools/macos-doctor.sh -o /tmp/doctor.sh
#   bash /tmp/doctor.sh
#
# No arguments. Finds the installed plugin on its own. Prints a verdict at the
# end. Nothing here reads meeting content, and the only thing it sends anywhere
# is what you choose to paste.
set -u

PLUGIN="$HOME/Library/Application Support/com.elgato.StreamDeck/Plugins/com.bad-duck.teamscontrol.sdPlugin"
BUNDLE="$PLUGIN/bin/sidecar/TeamsBridge.app"
BIN="$BUNDLE/Contents/MacOS/TeamsBridge"

say() { printf '\n== %s ==\n' "$1"; }
verdict=""
note() { verdict="$verdict$1"$'\n'; }

printf 'streamdeck-teams-control macOS doctor\n'
printf 'host: %s   macOS %s   arch: %s\n' \
	"$(hostname -s 2>/dev/null)" "$(sw_vers -productVersion 2>/dev/null)" "$(uname -m)"

say "1. Is the plugin installed?"
if [ ! -d "$PLUGIN" ]; then
	echo "NOT FOUND: $PLUGIN"
	note "FAIL  the plugin is not installed - install the .streamDeckPlugin first"
	printf '\n%s' "$verdict"
	exit 1
fi
echo "found: $PLUGIN"
if [ -f "$PLUGIN/manifest.json" ]; then
	/usr/bin/python3 - "$PLUGIN/manifest.json" <<-'PY' 2>/dev/null || true
		import json, sys
		m = json.load(open(sys.argv[1]))
		print("version:", m.get("Version"), " OS:", m.get("OS"))
	PY
fi

say "2. The execute bit (#7)"
if [ ! -f "$BIN" ]; then
	echo "NOT FOUND: $BIN"
	note "FAIL  no sidecar in the package - this build has no macOS helper"
else
	ls -l "$BIN"
	if [ -x "$BIN" ]; then
		note "ok    sidecar is executable"
	else
		note "FAIL  sidecar is NOT executable - it cannot be spawned"
		note "      fix: start Stream Deck and let the plugin load. Do NOT chmod it"
		note "      yourself - macOS restricts writes inside the .app to Stream Deck"
		note "      and will refuse you with 'Operation not permitted'."
	fi
fi

say "3. Is the sidecar running?"
if pgrep -fl TeamsBridge 2>/dev/null; then
	note "ok    a TeamsBridge process is alive"
else
	echo "(no TeamsBridge process)"
	note "note  no sidecar running - expected if Stream Deck is closed"
fi

say "4. Architecture - does this Mac have a slice?"
if [ -f "$BIN" ]; then
	file "$BIN"
	lipo -info "$BIN" 2>/dev/null || true
	arch="$(uname -m)"
	if lipo -info "$BIN" 2>/dev/null | grep -q "$arch"; then
		note "ok    a $arch slice is present for this Mac"
	else
		note "FAIL  no $arch slice - this binary cannot run on this Mac"
	fi
fi

say "5. Quarantine and Gatekeeper"
xattr -p com.apple.quarantine "$BUNDLE" 2>&1 || true
codesign -dv --verbose=2 "$BUNDLE" 2>&1 | grep -E 'Authority|Signature|flags' || true
xcrun stapler validate "$BUNDLE" 2>&1 | tail -2 || true
spctl --assess --type execute -vv "$BUNDLE" 2>&1 || true

say "6. Does it actually execute?"
# The real test, and the one no CI can do: run the binary. --help exits 0
# without touching Teams or Accessibility.
if [ -f "$BIN" ]; then
	if out="$("$BIN" --help 2>&1)"; then
		echo "$out" | head -5
		note "ok    the binary executes on this Mac"
	else
		rc=$?
		echo "exit $rc: $out" | head -5
		note "FAIL  the binary did not execute (exit $rc)"
	fi
fi

say "7. A protocol round-trip"
# Teams does not need to be installed: the sidecar answers with
# teamsRunning:false and exits cleanly when stdin closes.
#
# macOS may raise an Accessibility prompt here, because the helper asks for the
# permission it would need in a meeting. Dismissing it is fine - nothing below
# depends on it.
if [ -x "$BIN" ]; then
	echo '{"id":1,"cmd":"status"}' | "$BIN" 2>&1 | head -6
else
	echo "(skipped - not executable)"
fi

say "8. What the plugin logged"
if [ -d "$PLUGIN/logs" ]; then
	newest="$(ls -t "$PLUGIN/logs"/*.log 2>/dev/null | head -1)"
	if [ -n "${newest:-}" ]; then
		echo "$newest"
		grep -E 'Sidecar|sidecar|invoke\(|execute' "$newest" 2>/dev/null | tail -20
		if grep -q 'set to 755' "$newest" 2>/dev/null; then
			note "ok    the execute-bit repair fired at least once"
		fi
		if grep -q 'sidecar not running' "$newest" 2>/dev/null; then
			note "FAIL  a press found no sidecar - it is not launching"
		fi
		if grep -q 'Teams is not running' "$newest" 2>/dev/null; then
			note "ok    a press reached the sidecar (it replied 'Teams is not running')"
		fi
	else
		echo "(no .log files yet - start Stream Deck at least once)"
	fi
else
	echo "(no logs directory - the plugin has never run)"
fi

say "Verdict"
printf '%s' "$verdict"
echo
echo "Paste everything above into https://github.com/danswett/streamdeck-teams-control/issues/7"
