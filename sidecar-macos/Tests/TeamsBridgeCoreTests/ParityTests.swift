import XCTest
@testable import TeamsBridgeCore

/**
 * Covers the gaps found auditing the macOS sidecar against the Windows one.
 *
 * Every case here is something that used to be wrong in a way a tester would
 * have had to find: a control the macOS build could not reach at all, a
 * selectors.json edit that fixed Windows and silently did nothing here, or a
 * feature that answered "unknown target" as though the build were broken.
 */
final class ParityTests: XCTestCase {
    // MARK: - Stop presenting, the one control matched by name

    func testTheStopPresentingConfirmationExists() {
        // Invoked by powerpoint.ts when the key is held. It was absent from the
        // macOS defaults, and could not be supplied by selectors.json either,
        // because the overlay had nowhere to put 'name' or 'withinClass'.
        let spec = Defaults.config().controls["ppt-stop-presenting-confirm"]
        XCTAssertNotNil(spec)
        XCTAssertEqual(spec?.requiresRole, "presenter")
        XCTAssertEqual(spec?.withinClass, "ui-dialog")
        XCTAssertTrue(spec?.automationId.isEmpty ?? false, "the dialog's buttons carry no id")
    }

    func testTheConfirmationIsMatchedByName() throws {
        let spec = try XCTUnwrap(Defaults.config().controls["ppt-stop-presenting-confirm"])
        XCTAssertTrue(spec.matches(spec.nameRegex, text: "Stop presenting"))
        // Not the other button in the same dialog.
        XCTAssertFalse(spec.matches(spec.nameRegex, text: "Cancel"))
        // Anchored, so a longer label that merely contains it does not match.
        XCTAssertFalse(spec.matches(spec.nameRegex, text: "Stop presenting for everyone?"))
    }

    func testNameAndClassCanBeOverlaid() {
        // The one control that needs editing for a non-English Teams.
        let json = #"{"controls": {"ppt-stop-presenting-confirm": {"name": "^Présentation$", "withinClass": "dlg"}}}"#
        let spec = Defaults.overlay(Defaults.config(), json: json).controls["ppt-stop-presenting-confirm"]
        XCTAssertEqual(spec?.name, "^Présentation$")
        XCTAssertEqual(spec?.withinClass, "dlg")
    }

    // MARK: - Targets the plugin asks for that this sidecar cannot do

    func testUnimplementedTargetsAreNamed() {
        // These used to fall through to "unknown target", which reads like a
        // mismatched build and sends anyone debugging it to the wrong place.
        for target in ["ppt-ink-color", "ppt-ink-thickness", "ppt-goto-slide", "timer-toggle", "timer-reset"] {
            let message = TeamsClient.unimplementedTargets[target]
            XCTAssertNotNil(message, "\(target) should report itself unimplemented")
            XCTAssertFalse(message?.isEmpty ?? true)
        }
    }

    func testAnUnimplementedTargetIsNotAlsoAControl() {
        // If one were ever implemented, it would need removing from the list
        // or the control map entry would never be reached.
        let controls = Defaults.config().controls
        for target in TeamsClient.unimplementedTargets.keys {
            XCTAssertNil(controls[target], "\(target) is both a control and listed as unimplemented")
        }
    }

    // MARK: - PowerPoint Live, which macOS used to hard-code

    func testThePowerPointBlockCanBeOverlaid() {
        // selectors.json says "after a Teams update, correct the ids below".
        // That fixed Windows and did nothing here until this block was read.
        let json = """
        {"powerPointLive": {"presenterMarkerAutomationId": "stopBtn2", "attendeeMarkerAutomationId": "takeBtn2"}}
        """
        let ppt = Defaults.overlay(Defaults.config(), json: json).powerPointLive
        XCTAssertEqual(ppt.presenterMarkerAutomationId, "stopBtn2")
        XCTAssertEqual(ppt.attendeeMarkerAutomationId, "takeBtn2")
        XCTAssertEqual(ppt.rootAutomationId, "ppt-previewer-root", "untouched keys keep their default")
    }

    func testTheShippedPowerPointBlockIsRead() throws {
        let json = try XCTUnwrap(ShippedSelectorsTests.shippedJSON())
        let ppt = Defaults.overlay(Defaults.config(), json: json).powerPointLive
        XCTAssertEqual(ppt.rootAutomationId, "ppt-previewer-root")
        XCTAssertEqual(ppt.presenterMarkerAutomationId, "stopPresentingPptBtn")
        XCTAssertEqual(ppt.attendeeMarkerAutomationId, "takeControlPptBtn")
    }

    // MARK: - Reading the slide counter

    func testTheSlideCounterIsRead() {
        let rx = Defaults.config().powerPointLive.slidePositionRegex
        let found = TeamsClient.slidePosition(from: "3 of 12", rx)
        XCTAssertEqual(found?.at, "3")
        XCTAssertEqual(found?.of, "12")
    }

    func testTheSlideCounterAcceptsASlash() {
        let rx = Defaults.config().powerPointLive.slidePositionRegex
        XCTAssertEqual(TeamsClient.slidePosition(from: "7 / 9", rx)?.at, "7")
    }

    func testSomethingThatIsNotASlideCounterIsIgnored() {
        // The pattern is anchored because it is matched against every label in
        // the tree; an unanchored one would pick up a chat message.
        let rx = Defaults.config().powerPointLive.slidePositionRegex
        XCTAssertNil(TeamsClient.slidePosition(from: "Slide 3 of 12 shown to everyone", rx))
        XCTAssertNil(TeamsClient.slidePosition(from: "Mute", rx))
    }

    // MARK: - Reading ink colour and thickness off a tool's name

    func testInkColourAndThicknessComeFromTheToolName() {
        let ppt = Defaults.config().powerPointLive
        let label = "Pen: Light blue, Thickness 3"
        XCTAssertEqual(TeamsClient.capture(ppt.toolColorRegex, from: label), "Light blue")
        XCTAssertEqual(TeamsClient.capture(ppt.toolThicknessRegex, from: label), "3")
    }

    func testAToolWithNoThicknessStillGivesAColour() {
        // The laser pointer and cursor have a colour but no thickness.
        let ppt = Defaults.config().powerPointLive
        XCTAssertEqual(TeamsClient.capture(ppt.toolColorRegex, from: "Laser: Red"), "Red")
        XCTAssertNil(TeamsClient.capture(ppt.toolThicknessRegex, from: "Laser: Red"))
    }

    func testAnEmptyLabelYieldsNothing() {
        let ppt = Defaults.config().powerPointLive
        XCTAssertNil(TeamsClient.capture(ppt.toolColorRegex, from: ""))
    }

    // MARK: - Controls that no action can reach

    func testEveryControlIsReachableFromTheManifest() throws {
        // 'ppt-copilot' and 'ppt-translate' sat in the macOS defaults with no
        // Windows counterpart, no selectors.json entry, and no action that
        // could ever invoke them.
        let targets = try ParityTests.manifestTargets()
        try XCTSkipIf(targets.isEmpty, "manifest.json not found next to the package")
        // Reached by holding the Stop Presenting key rather than by an action
        // of its own, so it is the one control with no matching UUID.
        let heldRatherThanBound: Set<String> = ["ppt-stop-presenting-confirm"]
        for key in Defaults.config().controls.keys where !heldRatherThanBound.contains(key) {
            XCTAssertTrue(
                targets.contains(key),
                "control '\(key)' is in the map but no shipped action invokes it"
            )
        }
    }

    /// Action ids from the shipped manifest, which are also the invoke targets
    /// for every key-shaped action.
    private static func manifestTargets() throws -> Set<String> {
        var url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        url.appendPathComponent("com.bad-duck.teamscontrol.sdPlugin/manifest.json")
        guard let data = try? Data(contentsOf: url),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let actions = obj["Actions"] as? [[String: Any]] else { return [] }
        return Set(actions.compactMap { ($0["UUID"] as? String)?.split(separator: ".").last.map(String.init) })
    }
}
