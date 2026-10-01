import AppKit
import ApplicationServices
import Foundation

public struct MeetingSnapshot {
    public var teamsRunning = false
    public var inMeeting = false
    public var windowTitle = ""
    public var states: [String: Bool] = [:]
    public var available: [String: Bool] = [:]
    public var context: [String: String] = [:]

    public init() {}

    public func fingerprint() -> String {
        var s = "\(teamsRunning)|\(inMeeting)|"
        for k in states.keys.sorted() { s += "\(k)=\(states[k] ?? false);" }
        s += "|"
        for k in available.keys.sorted() { s += "\(k)=\(available[k] ?? false);" }
        s += "|"
        for k in context.keys.sorted() { s += "\(k)=\(context[k] ?? "");" }
        return s
    }
}

public final class TeamsClient {
    private let config: SelectorConfig
    private let restoreFocus: Bool
    private var lastStates: [String: Bool] = [:]
    private var lastAvailable: [String: Bool] = [:]
    private var lastRole: String?
    private var appEl: AXUIElement?
    private var teamsPID: pid_t = 0

    /// Dismissal owed by the last invoke, run once its result has been sent.
    private var pendingCleanup: (() -> Void)?

    public init(config: SelectorConfig, restoreFocus: Bool) {
        self.config = config
        self.restoreFocus = restoreFocus
    }

    public func findTeams() -> NSRunningApplication? {
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

    public func getSnapshot() -> MeetingSnapshot {
        var snap = MeetingSnapshot()
        snap.teamsRunning = findTeams() != nil
        guard snap.teamsRunning, attach(), let appEl else { return snap }

        let wins = AX.windows(appEl)
        let nodes = Tree.walk(windows: wins)
        let byID = Tree.indexByID(nodes)

        guard let meeting = pickMeetingWindow(wins: wins, byID: byID) else { return snap }
        snap.inMeeting = true
        snap.windowTitle = AX.string(meeting.window, kAXTitleAttribute as String) ?? ""

        // A flyout takes the meeting toolbar out of the tree with it, so every
        // control below would read as missing and every key would blank for as
        // long as a menu sits open - including the moment between choosing a
        // reaction and the flyout closing. Carry the last reading forward
        // instead: the controls have not gone anywhere, only the view of them.
        let hidden = !isToolbarVisible(byID)
        let role = hidden ? lastRole : readPPTRole(byID: byID)
        if !hidden { lastRole = role }

        snap.states["ppt-live"] = role != nil
        snap.states["ppt-presenting"] = role == "presenter"
        if let role { snap.context["ppt.role"] = role }

        if hidden {
            for (key, value) in lastStates where snap.states[key] == nil {
                snap.states[key] = value
            }
            snap.available = lastAvailable
            return snap
        }

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
        var hasToolbar: Bool
    }

    /// Whether the meeting toolbar itself is reachable, i.e. no flyout is
    /// covering it. The probe is a toolbar button, so its absence from a window
    /// that is otherwise plainly a meeting means a popup is up.
    private func isToolbarVisible(_ byID: [String: AXNode]) -> Bool {
        byID[config.meetingProbeAutomationId] != nil
    }

    private func pickMeetingWindow(wins: [AXUIElement], byID: [String: AXNode]) -> MeetingWindow? {
        let markers = config.meetingMarkers
        guard markers.contains(where: { byID[$0] != nil }) else { return nil }

        var candidates: [MeetingWindow] = []
        for w in wins {
            let title = AX.string(w, kAXTitleAttribute as String) ?? ""
            if title.localizedCaseInsensitiveContains("| Calendar |") { continue }
            let sub = Tree.walk(windows: [w], maxNodes: 4000)
            let ids = Tree.indexByID(sub)
            guard markers.contains(where: { ids[$0] != nil }) else { continue }
            candidates.append(MeetingWindow(
                window: w,
                title: title,
                rich: ids[config.fullToolbarAutomationId] != nil,
                hasToolbar: isToolbarVisible(ids)
            ))
        }
        if let rich = candidates.first(where: { $0.rich }) { return rich }
        // Teams renders some popups as windows of their own, and one of those
        // can match on a flyout marker alone. The window still holding the
        // toolbar is the meeting; prefer it over the popup in front of it.
        if let withToolbar = candidates.first(where: { $0.hasToolbar }) { return withToolbar }
        if let named = candidates.first(where: { !$0.title.isEmpty && $0.title != "(untitled)" }) { return named }
        return candidates.first
    }

    private func resolve(_ spec: ControlSpec, byID: [String: AXNode]) -> AXNode? {
        if !spec.automationId.isEmpty, let n = byID[spec.automationId] { return n }
        return nil
    }

    public func invoke(target: String, arg: String?) -> (ok: Bool, error: String?) {
        guard config.controls[target] != nil else { return (false, "unknown target '\(target)'") }
        guard attach(), appEl != nil else { return (false, "Teams is not running") }
        guard AX.isTrusted() else { return (false, "not trusted for Accessibility") }

        let captured = restoreFocus ? FocusRestore.capture(teamsPID: teamsPID) : nil
        defer { if restoreFocus { FocusRestore.restore(captured) } }
        return invokeCore(target: target, arg: arg)
    }

    /**
     * Closes a flyout the last invoke left open.
     *
     * Deliberately not part of invoke. Choosing an item through accessibility
     * fires the item's handler but not the click outside that normally takes
     * the popup down, so one has to be closed on nearly every menu press - and
     * doing it before answering would add that wait to how long the key sits
     * lit. The caller sends the result first and cleans up second.
     *
     * Carries its own focus guard: by the time this runs invoke has already
     * handed the foreground back, and pressing anything in Teams raises Teams.
     */
    public func runPendingCleanup() {
        guard let work = pendingCleanup else { return }
        pendingCleanup = nil
        guard attach() else { return }

        let captured = restoreFocus ? FocusRestore.capture(teamsPID: teamsPID) : nil
        work()
        if restoreFocus { FocusRestore.restore(captured) }
    }

    private func invokeCore(target: String, arg: String?) -> (ok: Bool, error: String?) {
        guard let spec = config.controls[target], let appEl else { return (false, "not in a meeting") }
        var wins = AX.windows(appEl)
        var nodes = Tree.walk(windows: wins)
        var byID = Tree.indexByID(nodes)

        let itemID = fillArg(spec.menuItemAutomationId, arg)
        let itemToggleID = fillArg(spec.menuItemToggleAutomationId, arg)

        // A flyout left open - by the press before this one, or by the user -
        // takes the meeting toolbar out of the accessibility tree with it, so
        // every control outside the popup reads as missing and the key does
        // nothing. Clear it before going looking.
        //
        // Unless what we came for is in the open flyout already: a second
        // reaction is one press away, and closing the popup only to re-open it
        // would be slower and would flash it off the screen for no reason.
        if !isToolbarVisible(byID),
           !canReachTarget(spec, itemID: itemID, itemToggleID: itemToggleID, byID: byID),
           let anchor = openFlyoutAnchor(byID) {
            IO.err("recovering: a Teams flyout was hiding the meeting toolbar")
            dismissFlyout(anchor: anchor, hostID: nil)
            wins = AX.windows(appEl)
            nodes = Tree.walk(windows: wins)
            byID = Tree.indexByID(nodes)
        }

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

        if spec.menu == nil || spec.menu?.isEmpty == true {
            guard let node = resolve(spec, byID: byID) else { return (false, "control '\(target)' not found") }
            if !node.enabled { return (false, "control '\(target)' is disabled") }
            let result = press(node.element, name: target)
            if result.ok { rememberToggle(target) }
            return result
        }

        // Item already in the tree: raise-hand lives on the macOS toolbar, and
        // every reaction is right there whenever the flyout is already open.
        for id in [itemID, itemToggleID].compactMap({ $0 }) where !id.isEmpty {
            if let item = byID[id], item.enabled {
                let result = press(item.element, name: target)
                if result.ok {
                    lastStates[target] = !(lastStates[target] ?? false)
                    scheduleDismissal(anchor: item, hostID: spec.menu)
                }
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
            // The menu is open over the toolbar whether or not the item turned
            // up, so it has to come down either way.
            scheduleDismissal(anchor: nil, hostID: menuID)
            return (false, "menu item for '\(target)' not found")
        }

        if let offRx = spec.menuItemOffRegex, spec.matches(spec.menuItemRegex, text: item.label) {
            // Radio: if already on, click the off item instead. We don't know
            // "already on" cheaply; press the requested item.
            _ = offRx
        }
        let result = press(item.element, name: target)
        if result.ok { lastStates[target] = true }
        scheduleDismissal(anchor: item, hostID: menuID)
        return result
    }

    /// Owes a dismissal to whoever sends the result. See runPendingCleanup.
    private func scheduleDismissal(anchor: AXNode?, hostID: String?) {
        pendingCleanup = { [weak self] in
            self?.dismissFlyout(anchor: anchor, hostID: hostID)
        }
    }

    /**
     * Identifiers that would let a press go ahead on the tree as it stands.
     *
     * Pulled out as a pure list so the rule can be checked without a meeting:
     * a menu-backed control is reachable through its item, a toolbar control
     * only through itself. That distinction is the whole of the fast path for
     * a second reaction, which is reachable precisely because the flyout
     * holding it is still open.
     */
    static func reachableIDs(_ spec: ControlSpec, itemID: String?, itemToggleID: String?) -> [String] {
        if spec.menu == nil || spec.menu?.isEmpty == true {
            return spec.automationId.isEmpty ? [] : [spec.automationId]
        }
        return [itemID, itemToggleID].compactMap { $0 }.filter { !$0.isEmpty }
    }

    /**
     * Whether the control this press is for can be reached as the tree stands.
     *
     * Asked only when the toolbar is missing, to decide between pressing
     * something that is already in front of us and closing a flyout first.
     */
    private func canReachTarget(
        _ spec: ControlSpec,
        itemID: String?,
        itemToggleID: String?,
        byID: [String: AXNode]
    ) -> Bool {
        Self.reachableIDs(spec, itemID: itemID, itemToggleID: itemToggleID)
            .contains { byID[$0]?.enabled == true }
    }

    /**
     * Something belonging to an open flyout, to climb out of when closing it.
     *
     * Only identifiers the control map already names count. A modal Teams asks
     * the user to answer - "Stop presenting?" - must never be dismissed on
     * their behalf, and recognising popups by their items rather than by their
     * shape is what keeps this away from one. It is the same restraint the
     * Windows sidecar spells out as refusing to dismiss a 'ui-dialog'.
     */
    private func openFlyoutAnchor(_ byID: [String: AXNode]) -> AXNode? {
        for id in config.flyoutItemAutomationIds {
            if let node = byID[id] { return node }
        }
        return nil
    }

    /**
     * Takes an open Teams flyout down.
     *
     * Invoking a flyout item through accessibility fires the item's handler but
     * not the focus change or outside click that normally dismisses the popup,
     * so the flyout stays open - and while it is open Teams removes the whole
     * meeting toolbar from the accessibility tree, wedging every later press.
     * The Windows sidecar has carried a DismissFlyout for this since the first
     * release; the macOS port shipped without one, which is #7's second round
     * of tester reports: a reaction worked, the flyout stayed up, and nothing
     * worked again until it was closed by hand.
     *
     * A ladder, ordered by how much damage a rung could do if the popup has
     * actually gone already, cheapest and safest first. Each rung is followed
     * by a wait for the toolbar to come back, which is the only reliable signal
     * that the popup is down.
     *
     * Bounded as a whole. Every rung that can fail is one that walks the window
     * to find out, and a press that queues behind a cleanup still running is a
     * key that does nothing for as long as it takes - so the ladder stops when
     * the budget is gone and says so, rather than trying everything it knows.
     */
    private func dismissFlyout(anchor: AXNode?, hostID: String?) {
        let budget = Date().addingTimeInterval(2.5)
        func remaining(_ want: TimeInterval) -> TimeInterval {
            min(want, max(0, budget.timeIntervalSinceNow))
        }

        // The press may have closed it. Acting now would re-open what is
        // already closing, so this wait comes before anything else. Shorter
        // than the Windows sidecar's equivalent on purpose: that one posts a
        // real click, which usually dismisses the popup by itself, while an
        // accessibility press here almost never does.
        if waitForToolbar(0.35) { return }

        // Side-effect free: ask the popup to cancel itself, the way Escape
        // would, through whatever above the item accepts the action.
        if let anchor {
            for el in [anchor.element] + AX.ancestors(anchor.element) {
                if AX.cancel(el) == .success, waitForToolbar(remaining(0.35)) {
                    IO.err("flyout dismissed by AXCancel")
                    return
                }
            }
        }

        // What a user does. Posted to Teams rather than to the system, so it
        // cannot land anywhere else even though Teams is usually not frontmost
        // by now.
        if AX.postEscape(pid: teamsPID), waitForToolbar(remaining(0.6)) {
            IO.err("flyout dismissed by Escape")
            return
        }

        // Pressing the menu button again toggles the popup shut. Re-found
        // rather than reused: choosing an item re-renders the surface the menu
        // hangs off, which leaves anything captured before the press stale.
        //
        // First rung that could re-open a popup already on its way out, which
        // is why it sits behind more than a second of waiting.
        if let hostID, !hostID.isEmpty, let appEl, budget.timeIntervalSinceNow > 0 {
            let live = Tree.indexByID(Tree.walk(windows: AX.windows(appEl)))
            if let host = live[hostID] {
                _ = AX.press(host.element)
                if waitForToolbar(remaining(0.6)) {
                    IO.err("flyout dismissed by re-pressing '\(hostID)'")
                    return
                }
            }
        }

        // Last: the popup's own container, which is what a click outside the
        // flyout would reach. Pressing ancestors is the rung most able to hit
        // something that acts, so it goes after everything that cannot - and
        // only where AXPress is actually offered, since AX.press otherwise
        // falls back to whatever action the element happens to list first.
        if let anchor {
            for el in AX.ancestors(anchor.element) {
                guard budget.timeIntervalSinceNow > 0 else { break }
                guard AX.actions(el).contains("AXPress"), AX.press(el) == .success else { continue }
                if waitForToolbar(remaining(0.4)) {
                    IO.err("flyout dismissed by pressing its container")
                    return
                }
            }
        }

        IO.err("warning: could not dismiss a Teams flyout; the meeting toolbar may stay out of reach until it is closed by hand")
    }

    /**
     * Waits for the meeting toolbar to come back into the tree.
     *
     * Polled slowly on purpose. A negative answer costs a walk of the whole
     * window - there is nothing to stop early on - so asking more often only
     * buys more full walks, the same measurement the Windows sidecar records
     * for its own dismissal wait.
     */
    private func waitForToolbar(_ timeout: TimeInterval) -> Bool {
        guard let appEl else { return false }
        let probe = [config.meetingProbeAutomationId]
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if Tree.containsAny(windows: AX.windows(appEl), ids: probe) { return true }
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: 0.08)
        }
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

    public func discover(menu: String?) -> [[String: String]] {
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
