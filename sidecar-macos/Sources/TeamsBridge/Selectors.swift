import Foundation

struct ControlSpec {
    var automationId = ""
    var menu: String?
    var submenu: String?
    var menuItemAutomationId: String?
    var menuItemToggleAutomationId: String?
    var menuItemName: String?
    var menuItemOffName: String?
    var requiresRole: String?
    var activePattern: String?
    var inactivePattern: String?
    var activeWhenPresentAutomationId: String?
    var offAutomationId: String?
    var offName: String?
    var surface: String?
    var colorFromName = false
    var stateFromSelection = false
    var stateFromFullDescription = false

    var activeRegex: NSRegularExpression? { Self.compile(activePattern) }
    var inactiveRegex: NSRegularExpression? { Self.compile(inactivePattern) }
    var menuItemRegex: NSRegularExpression? { Self.compile(menuItemName) }
    var menuItemOffRegex: NSRegularExpression? { Self.compile(menuItemOffName) }
    var offRegex: NSRegularExpression? { Self.compile(offName) }

    static func compile(_ pattern: String?) -> NSRegularExpression? {
        guard let pattern, !pattern.isEmpty else { return nil }
        return try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    }

    func matches(_ regex: NSRegularExpression?, text: String) -> Bool {
        guard let regex, !text.isEmpty else { return false }
        let range = NSRange(text.startIndex..., in: text)
        return regex.firstMatch(in: text, options: [], range: range) != nil
    }
}

struct SelectorConfig {
    var version = 2
    var meetingProbeAutomationId = "microphone-button"
    var fullToolbarAutomationId = "callingButtons-showMoreBtn"
    var controls: [String: ControlSpec] = [:]
}

enum Defaults {
    static func config() -> SelectorConfig {
        var c = SelectorConfig()
        c.controls = [
            "mute": ControlSpec(
                automationId: "microphone-button",
                activePattern: #"unmute|Mikrofon wieder aktivieren|Stummschaltung aufheben"#,
                inactivePattern: #"^\s*mute\b|Stummschalten|Mikrofon deaktivieren"#
            ),
            "camera": ControlSpec(
                automationId: "video-button",
                activePattern: #"camera\s+off|Kamera ausschalten"#,
                inactivePattern: #"camera\s+on|Kamera einschalten"#
            ),
            "leave": ControlSpec(automationId: "hangup-button"),
            "share": ControlSpec(
                automationId: "share-button",
                activePattern: #"stop\s+(sharing|presenting)|Teilen beenden|Präsentation beenden"#,
                inactivePattern: #"^\s*share\b|^\s*Teilen\b"#
            ),
            "chat": ControlSpec(automationId: "chat-button"),
            "people": ControlSpec(automationId: "roster-button"),
            "hand": ControlSpec(
                menu: "reaction-menu-button",
                menuItemAutomationId: "raisehands-button"
            ),
            "react-like": ControlSpec(menu: "reaction-menu-button", menuItemAutomationId: "like-button"),
            "react-love": ControlSpec(menu: "reaction-menu-button", menuItemAutomationId: "heart-button"),
            "react-applause": ControlSpec(menu: "reaction-menu-button", menuItemAutomationId: "applause-button"),
            "react-laugh": ControlSpec(menu: "reaction-menu-button", menuItemAutomationId: "laugh-button"),
            "react-wow": ControlSpec(menu: "reaction-menu-button", menuItemAutomationId: "surprised-button"),
            "blur": ControlSpec(
                menu: "video-button-configure",
                menuItemName: #"^\s*standard\s+blur\s*$|Standardunschärfe|Standardblur"#,
                menuItemOffName: #"^\s*no\s+background\s+effect\s*$|Kein Hintergrundeffekt"#
            ),
            "ppt-prev": ControlSpec(automationId: "prevSlideButton", surface: "slideShow"),
            "ppt-next": ControlSpec(automationId: "nextSlideButton", surface: "slideShow"),
            "ppt-grid": ControlSpec(
                automationId: "gridViewToolbarButton",
                activeWhenPresentAutomationId: "fluent-grid-view",
                offName: #"^\s*close\s+grid\s+view\s*$"#,
                surface: "slideShow"
            ),
            "ppt-sync": ControlSpec(automationId: "syncToPresenterToolbarButton", surface: "slideShow"),
            "ppt-copilot": ControlSpec(automationId: "inkToExplainToolbarButton", surface: "slideShow"),
            "ppt-popout": ControlSpec(automationId: "popout-content-button"),
            "ppt-take-control": ControlSpec(automationId: "takeControlPptBtn", requiresRole: "attendee"),
            "ppt-high-contrast": ControlSpec(
                menu: "toolbarChangeViewButton",
                menuItemAutomationId: "toolbarHighContrastOverflowButton",
                surface: "slideShow"
            ),
            "ppt-translate": ControlSpec(
                menu: "toolbarChangeViewButton",
                submenu: "toolbarTranslateSlidesOverflowButton",
                menuItemAutomationId: "toolbarTranslateSlidesLanguageMenuItem-{arg}",
                requiresRole: "attendee",
                surface: "slideShow"
            ),
            "ppt-stop-presenting": ControlSpec(automationId: "stopPresentingPptBtn", requiresRole: "presenter"),
            "ppt-private-view": ControlSpec(
                automationId: "toggleEnablePrivateViewingButton",
                requiresRole: "presenter",
                activePattern: #"^\s*Prevent\b"#,
                inactivePattern: #"^\s*Allow\b"#,
                stateFromFullDescription: true
            ),
            "ppt-refresh": ControlSpec(
                automationId: "toolbarRefreshButton",
                requiresRole: "presenter",
                surface: "slideShow"
            ),
            "ppt-cursor": ControlSpec(
                automationId: "ink-tool-4",
                requiresRole: "presenter",
                surface: "slideShow",
                colorFromName: true,
                stateFromSelection: true
            ),
            "ppt-laser": ControlSpec(
                automationId: "ink-tool-3",
                requiresRole: "presenter",
                surface: "slideShow",
                colorFromName: true,
                stateFromSelection: true
            ),
            "ppt-pen": ControlSpec(
                automationId: "ink-tool-0",
                requiresRole: "presenter",
                surface: "slideShow",
                colorFromName: true,
                stateFromSelection: true
            ),
            "ppt-highlighter": ControlSpec(
                automationId: "ink-tool-1",
                requiresRole: "presenter",
                surface: "slideShow",
                colorFromName: true,
                stateFromSelection: true
            ),
            "ppt-eraser": ControlSpec(
                automationId: "ink-tool-2",
                requiresRole: "presenter",
                surface: "slideShow",
                colorFromName: true,
                stateFromSelection: true
            ),
            "ppt-copy-link": ControlSpec(
                menu: "toolbarShareButton",
                menuItemAutomationId: "toolbarShareButtonMenuListCopyLinkItem",
                requiresRole: "presenter",
                surface: "slideShow"
            ),
            "ppt-hide-presenter-view": ControlSpec(
                menu: "toolbarChangeViewButton",
                menuItemAutomationId: "toolbarPresenterUIHideOverflowButton",
                menuItemToggleAutomationId: "toolbarPresenterUIShowOverflowButton",
                requiresRole: "presenter",
                activeWhenPresentAutomationId: "notes-pane-parent",
                surface: "slideShow"
            ),
            "ppt-layout-content": ControlSpec(
                menu: "ppt-sharing-layout-toolbar",
                menuItemAutomationId: "pptContentOnlyButton",
                requiresRole: "presenter"
            ),
            "ppt-layout-cameo": ControlSpec(
                menu: "ppt-sharing-layout-toolbar",
                menuItemAutomationId: "pptCameoButton",
                requiresRole: "presenter"
            ),
        ]
        return c
    }

    static func overlay(_ base: SelectorConfig, json: String) -> SelectorConfig {
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return base
        }
        var cfg = base
        if let v = obj["meetingProbeAutomationId"] as? String, !v.isEmpty {
            cfg.meetingProbeAutomationId = v
        }
        if let v = obj["fullToolbarAutomationId"] as? String, !v.isEmpty {
            cfg.fullToolbarAutomationId = v
        }
        guard let controls = obj["controls"] as? [String: Any] else { return cfg }
        for (key, raw) in controls {
            guard let o = raw as? [String: Any] else { continue }
            var spec = cfg.controls[key] ?? ControlSpec()
            if let v = o["automationId"] as? String { spec.automationId = v }
            if let v = o["menu"] as? String { spec.menu = v }
            if let v = o["submenu"] as? String { spec.submenu = v }
            if let v = o["menuItemAutomationId"] as? String { spec.menuItemAutomationId = v }
            if let v = o["menuItemToggleAutomationId"] as? String { spec.menuItemToggleAutomationId = v }
            if let v = o["menuItemName"] as? String { spec.menuItemName = v }
            if let v = o["menuItemOffName"] as? String { spec.menuItemOffName = v }
            if let v = o["requiresRole"] as? String { spec.requiresRole = v }
            if let v = o["activePattern"] as? String { spec.activePattern = v }
            if let v = o["inactivePattern"] as? String { spec.inactivePattern = v }
            if let v = o["activeWhenPresentAutomationId"] as? String { spec.activeWhenPresentAutomationId = v }
            if let v = o["offAutomationId"] as? String { spec.offAutomationId = v }
            if let v = o["offName"] as? String { spec.offName = v }
            if let v = o["surface"] as? String { spec.surface = v }
            if let v = o["colorFromName"] as? Bool { spec.colorFromName = v }
            if let v = o["stateFromSelection"] as? Bool { spec.stateFromSelection = v }
            if let v = o["stateFromFullDescription"] as? Bool { spec.stateFromFullDescription = v }
            cfg.controls[key] = spec
        }
        return cfg
    }
}

func fillArg(_ template: String?, _ arg: String?, forRegex: Bool = false) -> String? {
    guard let template, template.contains("{arg}") else { return template }
    let value = arg ?? ""
    let inserted = forRegex ? NSRegularExpression.escapedPattern(for: value) : value
    return template.replacingOccurrences(of: "{arg}", with: inserted)
}
