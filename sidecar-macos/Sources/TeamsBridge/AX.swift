import AppKit
import ApplicationServices
import Foundation

enum AX {
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

    static func raise(_ el: AXUIElement) -> AXError {
        AXUIElementPerformAction(el, kAXRaiseAction as CFString)
    }

    static func identifier(_ el: AXUIElement) -> String? {
        string(el, "AXDOMIdentifier") ?? string(el, kAXIdentifierAttribute as String)
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

    static func isTrusted(prompt: Bool = false) -> Bool {
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
    static func walk(windows: [AXUIElement], maxDepth: Int = 40, maxNodes: Int = 12_000) -> [AXNode] {
        var nodes: [AXNode] = []
        var stack: [(AXUIElement, Int)] = windows.map { ($0, 0) }
        while let (el, depth) = stack.popLast() {
            if nodes.count >= maxNodes { break }
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
}
