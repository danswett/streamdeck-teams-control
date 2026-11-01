import XCTest
@testable import TeamsBridgeCore

/**
 * A missed reading must not end a meeting on its own (#52): ending one makes
 * the plugin hand the deck back, which resumes app-specific profile switching
 * in the middle of the call.
 */
final class MeetingPresenceTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_000)

    private func snapshot(meeting: Bool, running: Bool = true, title: String = "") -> MeetingSnapshot {
        var snap = MeetingSnapshot()
        snap.teamsRunning = running
        snap.inMeeting = meeting
        snap.windowTitle = title
        return snap
    }

    func testABriefMissKeepsReportingTheMeeting() {
        var presence = MeetingPresence()
        XCTAssertEqual(presence.observe(snapshot(meeting: true, title: "call"), at: t0).transition, .started)

        let missed = presence.observe(snapshot(meeting: false), at: t0.addingTimeInterval(1))
        XCTAssertTrue(missed.snapshot.inMeeting)
        XCTAssertEqual(missed.snapshot.windowTitle, "call")
        XCTAssertTrue(missed.confirming)
        XCTAssertEqual(missed.transition, .missed)

        let back = presence.observe(snapshot(meeting: true), at: t0.addingTimeInterval(1.5))
        XCTAssertEqual(back.transition, .recovered(misses: 1))
        XCTAssertFalse(back.confirming)
    }

    func testAMissIsConfirmedOnlyAfterEnoughReadingsAndTime() {
        var presence = MeetingPresence(missesToConfirm: 3, minimumSpan: 2)
        _ = presence.observe(snapshot(meeting: true), at: t0)

        // Three quick misses are not enough without the span.
        for offset in [0.5, 1.0, 1.5] {
            let reading = presence.observe(snapshot(meeting: false), at: t0.addingTimeInterval(offset))
            XCTAssertTrue(reading.snapshot.inMeeting)
            XCTAssertTrue(reading.confirming)
        }
        let ended = presence.observe(snapshot(meeting: false), at: t0.addingTimeInterval(2.5))
        XCTAssertFalse(ended.snapshot.inMeeting)
        XCTAssertFalse(ended.confirming)
        XCTAssertEqual(ended.transition, .ended(misses: 4, span: 2))

        // Further misses are ordinary idle readings, and a new meeting starts afresh.
        XCTAssertNil(presence.observe(snapshot(meeting: false), at: t0.addingTimeInterval(3)).transition)
        XCTAssertEqual(presence.observe(snapshot(meeting: true), at: t0.addingTimeInterval(4)).transition, .started)
    }

    func testTwoMissesOverALongSpanAreNotEnough() {
        var presence = MeetingPresence(missesToConfirm: 3, minimumSpan: 2)
        _ = presence.observe(snapshot(meeting: true), at: t0)
        _ = presence.observe(snapshot(meeting: false), at: t0.addingTimeInterval(1))
        XCTAssertTrue(presence.observe(snapshot(meeting: false), at: t0.addingTimeInterval(10)).snapshot.inMeeting)
    }

    func testTeamsQuittingEndsTheMeetingAtOnce() {
        var presence = MeetingPresence()
        _ = presence.observe(snapshot(meeting: true), at: t0)
        let quit = presence.observe(snapshot(meeting: false, running: false), at: t0.addingTimeInterval(0.1))
        XCTAssertFalse(quit.snapshot.inMeeting)
        XCTAssertFalse(quit.snapshot.teamsRunning)
        XCTAssertEqual(quit.transition, .ended(misses: 1, span: 0))
    }

    func testNoMeetingYetPassesThrough() {
        var presence = MeetingPresence()
        let idle = presence.observe(snapshot(meeting: false), at: t0)
        XCTAssertFalse(idle.snapshot.inMeeting)
        XCTAssertFalse(idle.confirming)
        XCTAssertNil(idle.transition)
    }
}
