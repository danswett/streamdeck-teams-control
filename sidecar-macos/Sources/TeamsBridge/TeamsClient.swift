import AppKit
import ApplicationServices
import Foundation

struct MeetingSnapshot {
    var teamsRunning = false
    var inMeeting = false
    var windowTitle = ""
    var states: [String: Bool] = [:]
    var available: [String: Bool] = [:]
    var context: [String: String] = [:]

    func fingerprint() -> String {
        var s = "\(teamsRunning)|\(inMeeting)|"
        for k in states.keys.sorted() { s += "\(k)=\(states[k] ?? false);" }
        s += "|"
        for k in available.keys.sorted() { s += "\(k)=\(available[k] ?? false);" }
        s += "|"
        for k in context.keys.sorted() { s += "\(k)=\(context[k] ?? "");" }
        return s
    }
}

final class TeamsClient {
    private let config: SelectorConfig
    private let restoreFocus: Bool
    private var lastStates: [String: Bool] = [:]
    private var lastAvailable: [String: Bool] = [:]
    private var appEl: AXUIElement?
    private var teamsPID: pid_t = 0

    init(config: SelectorConfig, restoreFocus: Bool) {
        self.config = config
        self.restoreFocus = restoreFocus
    }

    func findTeams() -> NSRunningApplication? {
        for bundle in ["com.microsoft.teams2", "com.microsoft.teams"] {
            if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundle).first {
                return app
            }
        }
        return NSWorkspace.shared.runningApplications.first {
            $0.activationPolicy == .regular && ($0.localizedName ?? "").localizedCaseInsensitiveContains("teams")
        }
    }

    @discardableResult
    func attach() -> Bool {
        guard let app = findTeams() else {
            appEl = nil
            teamsPID = 0
            return false
        }
        if app.processIdentifier != teamsPID {
            teamsPID = app.processIdentifier
            let el = AXUIElementCreateApplication(teamsPID)
            AX.bootstrap(el)
            appEl = el
        }
        return true
    }

    func getSnapshot() -> MeetingSnapshot {
        var snap = MeetingSnapshot()
        snap.teamsRunning = findTeams() != nil
        guard snap.teamsRunning, attach(), let appEl else { return snap }

        let wins = AX.windows(appEl)
        let nodes = Tree.walk(windows: wins)
        let byID = Tree.indexByID(nodes)

        guard let meeting = pickMeetingWindow(wins: wins, byID: byID) else { return snap }
        snap.inMeeting = true
        snap.windowTitle = AX.string(meeting.window, kAXTitleAttribute as String) ?? ""

        let role = readPPTRole(byID: byID)
        snap.states["ppt-live"] = role != nil
        snap.states["ppt-presenting"] = role == "presenter"
        if let role { snap.context["ppt.role"] = role }

        for (key, spec) in config.controls {
            if let need = spec.requiresRole, need.lowercased() != (role ?? "") {
                snap.available[key] = false
                lastAvailable[key] = false
                continue
            }

            if let presentID = spec.activeWhenPresentAutomationId, !presentID.isEmpty {
                let on = byID[presentID] != nil
                snap.states[key] = on
                lastStates[key] = on
            }

            if let menu = spec.menu, !menu.isEmpty {
                if let itemID = spec.menuItemAutomationId, let item = byID[fillArg(itemID, nil) ?? itemID], item.enabled {
                    snap.available[key] = true
                    lastAvailable[key] = true
                    applyNameState(spec, node: item, key: key, snap: &snap)
                    continue
                }
                if let host = byID[menu], host.enabled {
                    snap.available[key] = true
                    lastAvailable[key] = true
                    if let prev = lastStates[key] { snap.states[key] = prev }
                    continue
                }
                snap.available[key] = false
                lastAvailable[key] = false
                continue
            }

            let node = resolve(spec, byID: byID)
            guard let node else {
                snap.available[key] = false
                lastAvailable[key] = false
                if snap.states[key] == nil, let prev = lastStates[key] { snap.states[key] = prev }
                continue
            }
            snap.available[key] = node.enabled
            lastAvailable[key] = node.enabled
            if spec.activeWhenPresentAutomationId == nil {
                applyNameState(spec, node: node, key: key, snap: &snap)
            }
        }
        return snap
    }

    private func applyNameState(_ spec: ControlSpec, node: AXNode, key: String, snap: inout MeetingSnapshot) {
        let text: String
        if spec.stateFromFullDescription {
            text = AX.string(node.element, kAXHelpAttribute as String) ?? node.label
        } else {
            text = node.label
        }
        if spec.matches(spec.activeRegex, text: text) {
            snap.states[key] = true
            lastStates[key] = true
        } else if spec.matches(spec.inactiveRegex, text: text) {
            snap.states[key] = false
            lastStates[key] = false
        }
        if spec.stateFromSelection, let selected = AX.bool(node.element, "AXSelected") {
            snap.states[key] = selected
            lastStates[key] = selected
        }
    }

    private func readPPTRole(byID: [String: AXNode]) -> String? {
        if byID["stopPresentingPptBtn"] != nil { return "presenter" }
        if byID["takeControlPptBtn"] != nil { return "attendee" }
        if byID["ppt-previewer-root"] != nil { return "attendee" }
        return nil
    }

    private struct MeetingWindow {
        var window: AXUIElement
        var title: String
        var rich: Bool
    }

    private func pickMeetingWindow(wins: [AXUIElement], byID: [String: AXNode]) -> MeetingWindow? {
        let probe = config.meetingProbeAutomationId
        guard byID[probe] != nil else { return nil }

        var candidates: [MeetingWindow] = []
        for w in wins {
            let title = AX.string(w, kAXTitleAttribute as String) ?? ""
            if title.localizedCaseInsensitiveContains("| Calendar |") { continue }
            let sub = Tree.walk(windows: [w], maxNodes: 4000)
            let ids = Tree.indexByID(sub)
            guard ids[probe] != nil else { continue }
            candidates.append(MeetingWindow(
                window: w,
                title: title,
                rich: ids[config.fullToolbarAutomationId] != nil
            ))
        }
        if let rich = candidates.first(where: { $0.rich }) { return rich }
        if let named = candidates.first(where: { !$0.title.isEmpty && $0.title != "(untitled)" }) { return named }
        return candidates.first
    }

    private func resolve(_ spec: ControlSpec, byID: [String: AXNode]) -> AXNode? {
        if !spec.automationId.isEmpty, let n = byID[spec.automationId] { return n }
        return nil
    }

    func invoke(target: String, arg: String?) -> (ok: Bool, error: String?) {
        guard config.controls[target] != nil else { return (false, "unknown target '\(target)'") }
        guard attach(), appEl != nil else { return (false, "Teams is not running") }
        guard AX.isTrusted() else { return (false, "not trusted for Accessibility") }

        let captured = restoreFocus ? FocusRestore.capture(teamsPID: teamsPID) : nil
        defer { if restoreFocus { FocusRestore.restore(captured) } }
        return invokeCore(target: target, arg: arg)
    }

    private func invokeCore(target: String, arg: String?) -> (ok: Bool, error: String?) {
        guard let spec = config.controls[target], let appEl else { return (false, "not in a meeting") }
        let wins = AX.windows(appEl)
        let nodes = Tree.walk(windows: wins)
        let byID = Tree.indexByID(nodes)
        guard pickMeetingWindow(wins: wins, byID: byID) != nil else { return (false, "not in a meeting") }

        if let presentID = spec.activeWhenPresentAutomationId,
           !presentID.isEmpty,
           byID[presentID] != nil,
           spec.offRegex != nil || !(spec.offAutomationId ?? "").isEmpty {
            if let offID = spec.offAutomationId, let off = byID[offID] {
                return press(off.element, name: target)
            }
            if let off = nodes.first(where: { spec.matches(spec.offRegex, text: $0.label) && $0.enabled }) {
                return press(off.element, name: target)
            }
            if let selfNode = resolve(spec, byID: byID) {
                return press(selfNode.element, name: target)
            }
            return (false, "could not find how to turn '\(target)' off")
        }

        let itemID = fillArg(spec.menuItemAutomationId, arg)
        let itemToggleID = fillArg(spec.menuItemToggleAutomationId, arg)

        if spec.menu == nil || spec.menu?.isEmpty == true {
            guard let node = resolve(spec, byID: byID) else { return (false, "control '\(target)' not found") }
            if !node.enabled { return (false, "control '\(target)' is disabled") }
            let result = press(node.element, name: target)
            if result.ok { rememberToggle(target) }
            return result
        }

        // Item already in the tree (raise-hand lives on the macOS toolbar).
        for id in [itemID, itemToggleID].compactMap({ $0 }) where !id.isEmpty {
            if let item = byID[id], item.enabled {
                let result = press(item.element, name: target)
                if result.ok { lastStates[target] = !(lastStates[target] ?? false) }
                return result
            }
        }

        guard let menuID = spec.menu, let host = byID[menuID] else {
            return (false, "menu '\(spec.menu ?? "")' not found")
        }
        if !host.enabled { return (false, "menu '\(menuID)' is disabled") }

        let opened = press(host.element, name: menuID)
        if !opened.ok { return (false, "could not open menu '\(menuID)'") }

        let deadline = Date().addingTimeInterval(2.5)
        var item: AXNode?
        while Date() < deadline && item == nil {
            Thread.sleep(forTimeInterval: 0.05)
            let live = Tree.indexByID(Tree.walk(windows: AX.windows(appEl)))
            if let sub = spec.submenu, !sub.isEmpty, let subNode = live[sub], item == nil {
                _ = press(subNode.element, name: sub)
                Thread.sleep(forTimeInterval: 0.2)
            }
            for id in [itemID, itemToggleID].compactMap({ $0 }) where !id.isEmpty {
                if let found = live[id], found.enabled { item = found; break }
            }
            if item == nil, let rx = spec.menuItemRegex {
                let liveNodes = Tree.walk(windows: AX.windows(appEl))
                item = liveNodes.first { spec.matches(rx, text: $0.label) && $0.enabled }
            }
        }

        guard let item else {
            _ = press(host.element, name: menuID) // try to close
            return (false, "menu item for '\(target)' not found")
        }

        if let offRx = spec.menuItemOffRegex, spec.matches(spec.menuItemRegex, text: item.label) {
            // Radio: if already on, click the off item instead. We don't know
            // "already on" cheaply; press the requested item.
            _ = offRx
        }
        let result = press(item.element, name: target)
        if result.ok { lastStates[target] = true }
        return result
    }

    private func rememberToggle(_ target: String) {
        if let prev = lastStates[target] {
            lastStates[target] = !prev
        }
    }

    private func press(_ el: AXUIElement, name: String) -> (ok: Bool, error: String?) {
        let err = AX.press(el)
        if err == .success { return (true, nil) }
        return (false, "AXPress '\(name)' failed (AXError \(err.rawValue))")
    }

    func discover(menu: String?) -> [[String: String]] {
        guard attach(), let appEl else { return [] }
        if let menu, !menu.isEmpty, let host = Tree.indexByID(Tree.walk(windows: AX.windows(appEl)))[menu] {
            _ = press(host.element, name: menu)
            Thread.sleep(forTimeInterval: 0.4)
        }
        let nodes = Tree.walk(windows: AX.windows(appEl))
        return nodes.compactMap { n in
            if n.id.isEmpty && n.label.isEmpty { return nil }
            if n.actions.isEmpty && n.id.isEmpty { return nil }
            var row: [String: String] = [
                "role": n.role,
                "id": n.id,
                "name": n.label,
                "enabled": n.enabled ? "true" : "false",
                "actions": n.actions.joined(separator: ","),
            ]
            // Geometry, so a probe can answer where on screen a thing is -
            // notably the slide surface, which has to be captured off the
            // screen because the tree carries its name and never its picture.
            if let f = n.frame {
                row["frame"] = "\(Int(f.origin.x)),\(Int(f.origin.y)),\(Int(f.size.width)),\(Int(f.size.height))"
            }
            return row
        }
    }
}
