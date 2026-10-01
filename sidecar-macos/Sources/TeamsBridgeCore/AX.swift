import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

public enum AX {
    static func value(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success else { return nil }
        return v
    }

    static func asElement(_ v: CFTypeRef) -> AXUIElement? {
        guard CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(v, to: AXUIElement.self)
    }

    static func asElements(_ v: CFTypeRef) -> [AXUIElement] {
        guard let arr = v as? NSArray else { return [] }
        return (0..<arr.count).compactMap { i in asElement(arr[i] as CFTypeRef) }
    }

    static func string(_ el: AXUIElement, _ name: String) -> String? {
        guard let v = value(el, name) else { return nil }
        if let s = v as? String, !s.isEmpty { return s }
        if let arr = v as? [String] { return arr.joined(separator: " ") }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    static func bool(_ el: AXUIElement, _ name: String) -> Bool? {
        value(el, name) as? Bool
    }

    static func children(_ el: AXUIElement) -> [AXUIElement] {
        guard let v = value(el, kAXChildrenAttribute as String) else { return [] }
        return asElements(v)
    }

    static func parent(_ el: AXUIElement) -> AXUIElement? {
        guard let v = value(el, kAXParentAttribute as String) else { return nil }
        return asElement(v)
    }

    /**
     * The chain of ancestors above an element, nearest first.
     *
     * Needed to dismiss a flyout. Teams' popups are closed by whatever sits
     * above their items - the popup container rather than any item in it - and
     * that container carries no identifier to look it up by, so the only way to
     * reach it is to climb from something inside.
     */
    static func ancestors(_ el: AXUIElement, limit: Int = 6) -> [AXUIElement] {
        var chain: [AXUIElement] = []
        var node = parent(el)
        while chain.count < limit, let current = node {
            chain.append(current)
            node = parent(current)
        }
        return chain
    }

    static func windows(_ app: AXUIElement) -> [AXUIElement] {
        if let v = value(app, kAXWindowsAttribute as String) {
            let wins = asElements(v)
            if !wins.isEmpty { return wins }
        }
        if let v = value(app, kAXFocusedWindowAttribute as String), let w = asElement(v) {
            return [w]
        }
        return []
    }

    static func actions(_ el: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(el, &names) == .success,
              let arr = names as? [String] else { return [] }
        return arr
    }

    static func press(_ el: AXUIElement) -> AXError {
        let names = actions(el)
        let preferred = ["AXPress", "AXConfirm", "AXToggle"]
        let action = preferred.first { names.contains($0) } ?? names.first
        guard let action else { return .actionUnsupported }
        return AXUIElementPerformAction(el, action as CFString)
    }

    /**
     * Asks an element to cancel itself, which is how a popup is dismissed
     * without pressing anything.
     *
     * This is the only dismissal that cannot have a side effect, so it is tried
     * first. Not every element offers it - the action is reported in
     * AXUIElementCopyActionNames like any other, and asking for one that is not
     * offered returns .actionUnsupported rather than doing something else.
     */
    static func cancel(_ el: AXUIElement) -> AXError {
        guard actions(el).contains(kAXCancelAction as String) else { return .actionUnsupported }
        return AXUIElementPerformAction(el, kAXCancelAction as CFString)
    }

    /// Escape's virtual key code, which is a hardware constant rather than a
    /// keyboard-layout one: it is 53 on every Mac and in every layout.
    private static let escapeKeyCode: CGKeyCode = 53

    /**
     * Presses Escape in a process, which is what a user does to close a flyout.
     *
     * Posted to the process rather than to the system event stream, so it
     * reaches Teams whether or not Teams is frontmost and can never land in
     * whatever the user is actually typing in. That matters here: the plugin
     * deliberately hands focus back after every press, so by the time a flyout
     * is being cleaned up the foreground app is usually not Teams.
     *
     * Needs the same Accessibility permission the rest of the sidecar needs,
     * and nothing more.
     */
    @discardableResult
    static func postEscape(pid: pid_t) -> Bool {
        guard pid > 0,
              let source = CGEventSource(stateID: .hidSystemState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: escapeKeyCode, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: escapeKeyCode, keyDown: false) else {
            return false
        }
        down.postToPid(pid)
        up.postToPid(pid)
        return true
    }

    static func raise(_ el: AXUIElement) -> AXError {
        AXUIElementPerformAction(el, kAXRaiseAction as CFString)
    }

    static func identifier(_ el: AXUIElement) -> String? {
        string(el, "AXDOMIdentifier") ?? string(el, kAXIdentifierAttribute as String)
    }

    /**
     * The CSS classes Chromium publishes for an element, as one string.
     *
     * The macOS counterpart of the Windows sidecar's ClassName, and the only
     * way to tell Teams' "Stop presenting?" confirmation from the toolbar
     * button that opens it, since neither carries a DOM id and both read
     * "Stop presenting".
     *
     * Read on demand rather than captured during a walk: it is one more
     * attribute fetch per element, and a walk already visits thousands.
     */
    static func classList(_ el: AXUIElement) -> String {
        string(el, "AXDOMClassList") ?? string(el, "AXDOMClass") ?? ""
    }

    static func label(_ el: AXUIElement) -> String {
        string(el, kAXDescriptionAttribute as String)
            ?? string(el, kAXTitleAttribute as String)
            ?? string(el, kAXHelpAttribute as String)
            ?? ""
    }

    static func enabled(_ el: AXUIElement) -> Bool {
        bool(el, kAXEnabledAttribute as String) ?? true
    }

    /**
     * Screen rectangle of an element, or nil if it has none.
     *
     * Needed to answer a question the Windows sidecar answers with a window
     * rectangle: where on screen is the slide? PowerPoint Live exposes no image
     * of a slide anywhere in the accessibility tree, only its name, so a
     * thumbnail has to be taken off the screen - and that needs a rectangle to
     * take it from.
     *
     * AXPosition and AXSize arrive as AXValue, not as plain numbers, so they
     * have to be unwrapped rather than cast.
     */
    static func frame(_ el: AXUIElement) -> CGRect? {
        guard let pv = value(el, kAXPositionAttribute as String),
              let sv = value(el, kAXSizeAttribute as String),
              CFGetTypeID(pv) == AXValueGetTypeID(),
              CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }

        var point = CGPoint.zero
        var size = CGSize.zero
        guard AXValueGetValue(unsafeBitCast(pv, to: AXValue.self), .cgPoint, &point),
              AXValueGetValue(unsafeBitCast(sv, to: AXValue.self), .cgSize, &size) else { return nil }

        return CGRect(origin: point, size: size)
    }

    public static func isTrusted(prompt: Bool = false) -> Bool {
        if prompt {
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
        }
        return AXIsProcessTrusted()
    }

    static func bootstrap(_ app: AXUIElement) {
        for attr in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
            _ = AXUIElementSetAttributeValue(app, attr as CFString, true as CFTypeRef)
        }
    }
}

struct AXNode {
    var element: AXUIElement
    var role: String
    var id: String
    var label: String
    var enabled: Bool
    var actions: [String]
    /// Screen rectangle, when the element reports one.
    var frame: CGRect?
}

enum Tree {
    /// Last time a truncated walk was reported, so a wedged tree does not fill
    /// the log with the same line at the poll interval.
    private static var lastCapWarning = Date.distantPast

    /**
     * Says so when a walk ran out of room.
     *
     * A truncated walk and a missing control are indistinguishable to
     * everything above here - both end as "control not found" - so the one
     * case that is a limit of this code rather than a change in Teams has to
     * announce itself, or it would be diagnosed as a selector problem.
     */
    private static func reportCap(_ visited: Int, _ maxNodes: Int) {
        guard Date().timeIntervalSince(lastCapWarning) > 30 else { return }
        lastCapWarning = Date()
        IO.err("warning: stopped walking the accessibility tree at \(visited) of a \(maxNodes)-node limit; a control past that point will read as missing")
    }

    static func walk(windows: [AXUIElement], maxDepth: Int = 40, maxNodes: Int = 12_000) -> [AXNode] {
        var nodes: [AXNode] = []
        var stack: [(AXUIElement, Int)] = windows.map { ($0, 0) }
        while let (el, depth) = stack.popLast() {
            if nodes.count >= maxNodes { reportCap(nodes.count, maxNodes); break }
            nodes.append(AXNode(
                element: el,
                role: AX.string(el, kAXRoleAttribute as String) ?? "",
                id: AX.identifier(el) ?? "",
                label: AX.label(el),
                enabled: AX.enabled(el),
                actions: AX.actions(el),
                frame: AX.frame(el)
            ))
            if depth < maxDepth {
                for child in AX.children(el).reversed() {
                    stack.append((child, depth + 1))
                }
            }
        }
        return nodes
    }

    static func indexByID(_ nodes: [AXNode]) -> [String: AXNode] {
        var out: [String: AXNode] = [:]
        for n in nodes where !n.id.isEmpty && out[n.id] == nil {
            out[n.id] = n
        }
        return out
    }

    /**
     * Whether any of these identifiers is in the tree, stopping at the first.
     *
     * The question "is the toolbar back yet" is asked repeatedly while waiting
     * for a flyout to close, and answering it with a full walk each time is the
     * most expensive thing on that path - a walk that finds nothing visits
     * every node in the window. Stopping on the first match makes the common
     * answer cheap; a negative still costs a full walk, which is why the wait
     * below polls slowly rather than tightly.
     */
    static func containsAny(
        windows: [AXUIElement],
        ids: [String],
        maxDepth: Int = 40,
        maxNodes: Int = 12_000
    ) -> Bool {
        guard !ids.isEmpty else { return false }
        let wanted = Set(ids.filter { !$0.isEmpty })
        guard !wanted.isEmpty else { return false }

        var visited = 0
        var stack: [(AXUIElement, Int)] = windows.map { ($0, 0) }
        while let (el, depth) = stack.popLast() {
            if visited >= maxNodes { reportCap(visited, maxNodes); break }
            visited += 1
            if let id = AX.identifier(el), wanted.contains(id) { return true }
            if depth < maxDepth {
                for child in AX.children(el).reversed() {
                    stack.append((child, depth + 1))
                }
            }
        }
        return false
    }
}
