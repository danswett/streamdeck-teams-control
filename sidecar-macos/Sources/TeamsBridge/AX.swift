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
                actions: AX.actions(el)
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
