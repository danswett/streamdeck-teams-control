import XCTest
@testable import TeamsBridgeCore

/**
 * Covers the rules that decide what the sidecar does while a Teams flyout is
 * open. All of it is reachable without a Mac in a meeting, which is the point:
 * the bug these guard against (#7) was reported twice by testers before anyone
 * could reproduce it, and the fix cannot be re-proved on this machine either.
 *
 * What a flyout actually does: Teams removes the whole meeting toolbar from
 * the accessibility tree while a popup is up, leaving only the popup's own
 * buttons.
 */
final class FlyoutRecoveryTests: XCTestCase {
    private func reaction() -> ControlSpec {
        Defaults.config().controls["react-love"]!
    }

    // MARK: - A meeting is still a meeting while a menu is open

    func testAnOpenFlyoutStillLooksLikeAMeeting() {
        // The toolbar is gone and only the reactions flyout is left. Probing
        // for the mic button alone answered "not in a meeting" here, so every
        // key - including the reaction sitting in the open flyout - refused.
        let markers = Defaults.config().meetingMarkers
        XCTAssertTrue(markers.contains("like-button"))
        XCTAssertTrue(markers.contains("raisehands-button"))
    }

    func testTheToolbarProbeIsAlwaysAMarker() {
        XCTAssertEqual(Defaults.config().meetingMarkers.first, "microphone-button")
    }

    func testOverridingTheProbeKeepsItAmongTheMarkers() {
        // Narrowing the definition of a meeting is a fair thing to configure.
        // Leaving it unable to recognise the window it was just pointed at is
        // not, so the probe is added whether or not the marker list mentions it.
        let json = """
        {"meetingProbeAutomationId": "mic-2", "meetingMarkerAutomationIds": ["hangup-button"]}
        """
        let cfg = Defaults.overlay(Defaults.config(), json: json)
        XCTAssertEqual(cfg.meetingMarkers, ["mic-2", "hangup-button"])
    }

    func testTheMarkersCanBeReplacedByAnOverlay() {
        let json = #"{"meetingMarkerAutomationIds": ["hangup-button", "like-button"]}"#
        let cfg = Defaults.overlay(Defaults.config(), json: json)
        XCTAssertEqual(cfg.meetingMarkers, ["microphone-button", "hangup-button", "like-button"])
    }

    func testAnEmptyMarkerListIsIgnored() {
        // A config that recognises nothing would report every meeting as over.
        let cfg = Defaults.overlay(Defaults.config(), json: #"{"meetingMarkerAutomationIds": []}"#)
        XCTAssertEqual(cfg.meetingMarkers, Defaults.config().meetingMarkers)
    }

    func testMarkersAreNotDuplicated() {
        let json = #"{"meetingMarkerAutomationIds": ["microphone-button", "microphone-button"]}"#
        let cfg = Defaults.overlay(Defaults.config(), json: json)
        XCTAssertEqual(cfg.meetingMarkers, ["microphone-button"])
    }

    // MARK: - Telling a flyout apart from a dialog

    func testFlyoutItemsAreTakenFromTheControlMap() {
        let ids = Defaults.config().flyoutItemAutomationIds
        for id in ["like-button", "heart-button", "applause-button", "laugh-button",
                   "surprised-button", "raisehands-button"] {
            XCTAssertTrue(ids.contains(id), "\(id) should mark an open flyout")
        }
    }

    func testAToolbarControlNeverMarksAnOpenFlyout() {
        // Mute is on the toolbar, so seeing it means no popup is covering it.
        // Treating it as a flyout item would have the sidecar try to dismiss
        // the meeting itself.
        let ids = Defaults.config().flyoutItemAutomationIds
        XCTAssertFalse(ids.contains("microphone-button"))
        XCTAssertFalse(ids.contains("hangup-button"))
        XCTAssertFalse(ids.contains("video-button"))
    }

    func testATemplatedItemIsNotAFlyoutMarker() {
        // 'toolbarTranslateSlidesLanguageMenuItem-{arg}' matches nothing until
        // a key supplies its language, so as written it would never be found
        // and only costs a lookup.
        let ids = Defaults.config().flyoutItemAutomationIds
        XCTAssertFalse(ids.contains { $0.contains("{arg}") })
    }

    func testAnOverlayRenamingAnItemMovesTheFlyoutMarkerWithIt() {
        let json = #"{"controls": {"react-love": {"menu": "reaction-menu-button", "menuItemAutomationId": "heart-2"}}}"#
        let ids = Defaults.overlay(Defaults.config(), json: json).flyoutItemAutomationIds
        XCTAssertTrue(ids.contains("heart-2"))
        XCTAssertFalse(ids.contains("heart-button"))
    }

    // MARK: - Pressing versus closing and re-opening

    func testASecondReactionIsReachedThroughTheOpenFlyout() {
        // The flyout the first reaction left open still holds every other one,
        // so the next press is one AXPress away. Closing the popup only to
        // re-open it would be slower and would flash it off the screen.
        let ids = TeamsClient.reachableIDs(reaction(), itemID: "heart-button", itemToggleID: nil)
        XCTAssertEqual(ids, ["heart-button"])
    }

    func testMuteIsNotReachableThroughAnOpenFlyout() {
        // Mute lives on the toolbar, which the flyout has taken out of the
        // tree - so this is the press that has to close the popup first. It is
        // the case both testers reported as "even mute/unmute does nothing".
        let spec = Defaults.config().controls["mute"]!
        let ids = TeamsClient.reachableIDs(spec, itemID: nil, itemToggleID: nil)
        XCTAssertEqual(ids, ["microphone-button"])
        XCTAssertFalse(Defaults.config().flyoutItemAutomationIds.contains("microphone-button"))
    }

    func testAToggleItemCountsAsReachable() {
        // Hide/show presenter view is one control under two ids; whichever is
        // in the tree is the one to press.
        let spec = Defaults.config().controls["ppt-hide-presenter-view"]!
        let ids = TeamsClient.reachableIDs(
            spec,
            itemID: "toolbarPresenterUIHideOverflowButton",
            itemToggleID: "toolbarPresenterUIShowOverflowButton"
        )
        XCTAssertEqual(ids, ["toolbarPresenterUIHideOverflowButton", "toolbarPresenterUIShowOverflowButton"])
    }

    func testAnOverlayCannotLeaveAControlUnreachable() {
        // Pointing a reaction at a new id has to move reachability with it,
        // or the fast path would keep looking for a button that is gone.
        let json = #"{"controls": {"react-love": {"menu": "reaction-menu-button", "menuItemAutomationId": "heart-2"}}}"#
        let spec = Defaults.overlay(Defaults.config(), json: json).controls["react-love"]!
        let itemID = fillArg(spec.menuItemAutomationId, nil)
        XCTAssertEqual(TeamsClient.reachableIDs(spec, itemID: itemID, itemToggleID: nil), ["heart-2"])
    }
}
