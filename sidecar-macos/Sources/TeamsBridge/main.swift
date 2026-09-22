import Foundation

/// Line-delimited JSON sidecar. stdout is the protocol; stderr is diagnostics.
enum IO {
    private static let lock = NSLock()

    static func emit(_ obj: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let line = String(data: data, encoding: .utf8) else { return }
        lock.lock()
        fputs(line + "\n", stdout)
        fflush(stdout)
        lock.unlock()
    }

    static func err(_ message: String) {
        fputs(message + "\n", stderr)
        fflush(stderr)
    }
}

struct WorkItem {
    var id: Int
    var cmd: String
    var target: String?
    var menu: String?
    var arg: String?
    var queuedAt = Date()
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
      {"cmd":"shutdown"}

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
        let snap = client.getSnapshot()
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
        let snap = client.getSnapshot()
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
            arg: obj["arg"] as? String
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
        let snap = client.getSnapshot()
        nextPoll = Date().addingTimeInterval(snap.inMeeting ? meetingPoll : idlePoll)
        let fp = snap.fingerprint()
        if fp != lastFingerprint {
            lastFingerprint = fp
            emitState(snap)
        }
    }
}
