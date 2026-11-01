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
    /// Last ink colour and thickness seen per tool, carried across the moments
    /// the tool button leaves the tree - which is whenever its flyout opens.
    private var lastInk: [String: String] = [:]
    /// Each drawing tool's palette, in the order its flyout lays it out. Only
    /// readable while that flyout is open, so remembered for the colour dial.
    private var lastPalette: [String: [String]] = [:]
    /// The deck's slide count, which a slide jump checks the filmstrip against.
    private var lastSlideTotal: Int?
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

        // Before the flyout check, as on Windows: the timer sits in its own
        // strip and stays readable while a flyout covers the toolbar, and a
        // reading that vanished for the length of a menu would reset the dial.
        let buttonNames = nodes.filter { $0.role == (kAXButtonRole as String) }.map(\.label)
        for (key, value) in TimerReading.context(buttonNames, config: config.timer) { snap.context[key] = value }

        snap.states["ppt-live"] = role != nil
        snap.states["ppt-presenting"] = role == "presenter"
        if let role { snap.context["ppt.role"] = role }

        if hidden {
            for (key, value) in lastStates where snap.states[key] == nil {
                snap.states[key] = value
            }
            snap.available = lastAvailable
            for (key, value) in lastInk { snap.context[key] = value }
            publishPalettes(into: &snap)
            return snap
        }

        readSlidePosition(nodes, into: &snap)
        // Kept when the counter is out of sight, as on Windows: it is what a
        // slide jump checks the strip against, and losing it would switch that
        // check off exactly when the toolbar auto-hides.
        if let total = snap.context["ppt.slides"].flatMap({ Int($0) }) { lastSlideTotal = total }
        publishPalettes(into: &snap)

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

            let node = resolve(spec, byID: byID, nodes: nodes)
            guard let node else {
                snap.available[key] = false
                lastAvailable[key] = false
                if snap.states[key] == nil, let prev = lastStates[key] { snap.states[key] = prev }
                if spec.colorFromName { readInkStyle(key, label: "", into: &snap) }
                continue
            }
            snap.available[key] = node.enabled
            lastAvailable[key] = node.enabled
            if spec.colorFromName { readInkStyle(key, label: node.label, into: &snap) }
            if spec.activeWhenPresentAutomationId == nil {
                applyNameState(spec, node: node, key: key, snap: &snap)
            }
        }
        return snap
    }

    private func publishPalettes(into snap: inout MeetingSnapshot) {
        for (key, palette) in lastPalette where !palette.isEmpty {
            snap.context["ppt.palette.\(key)"] = palette.joined(separator: "|")
        }
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
        let ppt = config.powerPointLive
        if byID[ppt.presenterMarkerAutomationId] != nil { return "presenter" }
        if byID[ppt.attendeeMarkerAutomationId] != nil { return "attendee" }
        if byID[ppt.rootAutomationId] != nil { return "attendee" }
        return nil
    }

    /// First capture group of a pattern against a label, or nil.
    static func capture(_ rx: NSRegularExpression?, from text: String, group: Int = 1) -> String? {
        guard let rx, !text.isEmpty else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let m = rx.firstMatch(in: text, options: [], range: range),
              m.numberOfRanges > group,
              let r = Range(m.range(at: group), in: text) else { return nil }
        return String(text[r])
    }

    /// "3 of 12" -> ("3", "12"). The counter's name is the only place
    /// PowerPoint Live publishes either number.
    static func slidePosition(from text: String, _ rx: NSRegularExpression?) -> (at: String, of: String)? {
        guard let at = capture(rx, from: text, group: 1),
              let of = capture(rx, from: text, group: 2) else { return nil }
        return (at, of)
    }

    /**
     * Where in the deck we are, read off the slide counter's label.
     *
     * PowerPoint Live publishes "3 of 12" as the name of a control and nowhere
     * else, so there is nothing to look it up by - only a pattern to recognise
     * it with, which is why the pattern is configurable.
     */
    private func readSlidePosition(_ nodes: [AXNode], into snap: inout MeetingSnapshot) {
        let rx = config.powerPointLive.slidePositionRegex
        for node in nodes where !node.label.isEmpty {
            guard let found = Self.slidePosition(from: node.label, rx) else { continue }
            snap.context["ppt.slide"] = found.at
            snap.context["ppt.slides"] = found.of
            return
        }
    }

    /**
     * Ink colour and thickness, read off a drawing tool's own name.
     *
     * The name reads like "Pen: Light blue, Thickness 3". Both are published
     * only there, so a key showing the pen's colour has nothing else to go on.
     * Carried forward when the tool leaves the tree, which it does whenever its
     * own flyout opens - the one moment the colour is most likely to change.
     */
    private func readInkStyle(_ key: String, label: String, into snap: inout MeetingSnapshot) {
        let ppt = config.powerPointLive
        for (suffix, rx) in [("color", ppt.toolColorRegex), ("thickness", ppt.toolThicknessRegex)] {
            let contextKey = "ppt.\(suffix).\(key)"
            if let value = Self.capture(rx, from: label) {
                snap.context[contextKey] = value
                lastInk[contextKey] = value
            } else if let held = lastInk[contextKey] {
                snap.context[contextKey] = held
            }
        }
    }

    /**
     * What the sidecar can see of Teams' windows, for the log when a meeting is
     * found or lost.
     *
     * Counts and flags only: window titles carry meeting and chat names, and
     * this ends up in logs that testers attach to public issues. It answers the
     * questions a background miss raises (#52) - did a window go missing, was
     * the meeting window minimized or behind another Teams window, did the
     * combined walk run out of room before reaching it.
     */
    public func diagnose() -> String {
        guard let app = findTeams() else { return "Teams is not running" }
        guard attach(), let appEl else { return "could not attach to Teams" }

        let wins = AX.windows(appEl)
        var parts = ["teamsActive=\(app.isActive)", "teamsHidden=\(app.isHidden)", "windows=\(wins.count)"]
        for (index, w) in wins.enumerated() {
            let ids = Tree.indexByID(Tree.walk(windows: [w]))
            let flags = [
                ("minimized", kAXMinimizedAttribute as String),
                ("main", kAXMainAttribute as String),
                ("focused", kAXFocusedAttribute as String),
            ].compactMap { name, attr in AX.bool(w, attr) == true ? name : nil }
            let markers = config.meetingMarkers.filter { ids[$0] != nil }.count
            parts.append(
                "[\(index): \(flags.isEmpty ? "-" : flags.joined(separator: ","))"
                + " ids=\(ids.count) probe=\(ids[config.meetingProbeAutomationId] != nil) markers=\(markers)]"
            )
        }
        parts.append("combinedWalk=\(Tree.walk(windows: wins).count)")
        return parts.joined(separator: " ")
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

    /**
     * How long a flyout marker on its own is allowed to stand for a meeting.
     *
     * Widening the markers is what keeps an open flyout from reading as
     * "meeting ended", and the cost of that is that a button named like one of
     * them somewhere else in Teams could make a window that is not a meeting
     * look like one. A popup can only be covering a toolbar that was there a
     * moment ago, so requiring one to have been seen recently gives the width
     * where it is needed and nowhere else.
     *
     * Generous, because it only decides what the keys display: a press clears
     * an open flyout and looks again regardless of how long it has been up.
     */
    private static let flyoutMarkerGrace: TimeInterval = 60

    /// When the meeting toolbar was last seen in the tree for certain.
    private var toolbarSeenAt: Date?

    private func pickMeetingWindow(wins: [AXUIElement], byID: [String: AXNode]) -> MeetingWindow? {
        let probe = config.meetingProbeAutomationId
        let recentlyInAMeeting = toolbarSeenAt.map { Date().timeIntervalSince($0) < Self.flyoutMarkerGrace } ?? false
        let markers = recentlyInAMeeting ? config.meetingMarkers : [probe]
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
                hasToolbar: ids[probe] != nil
            ))
        }
        if candidates.contains(where: { $0.hasToolbar }) { toolbarSeenAt = Date() }

        if let rich = candidates.first(where: { $0.rich }) { return rich }
        // Teams renders some popups as windows of their own, and one of those
        // can match on a flyout marker alone. The window still holding the
        // toolbar is the meeting; prefer it over the popup in front of it.
        if let withToolbar = candidates.first(where: { $0.hasToolbar }) { return withToolbar }
        if let named = candidates.first(where: { !$0.title.isEmpty && $0.title != "(untitled)" }) { return named }
        return candidates.first
    }

    /**
     * Finds the element a control describes.
     *
     * An identifier wherever there is one: it is locale-independent and unique.
     * Falling back to the accessible name is only for the "Stop presenting?"
     * confirmation, whose buttons carry no id - and a bare name match is not
     * enough there, because the toolbar button that raises that dialog reads
     * the same. Two things separate them, and both are required: the dialog's
     * button has no identifier at all, and it sits inside an element whose
     * class says so.
     */
    private func resolve(_ spec: ControlSpec, byID: [String: AXNode], nodes: [AXNode]) -> AXNode? {
        if !spec.automationId.isEmpty, let n = byID[spec.automationId] { return n }
        guard let rx = spec.nameRegex else { return nil }

        let named = nodes.filter { $0.id.isEmpty && spec.matches(rx, text: $0.label) && $0.enabled }
        guard let want = spec.withinClass, !want.isEmpty else { return named.first }
        return named.first { within(class: want, of: $0) } ?? nil
    }

    /// Whether an element, or anything it hangs off, carries this CSS class.
    private func within(class want: String, of node: AXNode) -> Bool {
        for el in [node.element] + AX.ancestors(node.element, limit: 8) {
            if AX.classList(el).localizedCaseInsensitiveContains(want) { return true }
        }
        return false
    }

    /**
     * Targets the plugin knows how to ask for and this sidecar cannot yet do.
     *
     * Named rather than left to fall through to "unknown target", which reads
     * like a mismatched build or a corrupted config and sends anyone debugging
     * it looking in the wrong place. Empty now that every Windows target has a
     * macOS implementation; kept so a future gap is reported the same way.
     */
    static let unimplementedTargets: [String: String] = [:]

    /// Targets handled by code rather than described in the control map, as on
    /// Windows: patterns inside a flyout, a filmstrip tile, and a timer with no ids.
    static let inkColorTarget = "ppt-ink-color"
    static let inkThicknessTarget = "ppt-ink-thickness"
    static let goToSlideTarget = "ppt-goto-slide"
    static let timerToggleTarget = "timer-toggle"
    static let timerResetTarget = "timer-reset"
    static let codedTargets: Set<String> = [
        inkColorTarget, inkThicknessTarget, goToSlideTarget, timerToggleTarget, timerResetTarget,
    ]

    public func invoke(target: String, arg: String?) -> (ok: Bool, error: String?) {
        if let what = Self.unimplementedTargets[target] {
            return (false, "\(what) is not implemented in the macOS sidecar yet")
        }
        guard Self.codedTargets.contains(target) || config.controls[target] != nil else {
            return (false, "unknown target '\(target)'")
        }
        guard attach(), appEl != nil else { return (false, "Teams is not running") }
        guard AX.isTrusted() else { return (false, "not trusted for Accessibility") }

        let captured = restoreFocus ? FocusRestore.capture(teamsPID: teamsPID) : nil
        defer { if restoreFocus { FocusRestore.restore(captured) } }
        switch target {
        case Self.goToSlideTarget: return goToSlide(arg)
        case Self.timerToggleTarget, Self.timerResetTarget: return driveTimer(reset: target == Self.timerResetTarget)
        case Self.inkColorTarget, Self.inkThicknessTarget: return adjustInk(thickness: target == Self.inkThicknessTarget, arg: arg)
        default: return invokeCore(target: target, arg: arg)
        }
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
        var arg = arg
        var cameraChoices: [CameraChoice]?
        if target == "camera-select" || target == "camera-swap" {
            guard let choices = CameraArguments.parse(arg, swap: target == "camera-swap") else {
                return (false, "choose valid webcams and video preferences in this button's settings")
            }
            cameraChoices = choices
            arg = choices[0].id
        }
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
            if let selfNode = resolve(spec, byID: byID, nodes: nodes) {
                return press(selfNode.element, name: target)
            }
            return (false, "could not find how to turn '\(target)' off")
        }

        if spec.menu == nil || spec.menu?.isEmpty == true {
            guard let node = resolve(spec, byID: byID, nodes: nodes) else { return (false, "control '\(target)' not found") }
            if !node.enabled { return (false, "control '\(target)' is disabled") }
            let result = press(node.element, name: target)
            if result.ok { rememberToggle(target) }
            return result
        }

        // Item already in the tree: raise-hand lives on the macOS toolbar, and
        // every reaction is right there whenever the flyout is already open.
        for id in [itemID, itemToggleID].compactMap({ $0 }) where !id.isEmpty {
            if let item = byID[id], item.enabled {
                if let cameraChoices {
                    return selectCamera(first: item, choices: cameraChoices, spec: spec, menuID: spec.menu)
                }
                let result = press(item.element, name: target)
                if result.ok {
                    lastStates[target] = !(lastStates[target] ?? false)
                    scheduleDismissal(anchor: item, hostID: spec.menu)
                }
                return result
            }
        }

        guard let menuID = spec.menu else { return (false, "menu '' not found") }

        // Teams rebuilds the toolbar after a flyout closes, and Chromium only
        // keeps an accessibility tree alive while something is using it - so
        // the button that was there a moment ago can be missing from the tree
        // while still plainly on screen. Waking it costs a few tens of
        // milliseconds and only happens on a path that has already failed,
        // which is cheaper than telling the user the press did not work.
        var host = byID[menuID]
        if host == nil {
            IO.err("menu '\(menuID)' not in the tree; waking accessibility and retrying")
            AX.bootstrap(appEl)
            Thread.sleep(forTimeInterval: Self.retrySettle)
            host = Tree.indexByID(Tree.walk(windows: AX.windows(appEl)))[menuID]
        }
        guard let host else { return (false, "menu '\(menuID)' not found") }
        if !host.enabled { return (false, "menu '\(menuID)' is disabled") }

        let opened = press(host.element, name: menuID)
        if !opened.ok { return (false, "could not open menu '\(menuID)'") }

        var item = findMenuItem(spec, itemID: itemID, itemToggleID: itemToggleID, within: 2.5)

        // If the toolbar is still showing, the menu never opened: Teams
        // swallows exactly one press on the trigger after a previous selection,
        // including one the user made by hand. Pressing it again opens it.
        if item == nil, Tree.containsAny(windows: AX.windows(appEl), ids: [config.meetingProbeAutomationId]) {
            IO.err("menu '\(menuID)' did not open; pressing it again")
            Thread.sleep(forTimeInterval: Self.retrySettle)
            let live = Tree.indexByID(Tree.walk(windows: AX.windows(appEl)))
            if press((live[menuID] ?? host).element, name: menuID).ok {
                item = findMenuItem(spec, itemID: itemID, itemToggleID: itemToggleID, within: 2.0)
            }
        }

        guard let item else {
            // The menu is open over the toolbar whether or not the item turned
            // up, so it has to come down either way.
            scheduleDismissal(anchor: nil, hostID: menuID)
            return (false, "menu item for '\(target)' not found")
        }

        if let cameraChoices {
            return selectCamera(first: item, choices: cameraChoices, spec: spec, menuID: menuID)
        }

        let plan = Self.menuPress(
            hasOffEntry: spec.menuItemOffRegex != nil,
            itemChecked: AX.checked(item.element),
            remembered: lastStates[target]
        )
        var chosen = item
        if plan.pressOff {
            guard let offRx = spec.menuItemOffRegex, let off = findItem(named: offRx, spec: spec, within: 0.8) else {
                scheduleDismissal(anchor: item, hostID: menuID)
                return (false, "'\(target)' is on, but its menu has no entry to turn it off")
            }
            chosen = off
        }
        let result = press(chosen.element, name: target)
        if result.ok { lastStates[target] = plan.nowOn }
        scheduleDismissal(anchor: chosen, hostID: menuID)
        return result
    }

    /// What a press on a flyout item should do, settled before anything is
    /// pressed.
    struct MenuPress: Equatable {
        /// Choose the group's "off" entry instead of the item itself.
        var pressOff: Bool
        /// What the control reads once the press has landed.
        var nowOn: Bool
    }

    /**
     * Decides what pressing a flyout item does, and what it leaves the key
     * showing.
     *
     * Background effects are a radio group. Choosing "Standard blur" while it
     * is already chosen changes nothing, so turning blur off means choosing the
     * group's "off" entry instead - the step this sidecar never took, which let
     * the key turn blur on and never off again (#16). Whether it is on is read
     * off the item while the flyout is open, the only time it can be; when
     * Teams does not say, the last press stands in for it.
     *
     * Anything else has no off entry and is simply pressed. Where it says
     * whether it is ticked, the press flips that; where it does not - a
     * reaction - it reads as on, as it always has.
     */
    static func menuPress(hasOffEntry: Bool, itemChecked: Bool?, remembered: Bool?) -> MenuPress {
        if hasOffEntry {
            let wasOn = itemChecked ?? remembered ?? false
            return MenuPress(pressOff: wasOn, nowOn: !wasOn)
        }
        return MenuPress(pressOff: false, nowOn: itemChecked.map { !$0 } ?? true)
    }

    /// Waits for an entry in the open flyout whose name matches. Used for a
    /// radio group's "off" entry, which sits in the same popup as the item
    /// just found, so it is normally there on the first look.
    private func findItem(named rx: NSRegularExpression, spec: ControlSpec, within timeout: TimeInterval) -> AXNode? {
        guard let appEl else { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            let nodes = Tree.walk(windows: AX.windows(appEl))
            if let found = nodes.first(where: { spec.matches(rx, text: $0.label) && $0.enabled }) { return found }
            if Date() >= deadline { return nil }
            Thread.sleep(forTimeInterval: 0.05)
        }
    }

    /// Pause before re-pressing a menu trigger Teams swallowed the first press
    /// on. Pressing again immediately reads as a double-press on the same
    /// control, which opens the menu and closes it again.
    private static let retrySettle: TimeInterval = 0.12

    /// Waits for a flyout to populate and hands back the item we came for.
    private func findMenuItem(
        _ spec: ControlSpec,
        itemID: String?,
        itemToggleID: String?,
        within timeout: TimeInterval
    ) -> AXNode? {
        guard let appEl else { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        var openedSubmenu = false
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
            let liveNodes = Tree.walk(windows: AX.windows(appEl))
            let live = Tree.indexByID(liveNodes)
            // Once only. A nested menu stays in the tree after it opens, so
            // pressing it on every pass would close it again.
            if let sub = spec.submenu, !sub.isEmpty, !openedSubmenu, let subNode = live[sub] {
                openedSubmenu = true
                _ = press(subNode.element, name: sub)
                Thread.sleep(forTimeInterval: 0.2)
                continue
            }
            for id in [itemID, itemToggleID].compactMap({ $0 }) where !id.isEmpty {
                if let found = live[id], found.enabled { return found }
            }
            if let rx = spec.menuItemRegex,
               let found = liveNodes.first(where: { spec.matches(rx, text: $0.label) && $0.enabled }) {
                return found
            }
        }
        return nil
    }

    /// Owes a dismissal to whoever sends the result. See runPendingCleanup.
    /// `until` names what proves the flyout is down; the meeting toolbar by default.
    private func scheduleDismissal(anchor: AXNode?, hostID: String?, until: [String]? = nil) {
        pendingCleanup = { [weak self] in
            self?.dismissFlyout(anchor: anchor, hostID: hostID, until: until)
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
    private func dismissFlyout(anchor: AXNode?, hostID: String?, until: [String]? = nil) {
        let budget = Date().addingTimeInterval(2.5)
        func remaining(_ want: TimeInterval) -> TimeInterval {
            min(want, max(0, budget.timeIntervalSinceNow))
        }
        func waitForToolbar(_ timeout: TimeInterval) -> Bool {
            self.waitForToolbar(timeout, ids: until)
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
    private func waitForToolbar(_ timeout: TimeInterval, ids: [String]? = nil) -> Bool {
        guard let appEl else { return false }
        let probe = ids ?? [config.meetingProbeAutomationId]
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if Tree.containsAny(windows: AX.windows(appEl), ids: probe) { return true }
            if Date() >= deadline { return false }
            Thread.sleep(forTimeInterval: 0.08)
        }
    }

    // MARK: - Coded targets: slide jump, timer, ink, cameras, thumbnails

    /// The meeting window and one walk of every Teams window, or nil outside a meeting.
    private func meetingView() -> (window: AXUIElement, nodes: [AXNode], byID: [String: AXNode])? {
        guard let appEl else { return nil }
        let wins = AX.windows(appEl)
        let nodes = Tree.walk(windows: wins)
        let byID = Tree.indexByID(nodes)
        guard let meeting = pickMeetingWindow(wins: wins, byID: byID) else { return nil }
        return (meeting.window, nodes, byID)
    }

    private static func matches(_ rx: NSRegularExpression?, _ text: String) -> Bool {
        guard let rx, !text.isEmpty else { return false }
        return rx.firstMatch(in: text, options: [], range: NSRange(text.startIndex..., in: text)) != nil
    }

    /// Whether a swatch, camera or tile is the chosen one: a radio reports it as
    /// AXValue, a list option as AXSelected. Nil when the element says neither.
    private func isSelected(_ el: AXUIElement) -> Bool? {
        AX.checked(el) ?? AX.bool(el, kAXSelectedAttribute as String)
    }

    /**
     * The presenter-view filmstrip, or the grid view, in deck order.
     *
     * Slide-sized children of an AXList. Frames are read only for elements with
     * a plausible role inside a list, because a frame costs two more calls into
     * Teams per element and the window holds thousands.
     */
    private func filmstripTiles(in window: AXUIElement) -> [Filmstrip.Tile<AXUIElement>] {
        let roles = Set(config.powerPointLive.filmstripItemRoles)
        var tiles: [Filmstrip.Tile<AXUIElement>] = []
        var stack: [(el: AXUIElement, depth: Int, inList: Bool, list: CGRect?)] = [(window, 0, false, nil)]
        var visited = 0
        while let (el, depth, inList, list) = stack.popLast() {
            visited += 1
            if visited > 12_000 { break }
            let role = AX.string(el, kAXRoleAttribute as String) ?? ""
            if inList, roles.contains(role), let frame = AX.frame(el),
               frame.width >= Filmstrip.minWidth, frame.height >= Filmstrip.minHeight {
                tiles.append(Filmstrip.Tile(
                    handle: el, frame: frame, selected: isSelected(el) ?? false,
                    name: AX.label(el), viewport: list
                ))
                continue
            }
            guard depth < 40 else { continue }
            let isList = role == (kAXListRole as String)
            let listFrame = isList ? AX.frame(el) : nil
            for child in AX.children(el).reversed() {
                stack.append((child, depth + 1, isList, listFrame))
            }
        }
        return Filmstrip.order(tiles)
    }

    /**
     * Goes straight to a slide by pressing its tile.
     *
     * The alternative is walking there one Next press at a time: slow over any
     * distance, and wrong on a deck with builds, because Next advances the
     * build rather than the slide.
     */
    private func goToSlide(_ arg: String?) -> (ok: Bool, error: String?) {
        guard let wanted = Int((arg ?? "").trimmingCharacters(in: .whitespaces)) else { return (false, "no slide number") }
        guard let view = meetingView() else { return (false, "not in a meeting") }
        // Stricter than Windows on purpose: which macOS elements make up the
        // strip is still a guess, so a jump is only made once the deck's own
        // count is known to check that guess against.
        guard let total = lastSlideTotal else { return (false, "the deck's slide count is not known yet") }
        let strip = filmstripTiles(in: view.window)
        switch Filmstrip.index(forSlide: wanted, stripCount: strip.count, reportedTotal: total) {
        case let .failure(error):
            return (false, error.message)
        case let .success(index):
            let err = AX.press(strip[index].handle)
            return err == .success ? (true, nil) : (false, "could not reach slide \(wanted): AXError \(err.rawValue)")
        }
    }

    /// Starts or pauses the timer, or puts it back to the top. The toggle is
    /// whichever of Pause and Resume is showing; see TimerReading.press.
    private func driveTimer(reset: Bool) -> (ok: Bool, error: String?) {
        guard let view = meetingView() else { return (false, "not in a meeting") }
        let buttons = view.nodes.filter { $0.role == (kAXButtonRole as String) && !$0.label.isEmpty }
        let found = TimerReading.match(buttons.map(\.label), config: config.timer)
        switch TimerReading.press(reset: reset, buttons: found) {
        case let .refuse(why):
            return (false, why)
        case let .press(label):
            guard let node = buttons.first(where: { $0.label == label }) else { return (false, "no timer running") }
            let err = AX.press(node.element)
            return err == .success ? (true, nil) : (false, "could not reach the timer: AXError \(err.rawValue)")
        }
    }

    /// Cursor and eraser carry no colour or thickness, so they open no flyout.
    private static let colourlessInkTools: Set<String> = ["ppt-cursor", "ppt-eraser"]

    /// The selected drawing tool. Its button leaves the tree while its flyout
    /// is open, so this is the selection that held when the flyout opened.
    private func selectedInkKey() -> String? {
        config.controls.filter { $0.value.colorFromName }.keys.sorted().first { lastStates[$0] == true }
    }

    private struct InkFlyout {
        var slider: AXNode?
        var swatches: [AXNode] = []
        var isEmpty: Bool { slider == nil && swatches.isEmpty }
    }

    /**
     * Everything an open drawing-tool flyout offers, in one walk: the thickness
     * slider and the colour swatches. The meeting window first, where the
     * flyout renders, and every window only if that finds nothing - other Teams
     * windows have radio buttons of their own.
     */
    private func readInkFlyout(meeting: AXUIElement?) -> InkFlyout {
        guard let appEl else { return InkFlyout() }
        let ppt = config.powerPointLive
        let scopes: [[AXUIElement]] = meeting.map { [[$0], AX.windows(appEl)] } ?? [AX.windows(appEl)]
        for scope in scopes {
            var out = InkFlyout()
            for node in Tree.walk(windows: scope) {
                let name = node.label.trimmingCharacters(in: .whitespaces)
                if node.role == (kAXSliderRole as String) {
                    if out.slider == nil, ppt.inkThicknessRegex == nil || Self.matches(ppt.inkThicknessRegex, name) {
                        out.slider = node
                    }
                    continue
                }
                guard node.role == (kAXRadioButtonRole as String), !name.isEmpty else { continue }
                // The pen's flyout carries the laser's arrow options too.
                if Self.matches(ppt.arrowOptionRegex, name) { continue }
                out.swatches.append(node)
            }
            if !out.isEmpty { return out }
        }
        return InkFlyout()
    }

    /// Opens the selected tool's options, changes one thing, and leaves the
    /// flyout to be closed once the result has been sent.
    private func adjustInk(thickness: Bool, arg: String?) -> (ok: Bool, error: String?) {
        guard let appEl, let view = meetingView() else { return (false, "not in a meeting") }
        guard let key = selectedInkKey(), let spec = config.controls[key], !spec.automationId.isEmpty,
              var tool = view.byID[spec.automationId] else { return (false, "no drawing tool is selected") }
        if Self.colourlessInkTools.contains(key) { return (false, "'\(key)' has no color or thickness to set") }

        let root = config.powerPointLive.rootAutomationId
        var flyout = InkFlyout()
        for attempt in 0..<3 where flyout.isEmpty {
            if attempt > 0 {
                // Re-found on every attempt: Teams rebuilds the slide-show
                // toolbar on demand, and pressing a stale element silently does
                // nothing. An open flyout unmounts the slide-show subtree, so a
                // missing root means one is already up - pressing the tool
                // again would shut it, so that case only waits and re-reads.
                let live = Tree.indexByID(Tree.walk(windows: AX.windows(appEl)))
                if live[root] == nil {
                    Thread.sleep(forTimeInterval: 0.15)
                    flyout = readInkFlyout(meeting: view.window)
                    continue
                }
                if let fresh = live[spec.automationId] { tool = fresh }
            }
            guard AX.press(tool.element) == .success else { return (false, "could not open the drawing tool's options") }
            for i in 0..<3 {
                Thread.sleep(forTimeInterval: i == 0 ? 0.12 : 0.09)
                flyout = readInkFlyout(meeting: view.window)
                if thickness ? flyout.slider != nil : !flyout.swatches.isEmpty { break }
            }
        }

        scheduleDismissal(anchor: flyout.slider ?? flyout.swatches.first, hostID: spec.automationId, until: [root])
        return thickness ? setInkThickness(flyout.slider, key: key, arg: arg) : stepInkColor(flyout, key: key, arg: arg, meeting: view.window)
    }

    private func setInkThickness(_ slider: AXNode?, key: String, arg: String?) -> (ok: Bool, error: String?) {
        guard let slider else { return (false, "this tool has no thickness") }
        let el = slider.element
        guard let current = AX.number(el, kAXValueAttribute as String),
              let low = AX.number(el, kAXMinValueAttribute as String),
              let high = AX.number(el, kAXMaxValueAttribute as String) else {
            return (false, "could not read the thickness slider")
        }
        if high <= low { return (false, "the thickness slider reports no range") }
        guard let wanted = InkAdjust.thickness(current: current, min: low, max: high, arg: arg) else { return (true, nil) }

        let set = AXUIElementSetAttributeValue(el, kAXValueAttribute as CFString, NSNumber(value: wanted))
        if set != .success {
            // Not every slider accepts a value; stepping it is what the arrow keys do.
            let action = (wanted > current ? kAXIncrementAction : kAXDecrementAction) as CFString
            for _ in 0..<Int(abs(wanted - current).rounded()) {
                guard AXUIElementPerformAction(el, action) == .success else {
                    return (false, "could not set thickness (AXError \(set.rawValue))")
                }
            }
        }
        lastInk["ppt.thickness.\(key)"] = String(Int(wanted))
        return (true, nil)
    }

    private func stepInkColor(_ flyout: InkFlyout, key: String, arg: String?, meeting: AXUIElement) -> (ok: Bool, error: String?) {
        let swatches = flyout.swatches
        guard !swatches.isEmpty else { return (false, "this tool has no colors") }
        let names = swatches.map { $0.label.trimmingCharacters(in: .whitespaces) }
        // The palette is per tool and the sets differ, so the open flyout is
        // always the authority on what the colours are.
        lastPalette[key] = names

        let selected = swatches.firstIndex { isSelected($0.element) == true }
        guard let wanted = InkAdjust.colorIndex(selected: selected, count: swatches.count, arg: arg) else { return (true, nil) }

        // A swatch can go stale between being read and being chosen - the
        // palette is rebuilt underneath this more often than it looks - so a
        // failure is retried against a freshly read flyout.
        var chosen = AX.press(swatches[wanted].element) == .success
        if !chosen {
            let again = readInkFlyout(meeting: meeting).swatches
            chosen = again.count == swatches.count && AX.press(again[wanted].element) == .success
        }
        guard chosen else { return (false, "could not select the color") }
        lastInk["ppt.color.\(key)"] = names[wanted]
        return (true, nil)
    }

    /// Waits for an element by DOM id, for the second camera of a swap.
    private func findByID(_ id: String, within timeout: TimeInterval) -> AXNode? {
        guard let appEl else { return nil }
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if let found = Tree.indexByID(Tree.walk(windows: AX.windows(appEl)))[id] { return found }
            if Date() >= deadline { return nil }
            Thread.sleep(forTimeInterval: 0.05)
        }
    }

    /**
     * Chooses a camera in the open video flyout, or swaps between two.
     *
     * A swap reads which camera Teams has selected rather than trusting the
     * last press, so a change made by hand - or by another key - never puts
     * the toggle out of step. The selection is then confirmed, because a press
     * that Teams ignored would otherwise read as success.
     */
    private func selectCamera(first: AXNode, choices: [CameraChoice], spec: ControlSpec, menuID: String?) -> (ok: Bool, error: String?) {
        if choices.contains(where: \.hasPreferences) {
            IO.err("warning: camera video preferences (mirror, soft focus, brightness) are not applied by the macOS sidecar yet")
        }
        var item = first
        defer { scheduleDismissal(anchor: item, hostID: menuID) }

        if choices.count == 2 {
            guard let second = findByID(choices[1].id, within: 1.5), item.enabled, second.enabled else {
                return (false, "both configured webcams must be available in Teams to swap")
            }
            guard let firstOn = isSelected(item.element), isSelected(second.element) != nil else {
                return (false, "Teams did not expose webcam selection")
            }
            if firstOn { item = second }
        }

        guard item.enabled else { return (false, "the configured webcam is not available right now") }
        guard let on = isSelected(item.element) else { return (false, "Teams did not expose webcam selection") }
        if on { return (true, nil) }
        guard AX.press(item.element) == .success else { return (false, "could not select the configured webcam") }

        let deadline = Date().addingTimeInterval(1.5)
        while Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
            let live = findByID(item.id, within: 0) ?? item
            if isSelected(live.element) == true { return (true, nil) }
        }
        return (false, "Teams did not confirm the webcam selection")
    }

    public struct Thumbnail {
        public var ok: Bool
        public var error: String?
        public var image: String?
        public var name: String?
        public var end = false
        public var frames: [String] = []
    }

    /**
     * Captures the slide being shown, or the one after it.
     *
     * "Current" is the live slide surface, so it matches what the room sees,
     * animations and all, with or without presenter view. "Next" can only come
     * from the presenter-view filmstrip, fully built, because a slide not yet
     * reached has no live render. Same split, and same messages, as Windows.
     */
    public func captureSlide(which: String, fade: Int, width: Int, height: Int) -> Thumbnail {
        func fail(_ error: String, name: String? = nil, end: Bool = false) -> Thumbnail {
            Thumbnail(ok: false, error: error, image: nil, name: name, end: end)
        }
        guard attach(), let view = meetingView() else { return fail("not in a meeting") }

        let rect: CGRect
        let name: String?
        let source: AXUIElement
        if which != "next" {
            guard let container = view.byID[config.powerPointLive.slideContainerAutomationId] else {
                return fail("no slide is being shown")
            }
            let images = Tree.walk(windows: [container.element], withFrames: true)
                .filter { $0.role == (kAXImageRole as String) }
                .compactMap(\.frame)
            guard let live = Filmstrip.liveSlide(among: images) else { return fail("no slide is being shown") }
            rect = live
            name = container.label
            source = container.element
        } else {
            let strip = filmstripTiles(in: view.window)
            guard !strip.isEmpty else { return fail("presenter view is closed") }
            guard let at = strip.firstIndex(where: \.selected) else { return fail("no slide selected") }
            // Running off the end is its own answer: the picture is now wrong
            // and has to go, where a failure should leave it and try again.
            if at + 1 >= strip.count {
                SlideCapture.forget(which)
                return fail("no next slide; this is the last one", end: true)
            }
            let target = strip[at + 1]
            guard let shown = showInStrip(target) else { return fail("scrolled out of view", name: target.name) }
            rect = shown
            name = target.name
            source = target.handle
        }

        // The window the slide element itself belongs to - a popped-out deck
        // is not in the meeting window - captured by its window-server id.
        let owner = AX.window(of: source) ?? view.window
        guard let windowFrame = AX.frame(owner) else { return fail("could not find the Teams window to capture") }
        let grabbed = SlideCapture.grab(
            key: "\(which):\(width)x\(height)", pid: teamsPID, windowID: AX.windowID(owner),
            windowFrame: windowFrame, rect: rect,
            border: which != "next", fadeFrames: fade, slotWidth: width, slotHeight: height
        )
        switch grabbed {
        case let .success(composed):
            return Thumbnail(ok: true, error: nil, image: composed.image, name: name, frames: composed.frames)
        case let .failure(failure):
            return fail(failure.message, name: which == "next" ? name : nil)
        }
    }

    /**
     * The visible part of a filmstrip tile, scrolling it into view if needed.
     *
     * Teams keeps the current slide at the strip's trailing edge, so the next
     * one is usually just out of sight. AXScrollToVisible only scrolls - it
     * never selects, which would move the presentation for everyone.
     */
    private func showInStrip(_ tile: Filmstrip.Tile<AXUIElement>) -> CGRect? {
        if let shown = Filmstrip.clip(tile.frame, to: tile.viewport ?? tile.frame) { return shown }
        let scroll = "AXScrollToVisible"
        guard AX.actions(tile.handle).contains(scroll),
              AXUIElementPerformAction(tile.handle, scroll as CFString) == .success else { return nil }
        // The scroll animates, so the first look back is usually mid-flight.
        for _ in 0..<5 {
            Thread.sleep(forTimeInterval: 0.12)
            guard let frame = AX.frame(tile.handle) else { continue }
            if let shown = Filmstrip.clip(frame, to: tile.viewport ?? frame) { return shown }
        }
        return nil
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
        let nodes = Tree.walk(windows: AX.windows(appEl), withFrames: true)
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
            // Whether an item is ticked, so a dump of the background-effects
            // menu shows what the blur key decides by. The Windows dump calls
            // the same thing "toggle".
            if let checked = AX.checked(n.element) {
                row["checked"] = checked ? "true" : "false"
            }
            // What the parity features decide by, so one capture on a Mac can
            // confirm them: filmstrip tiles are slide-sized children of an
            // AXList and the current one is selected; a camera menu item says
            // which camera is in use; the ink slider carries a numeric value.
            if let parent = AX.parent(n.element), let role = AX.string(parent, kAXRoleAttribute as String) {
                row["parentRole"] = role
            }
            if let selected = AX.bool(n.element, kAXSelectedAttribute as String) {
                row["selected"] = selected ? "true" : "false"
            }
            if let value = AX.number(n.element, kAXValueAttribute as String) {
                row["value"] = String(value)
            }
            return row
        }
    }
}
