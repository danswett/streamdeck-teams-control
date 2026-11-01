import Foundation

/**
 * Reads the meeting timer off the accessible names of the buttons around it.
 *
 * Kept apart from the tree walk so it can be tested without a meeting: the
 * input is just the button names, in tree order. Publishes the same context
 * keys as the Windows sidecar's ReadTimer, which the timer dial reads:
 *
 *   timer.remaining   whole seconds left
 *   timer.running     "1" while counting down, "0" while paused
 *   timer.expired     "1" once time is up
 */
enum TimerReading {
    struct Buttons {
        var controls: String?
        var pause: String?
        var resume: String?
        var reset: String?
        var cancel: String?
    }

    /// The first button matching each timer pattern.
    static func match(_ names: [String], config: TimerConfig) -> Buttons {
        let controls = ControlSpec.compile(config.controlsPattern)
        let pause = ControlSpec.compile(config.pausePattern)
        let resume = ControlSpec.compile(config.resumePattern)
        let reset = ControlSpec.compile(config.resetPattern)
        let cancel = ControlSpec.compile(config.cancelPattern)

        var found = Buttons()
        for name in names where !name.isEmpty {
            if found.controls == nil, matches(controls, name) { found.controls = name }
            if found.pause == nil, matches(pause, name) { found.pause = name }
            if found.resume == nil, matches(resume, name) { found.resume = name }
            if found.reset == nil, matches(reset, name) { found.reset = name }
            if found.cancel == nil, matches(cancel, name) { found.cancel = name }
        }
        return found
    }

    /// The timer's context keys, or none when no timer is up.
    static func context(_ names: [String], config: TimerConfig) -> [String: String] {
        let found = match(names, config: config)
        guard let controls = found.controls, let seconds = remaining(controls, config: config) else { return [:] }

        var out = ["timer.remaining": String(seconds)]
        // Once time is up Teams swaps the toggle for "Cancel timer for
        // everyone" and pins the name at "0 sec remaining", so only the fact
        // of the overtime is readable.
        if found.cancel != nil {
            out["timer.expired"] = "1"
            out["timer.running"] = "1"
            return out
        }
        out["timer.running"] = found.pause != nil ? "1" : "0"
        return out
    }

    /// Total seconds in "4 min, 57 sec remaining", or nil.
    static func remaining(_ name: String, config: TimerConfig) -> Int? {
        let hours = number(in: name, config.hoursPattern)
        let minutes = number(in: name, config.minutesPattern)
        let seconds = number(in: name, config.secondsPattern)
        if hours == nil, minutes == nil, seconds == nil { return nil }
        return (hours ?? 0) * 3600 + (minutes ?? 0) * 60 + (seconds ?? 0)
    }

    /**
     * Which button a timer press should reach, or the reason it should not.
     *
     * The toggle is whichever of Pause and Resume is showing. Once time is up
     * neither is, and the only button left ends the timer for everyone - not
     * what a press meaning "pause" should ever do - so that is refused.
     */
    enum Press: Equatable {
        case press(String)
        case refuse(String)
    }

    static func press(reset: Bool, buttons: Buttons) -> Press {
        if reset {
            return buttons.reset.map(Press.press) ?? .refuse("no timer running")
        }
        if let toggle = buttons.pause ?? buttons.resume { return .press(toggle) }
        return .refuse(buttons.cancel != nil ? "time is up; hold to reset" : "no timer running")
    }

    private static func matches(_ rx: NSRegularExpression?, _ text: String) -> Bool {
        guard let rx else { return false }
        return rx.firstMatch(in: text, options: [], range: NSRange(text.startIndex..., in: text)) != nil
    }

    private static func number(in text: String, _ pattern: String) -> Int? {
        guard let rx = ControlSpec.compile(pattern) else { return nil }
        return TeamsClient.capture(rx, from: text).flatMap { Int($0) }
    }
}
