import Foundation
import TeamsBridgeCore

struct WorkItem {
    var id: Int
    var cmd: String
    var target: String?
    var menu: String?
    var arg: String?
    var fade = 0
    var width = 200
    var height = 100
    var queuedAt = Date()
}

/// Bounds on a thumbnail request, as on Windows: a fade allocates a frame per
/// step and a slot is a bitmap, so a caller cannot ask for an unbounded one.
let maxFadeFrames = 12
let maxSlotPixels = 1024

func clampedInt(_ raw: Any?, _ low: Int, _ high: Int, default fallback: Int) -> Int {
    guard let n = raw as? NSNumber else { return fallback }
    return min(max(n.intValue, low), high)
}

func argValue(_ args: [String], _ name: String) -> String? {
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return nil
}

func hasFlag(_ args: [String], _ name: String) -> Bool {
    args.contains { $0.caseInsensitiveCompare(name) == .orderedSame }
}

func emitState(_ snap: MeetingSnapshot) {
    IO.emit([
        "type": "state",
        "teamsRunning": snap.teamsRunning,
        "inMeeting": snap.inMeeting,
        "windowTitle": snap.windowTitle,
        "states": snap.states,
        "available": snap.available,
        "context": snap.context,
    ])
}

func loadConfig(path: String) -> SelectorConfig {
    var cfg = Defaults.config()
    guard FileManager.default.fileExists(atPath: path),
          let text = try? String(contentsOfFile: path, encoding: .utf8) else {
        return cfg
    }
    cfg = Defaults.overlay(cfg, json: text)
    IO.err("applied selector overlay from \(path)")
    return cfg
}

let args = Array(CommandLine.arguments.dropFirst())
if hasFlag(args, "-h") || hasFlag(args, "--help") {
    fputs("""
    TeamsBridge — macOS accessibility sidecar for streamdeck-teams-control

    Speaks line-delimited JSON on stdin/stdout, matching the Windows TeamsBridge.exe
    protocol. Diagnostics go to stderr.

    OPTIONS
      --selectors PATH   Overlay control map (default: ./selectors.json beside the binary)
      --poll MS          Backstop poll while in a meeting (default 700)
      --no-focus-guard   Do not AXRaise the previous app after a press

    COMMANDS (one JSON object per line)
      {"id":1,"cmd":"status"}
      {"id":2,"cmd":"invoke","target":"mute"}
      {"id":3,"cmd":"discover","menu":""}
      {"id":4,"cmd":"ping"}
      {"id":5,"cmd":"cameras"}
      {"id":6,"cmd":"thumb","arg":"current","w":200,"h":100,"fade":0}
      {"id":7,"cmd":"forget","arg":"current"}   (no reply, as on Windows)
      {"cmd":"shutdown"}

    Answered, but not implemented here - it reports that rather than looking
    like an unrecognised command:
      {"id":8,"cmd":"directmode"}              drive Teams through a debug port

    """, stderr)
    exit(0)
}

let exeDir = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().path
let selectorsPath = argValue(args, "--selectors")
    ?? exeDir + "/selectors.json"
let pollMs = max(150, min(5000, Int(argValue(args, "--poll") ?? "700") ?? 700))
let restoreFocus = !hasFlag(args, "--no-focus-guard")
let config = loadConfig(path: selectorsPath)

if !AX.isTrusted(prompt: true) {
    IO.err("not trusted for Accessibility — grant it to this binary (or Stream Deck) in System Settings > Privacy & Security > Accessibility")
}

let client = TeamsClient(config: config, restoreFocus: restoreFocus)
let queue = DispatchQueue(label: "teamsbridge.ax")
let pending = DispatchQueue(label: "teamsbridge.inbox")
var items: [WorkItem] = []
var running = true
var lastFingerprint = ""
var nextPoll = Date()
let meetingPoll = TimeInterval(max(pollMs, 700)) / 1000.0
let idlePoll: TimeInterval = 15.0
let staleInvoke: TimeInterval = 9.0
let settle: TimeInterval = 1.2
var settleAt: Date?
var presence = MeetingPresence()
/// Whether a missing meeting is being re-checked; see MeetingPresence.
var confirmingEnd = false
let confirmPoll: TimeInterval = 0.5

/// Every reading goes through here, so a status request or the snapshot after
/// a press cannot report a meeting as ended that the poll is still re-checking.
func observedSnapshot() -> MeetingSnapshot {
    let reading = presence.observe(client.getSnapshot())
    confirmingEnd = reading.confirming
    switch reading.transition {
    case .started?:
        IO.err("meeting detected: \(client.diagnose())")
    case .missed?:
        IO.err("meeting not found; re-checking before reporting it ended: \(client.diagnose())")
    case .recovered(let misses)?:
        IO.err("meeting found again after \(misses) missed reading(s); not reported as ended")
    case .ended(let misses, let span)?:
        IO.err("meeting ended (not found in \(misses) reading(s) over \(String(format: "%.1f", span))s): \(client.diagnose())")
    case nil:
        break
    }
    return reading.snapshot
}

func enqueue(_ item: WorkItem) {
    pending.sync { items.append(item) }
}

func takeItem() -> WorkItem? {
    pending.sync {
        guard !items.isEmpty else { return nil }
        return items.removeFirst()
    }
}

func handle(_ item: WorkItem) {
    switch item.cmd {
    case "ping", "poll":
        if item.cmd == "ping" {
            IO.emit(["type": "result", "id": item.id, "ok": true])
        }
    case "status":
        let snap = observedSnapshot()
        lastFingerprint = snap.fingerprint()
        emitState(snap)
        IO.emit(["type": "result", "id": item.id, "ok": true])
    case "invoke":
        let age = Date().timeIntervalSince(item.queuedAt)
        if age > staleInvoke {
            IO.err("dropping stale invoke '\(item.target ?? "")' queued \(Int(age * 1000))ms ago")
            IO.emit(["type": "result", "id": item.id, "ok": false, "error": "dropped: queued too long"])
            break
        }
        let (ok, err) = client.invoke(target: item.target ?? "", arg: item.arg)
        var result: [String: Any] = ["type": "result", "id": item.id, "ok": ok]
        if let err { result["error"] = err }
        IO.emit(result)
        // Answer first, tidy up second. Choosing an item through accessibility
        // leaves the flyout open, and closing it takes long enough that doing
        // so before replying would show as a key that stays lit - but it has to
        // happen before the snapshot below, because a flyout standing over the
        // toolbar is not a reading worth sending.
        client.runPendingCleanup()
        let snap = observedSnapshot()
        lastFingerprint = snap.fingerprint()
        emitState(snap)
        settleAt = Date().addingTimeInterval(settle)
    case "discover":
        let rows = client.discover(menu: item.menu)
        IO.emit([
            "type": "discover",
            "id": item.id,
            "menu": item.menu ?? "",
            "elements": rows,
        ])
    case "cameras":
        let cameras = Cameras.enumerate()
        IO.emit([
            "type": "cameras",
            "id": item.id,
            "ok": true,
            "cameras": cameras.map { ["id": $0.id, "name": $0.name] },
        ])
    case "thumb":
        // Its own message type rather than a result, because it carries a
        // picture: kept off the state channel so a thumbnail never rides along
        // with every key's availability. The slot size is the caller's.
        let which = item.arg ?? "current"
        let shot = client.captureSlide(which: which, fade: item.fade, width: item.width, height: item.height)
        var reply: [String: Any] = [
            "type": "thumb",
            "id": item.id,
            "ok": shot.ok,
            "which": which,
            "end": shot.end,
        ]
        if let name = shot.name { reply["name"] = name }
        if let image = shot.image { reply["image"] = image }
        if let error = shot.error { reply["error"] = error }
        if !shot.frames.isEmpty { reply["frames"] = shot.frames }
        IO.emit(reply)
    case "forget":
        // No reply, matching Windows: drops the picture a slot fades from.
        SlideCapture.forget(item.arg)
    case "directmode":
        // Direct mode drives Teams through a debugging port the user opens
        // themselves, and has no macOS implementation. Answered rather than
        // refused so anything asking gets a usable "no" with a reason.
        IO.emit([
            "type": "directmode",
            "id": item.id,
            "ok": true,
            "usable": false,
            "reason": "direct mode is not implemented in the macOS sidecar",
            "deckShared": false,
        ])
    case "shutdown":
        running = false
    default:
        IO.emit(["type": "result", "id": item.id, "ok": false, "error": "unknown command '\(item.cmd)'"])
    }
}

DispatchQueue.global(qos: .userInitiated).async {
    while let line = readLine(strippingNewline: true) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { continue }
        guard let data = trimmed.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            IO.emit(["type": "error", "message": "bad request: invalid JSON"])
            continue
        }
        let cmd = obj["cmd"] as? String ?? ""
        if cmd == "shutdown" {
            enqueue(WorkItem(id: 0, cmd: "shutdown"))
            break
        }
        enqueue(WorkItem(
            id: (obj["id"] as? Int) ?? (obj["id"] as? NSNumber)?.intValue ?? 0,
            cmd: cmd,
            target: obj["target"] as? String,
            menu: obj["menu"] as? String,
            arg: obj["arg"] as? String,
            fade: clampedInt(obj["fade"], 0, maxFadeFrames, default: 0),
            width: clampedInt(obj["w"], 16, maxSlotPixels, default: 200),
            height: clampedInt(obj["h"], 16, maxSlotPixels, default: 100)
        ))
    }
    enqueue(WorkItem(id: 0, cmd: "shutdown"))
}

IO.emit([
    "type": "ready",
    "pid": ProcessInfo.processInfo.processIdentifier,
    "selectors": FileManager.default.fileExists(atPath: selectorsPath) ? selectorsPath : "(built-in defaults)",
    "platform": "macos",
    "idAttribute": "AXDOMIdentifier",
])

while running {
    if let item = takeItem() {
        queue.sync { handle(item) }
        nextPoll = Date().addingTimeInterval(0.12)
        continue
    }

    let now = Date()
    let due = [nextPoll, settleAt].compactMap { $0 }.min() ?? nextPoll
    if now < due {
        Thread.sleep(forTimeInterval: min(0.05, due.timeIntervalSince(now)))
        continue
    }
    if let s = settleAt, now >= s { settleAt = nil }

    queue.sync {
        let snap = observedSnapshot()
        nextPoll = Date().addingTimeInterval(
            confirmingEnd ? confirmPoll : (snap.inMeeting ? meetingPoll : idlePoll)
        )
        let fp = snap.fingerprint()
        if fp != lastFingerprint {
            lastFingerprint = fp
            emitState(snap)
        }
    }
}
