import Foundation

/// The arithmetic behind the ink dials, mirroring the Windows sidecar's
/// SetInkThickness and StepInkColor so both platforms answer a dial the same.
enum InkAdjust {
    /**
     * Where the thickness slider should go, or nil when it is already there.
     *
     * Absolute ("4") or relative ("+1", "-2"); a dial sends absolute because it
     * already knows the value and the user is watching a number. Rounded and
     * clamped to the slider's own range.
     */
    static func thickness(current: Double, min: Double, max: Double, arg: String?) -> Double? {
        guard max > min else { return nil }
        var wanted = current
        let text = (arg ?? "").trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("+") || text.hasPrefix("-") {
            if let delta = Int(text) { wanted = current + Double(delta) }
        } else if let absolute = Double(text) {
            wanted = absolute
        }
        wanted = Swift.min(Swift.max(wanted.rounded(), min), max)
        return abs(wanted - current) < 0.5 ? nil : wanted
    }

    /// The swatch a colour step lands on. Wraps, because a carousel that stops
    /// at the ends is not a carousel; an unreadable selection counts as the first.
    static func colorIndex(selected: Int?, count: Int, arg: String?) -> Int? {
        guard count > 0 else { return nil }
        let step = Int((arg ?? "").trimmingCharacters(in: .whitespaces)) ?? 1
        if step == 0 { return nil }
        let at = selected ?? 0
        return ((at + step) % count + count) % count
    }
}
