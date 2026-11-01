import Foundation

/**
 * Decides when a meeting that stops showing up in the accessibility tree has
 * actually ended.
 *
 * Ending a meeting is the one reading with a visible cost: the plugin hands the
 * deck back, and Stream Deck resumes app-specific profile switching. A single
 * missed reading - the tree being rebuilt as Teams loses focus, a window being
 * reordered - is not worth that, so a miss is re-checked quickly and only
 * reported once it has held for several readings over a minimum span. Until
 * then the last in-meeting reading keeps standing (#52).
 *
 * Teams quitting is certain and is reported at once.
 */
public struct MeetingPresence {
    public enum Transition: Equatable {
        case started
        /// The first reading without the meeting; it is being re-checked.
        case missed
        /// The meeting came back before the miss was confirmed.
        case recovered(misses: Int)
        case ended(misses: Int, span: TimeInterval)
    }

    public struct Reading {
        /// What to report: the last in-meeting reading while a miss is unconfirmed.
        public var snapshot: MeetingSnapshot
        /// Whether a miss is being re-checked, so the next reading should come soon.
        public var confirming: Bool
        public var transition: Transition?
    }

    public let missesToConfirm: Int
    public let minimumSpan: TimeInterval

    private var held: MeetingSnapshot?
    private var misses = 0
    private var firstMissAt: Date?

    public init(missesToConfirm: Int = 3, minimumSpan: TimeInterval = 2.0) {
        self.missesToConfirm = max(1, missesToConfirm)
        self.minimumSpan = max(0, minimumSpan)
    }

    public mutating func observe(_ snap: MeetingSnapshot, at now: Date = Date()) -> Reading {
        if snap.inMeeting {
            let transition: Transition? = held == nil ? .started : (misses > 0 ? .recovered(misses: misses) : nil)
            held = snap
            reset()
            return Reading(snapshot: snap, confirming: false, transition: transition)
        }
        guard let last = held else { return Reading(snapshot: snap, confirming: false, transition: nil) }

        misses += 1
        let start = firstMissAt ?? now
        firstMissAt = start
        let span = now.timeIntervalSince(start)
        if !snap.teamsRunning || (misses >= missesToConfirm && span >= minimumSpan) {
            let ended = Transition.ended(misses: misses, span: span)
            held = nil
            reset()
            return Reading(snapshot: snap, confirming: false, transition: ended)
        }
        return Reading(snapshot: last, confirming: true, transition: misses == 1 ? .missed : nil)
    }

    private mutating func reset() {
        misses = 0
        firstMissAt = nil
    }
}
