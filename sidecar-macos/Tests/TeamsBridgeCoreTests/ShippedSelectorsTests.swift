import XCTest
@testable import TeamsBridgeCore

/**
 * The sidecar ships with its control map compiled in and then merges
 * selectors.json over the top, so a Mac runs whatever that file says. The
 * Windows and macOS sidecars read the same file, which means a Windows-only
 * edit can take the macOS build with it, and nobody would see that until a
 * tester did.
 */
final class ShippedSelectorsTests: XCTestCase {
    private static let shipped: String = {
        // .../sidecar-macos/Tests/TeamsBridgeCoreTests/<this file>
        var dir = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // TeamsBridgeCoreTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // sidecar-macos
            .deletingLastPathComponent()  // repository root
        dir.appendPathComponent("com.bad-duck.teamscontrol.sdPlugin/selectors.json")
        return (try? String(contentsOf: dir, encoding: .utf8)) ?? ""
    }()

    private func merged() throws -> SelectorConfig {
        let json = Self.shipped
        try XCTSkipIf(json.isEmpty, "selectors.json not found next to the package")
        return Defaults.overlay(Defaults.config(), json: json)
    }

    func testTheShippedFileParses() throws {
        let cfg = try merged()
        // Defaults.overlay returns the base unchanged when the JSON is bad, so
        // a control the file sets and the defaults do not is the proof it was
        // actually read.
        XCTAssertNotNil(cfg.controls["ppt-stop-presenting-confirm"])
    }

    func testTheShippedFileLeavesAMeetingRecognisableThroughAFlyout() throws {
        let cfg = try merged()
        XCTAssertTrue(cfg.meetingMarkers.contains(cfg.meetingProbeAutomationId))
        XCTAssertTrue(
            cfg.meetingMarkers.contains { cfg.flyoutItemAutomationIds.contains($0) },
            "at least one marker has to survive an open flyout, or every key fails while a menu is up"
        )
    }

    func testEveryReactionIsStillReachedThroughTheReactionsFlyout() throws {
        let cfg = try merged()
        for key in ["react-like", "react-love", "react-applause", "react-laugh", "react-wow", "hand"] {
            let spec = try XCTUnwrap(cfg.controls[key], "\(key) is missing")
            XCTAssertEqual(spec.menu, "reaction-menu-button", "\(key) should open the reactions flyout")
            let item = try XCTUnwrap(spec.menuItemAutomationId, "\(key) has no item id")
            XCTAssertTrue(
                cfg.flyoutItemAutomationIds.contains(item),
                "\(key)'s item should mark the flyout as open"
            )
        }
    }

    func testMuteStaysAToolbarControl() throws {
        // If mute ever gained a menu it would stop being the control that
        // proves the toolbar is reachable, and the recovery below it would
        // never run.
        let spec = try XCTUnwrap(merged().controls["mute"])
        XCTAssertNil(spec.menu)
        XCTAssertEqual(spec.automationId, "microphone-button")
    }
}
