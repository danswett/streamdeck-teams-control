import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// AXPress on Teams raises its window ~50–160ms later without activating the
/// app. Capture the previous app and AXRaise it after Teams has ordered front.
enum FocusRestore {
    struct Capture {
        var app: NSRunningApplication
        var teamsWasTop: Bool
    }

    static func capture(teamsPID: pid_t) -> Capture? {
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != teamsPID else { return nil }
        return Capture(app: app, teamsWasTop: isTeamsTop())
    }

    static func restore(_ capture: Capture?, timeoutMs: Int = 350) {
        guard let capture, !capture.teamsWasTop else { return }

        let deadline = Date().addingTimeInterval(Double(timeoutMs) / 1000.0)
        while Date() < deadline {
            if isTeamsTop() { break }
            Thread.sleep(forTimeInterval: 0.010)
        }

        let el = AXUIElementCreateApplication(capture.app.processIdentifier)
        var window: AXUIElement?
        if let v = AX.value(el, kAXFocusedWindowAttribute as String) { window = AX.asElement(v) }
        if window == nil, let v = AX.value(el, kAXMainWindowAttribute as String) { window = AX.asElement(v) }
        if window == nil, let v = AX.value(el, kAXWindowsAttribute as String) { window = AX.asElements(v).first }
        if let window {
            _ = AX.raise(window)
        }
        _ = capture.app.activate()
    }

    static func isTeamsOwner(_ name: String) -> Bool {
        name.localizedCaseInsensitiveContains("teams")
    }

    static func isTeamsTop() -> Bool {
        guard let raw = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) else {
            return false
        }
        for case let w as NSDictionary in (raw as NSArray) {
            let layer = (w[kCGWindowLayer] as? NSNumber)?.intValue ?? 0
            if layer != 0 { continue }
            let alpha = (w[kCGWindowAlpha] as? NSNumber)?.doubleValue ?? 1
            if alpha < 0.05 { continue }
            let bounds = w[kCGWindowBounds] as? [String: Any]
            let width = (bounds?["Width"] as? NSNumber)?.doubleValue ?? 0
            let height = (bounds?["Height"] as? NSNumber)?.doubleValue ?? 0
            if width < 80 || height < 80 { continue }
            let owner = w[kCGWindowOwnerName] as? String ?? ""
            return isTeamsOwner(owner)
        }
        return false
    }
}
