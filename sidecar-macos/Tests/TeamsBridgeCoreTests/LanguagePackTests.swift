import XCTest
@testable import TeamsBridgeCore

/**
 * Language packs are laid over selectors.json by --locale-pack. The plugin
 * checks captured labels with JavaScript regexes and Windows with .NET ones;
 * this is the same check with NSRegularExpression, which is what a Mac reads
 * state with.
 */
final class LanguagePackTests: XCTestCase {
    private static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // TeamsBridgeCoreTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // sidecar-macos
        .deletingLastPathComponent()  // repository root

    private func read(_ relative: String) throws -> String {
        let url = Self.root.appendingPathComponent(relative)
        try XCTSkipUnless(FileManager.default.fileExists(atPath: url.path), "\(relative) not found")
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func config(language: String) throws -> SelectorConfig {
        let bundled = Defaults.overlay(Defaults.config(), json: try read("com.bad-duck.teamscontrol.sdPlugin/selectors.json"))
        return Defaults.overlay(bundled, json: try read("com.bad-duck.teamscontrol.sdPlugin/locales/\(language).json"))
    }

    func testEveryCapturedLabelReadsAsItsStateThroughItsLanguagePack() throws {
        let dir = Self.root.appendingPathComponent("tests/fixtures/teams-labels")
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
        XCTAssertFalse(files.isEmpty)

        for file in files {
            let data = try Data(contentsOf: file)
            let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let language = try XCTUnwrap(fixture["language"] as? String)
            let labels = try XCTUnwrap(fixture["labels"] as? [String: [String: [String]]])
            let cfg = try config(language: language)
            for (key, sides) in labels {
                let spec = try XCTUnwrap(cfg.controls[key], "\(language): no \(key) control")
                for (side, expected) in [("active", true), ("inactive", false)] {
                    for label in sides[side] ?? [] {
                        XCTAssertEqual(spec.matches(spec.activeRegex, text: label), expected, "\(language) \(key) '\(label)'")
                        XCTAssertEqual(spec.matches(spec.inactiveRegex, text: label), !expected, "\(language) \(key) '\(label)'")
                    }
                }
            }
        }
    }

    func testThePackReplacesTheBundledEnglishPatterns() throws {
        let spec = try XCTUnwrap(config(language: "de").controls["mute"])
        XCTAssertTrue(spec.matches(spec.activeRegex, text: "Stummschaltung aufheben"))
        XCTAssertFalse(spec.matches(spec.inactiveRegex, text: "Stummschaltung aufheben"))
        XCTAssertEqual(spec.automationId, "microphone-button", "a pack must not lose the bundled id")
    }

    func testOnlyControlsNamedForTheirStatePublishTheirLabel() {
        let controls = Defaults.config().controls
        XCTAssertTrue(controls["mute"]!.publishesLabel)
        XCTAssertFalse(controls["chat"]!.publishesLabel)
        XCTAssertFalse(controls["ppt-private-view"]!.publishesLabel)
    }
}
