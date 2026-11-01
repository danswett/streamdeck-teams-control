import CoreGraphics
import UniformTypeIdentifiers
import XCTest
@testable import TeamsBridgeCore

/**
 * The parts of the Windows-parity features that can be reasoned about without
 * a Mac in a meeting: timer parsing, filmstrip geometry, the ink dial
 * arithmetic, camera arguments and thumbnail composition. Each mirrors a rule
 * the Windows sidecar already ships, so the two answer the plugin alike.
 */
final class ParityFeatureTests: XCTestCase {
    private let timer = Defaults.config().timer

    // MARK: - Timer

    func testARunningTimerPublishesRemainingTimeAndRunning() {
        let names = ["Mute", "Timer controls, 4 min, 57 sec remaining", "Pause timer", "Reset timer"]
        XCTAssertEqual(TimerReading.context(names, config: timer), [
            "timer.remaining": "297", "timer.running": "1",
        ])
    }

    func testAPausedTimerIsNotRunning() {
        let names = ["Timer controls, 1 hr, 2 min, 3 sec remaining", "Resume timer"]
        XCTAssertEqual(TimerReading.context(names, config: timer), [
            "timer.remaining": "3723", "timer.running": "0",
        ])
    }

    func testAnExpiredTimerIsReportedAsExpired() {
        let names = ["Timer controls, 0 sec remaining", "Cancel timer for everyone"]
        XCTAssertEqual(TimerReading.context(names, config: timer), [
            "timer.remaining": "0", "timer.running": "1", "timer.expired": "1",
        ])
    }

    func testNoTimerPublishesNothing() {
        XCTAssertTrue(TimerReading.context(["Mute", "Leave"], config: timer).isEmpty)
        XCTAssertTrue(TimerReading.context(["Timer controls"], config: timer).isEmpty)
    }

    func testTheToggleNeverPressesCancelForEveryone() {
        let expired = TimerReading.match(["Timer controls, 0 sec remaining", "Cancel timer for everyone"], config: timer)
        XCTAssertEqual(TimerReading.press(reset: false, buttons: expired), .refuse("time is up; hold to reset"))

        let running = TimerReading.match(["Pause timer", "Reset timer"], config: timer)
        XCTAssertEqual(TimerReading.press(reset: false, buttons: running), .press("Pause timer"))
        XCTAssertEqual(TimerReading.press(reset: true, buttons: running), .press("Reset timer"))

        let none = TimerReading.match(["Mute"], config: timer)
        XCTAssertEqual(TimerReading.press(reset: false, buttons: none), .refuse("no timer running"))
        XCTAssertEqual(TimerReading.press(reset: true, buttons: none), .refuse("no timer running"))
    }

    func testTimerPatternsCanBeOverlaidForAnotherLanguage() {
        let cfg = Defaults.overlay(Defaults.config(), json: #"""
        {"timer": {"controlsPattern": "^Timer-Steuerung", "pausePattern": "^Timer anhalten$",
                   "minutesPattern": "(\\d+)\\s*Min", "secondsPattern": "(\\d+)\\s*Sek"}}
        """#)
        let names = ["Timer-Steuerung, 2 Min, 5 Sek verbleibend", "Timer anhalten"]
        XCTAssertEqual(TimerReading.context(names, config: cfg.timer), [
            "timer.remaining": "125", "timer.running": "1",
        ])
    }

    // MARK: - Filmstrip

    private func tile(_ id: Int, x: CGFloat, y: CGFloat = 500, w: CGFloat = 160, h: CGFloat = 90) -> Filmstrip.Tile<Int> {
        Filmstrip.Tile(handle: id, frame: CGRect(x: x, y: y, width: w, height: h), selected: false, name: "\(id)", viewport: nil)
    }

    func testTheStripIsInDeckOrderAndSkipsTheInkTools() {
        let tiles = [tile(3, x: 400), tile(1, x: 0), tile(99, x: 50, w: 32, h: 32), tile(2, x: 200)]
        XCTAssertEqual(Filmstrip.order(tiles).map(\.handle), [1, 2, 3])
    }

    func testTheGridViewIsReadRowByRow() {
        let tiles = [tile(4, x: 200, y: 120), tile(2, x: 200, y: 0), tile(3, x: 0, y: 121), tile(1, x: 0, y: 2)]
        XCTAssertEqual(Filmstrip.order(tiles).map(\.handle), [1, 2, 3, 4])
    }

    func testAJumpIsRefusedWhenTheStripIsIncomplete() {
        XCTAssertEqual(Filmstrip.index(forSlide: 3, stripCount: 10, reportedTotal: 12), .failure(.incomplete(10, 12)))
        XCTAssertEqual(Filmstrip.JumpError.incomplete(10, 12).message, "slide list has 10 of 12 slides")
        XCTAssertEqual(Filmstrip.index(forSlide: 1, stripCount: 0, reportedTotal: nil), .failure(.noList))
        XCTAssertEqual(Filmstrip.index(forSlide: 13, stripCount: 12, reportedTotal: 12), .failure(.noSlide(13)))
        XCTAssertEqual(Filmstrip.index(forSlide: 0, stripCount: 12, reportedTotal: 12), .failure(.noSlide(0)))
        XCTAssertEqual(Filmstrip.index(forSlide: 7, stripCount: 12, reportedTotal: 12), .success(6))
        XCTAssertEqual(Filmstrip.index(forSlide: 7, stripCount: 12, reportedTotal: nil), .success(6))
    }

    func testAHalfScrolledSlideIsNotCaptured() {
        let view = CGRect(x: 0, y: 0, width: 500, height: 100)
        XCTAssertEqual(Filmstrip.clip(CGRect(x: 10, y: 5, width: 160, height: 90), to: view),
                       CGRect(x: 10, y: 5, width: 160, height: 90))
        XCTAssertNil(Filmstrip.clip(CGRect(x: 420, y: 5, width: 160, height: 90), to: view))
        // A pixel of rounding is absorbed rather than refused.
        XCTAssertNotNil(Filmstrip.clip(CGRect(x: 341, y: 5, width: 160, height: 90), to: view))
        XCTAssertNil(Filmstrip.clip(CGRect(x: 600, y: 5, width: 160, height: 90), to: view))
    }

    func testTheLiveSlideIsTheSixteenByNineImage() {
        let frames = [CGRect(x: 0, y: 0, width: 40, height: 40), CGRect(x: 0, y: 0, width: 400, height: 300),
                      CGRect(x: 10, y: 20, width: 640, height: 360)]
        XCTAssertEqual(Filmstrip.liveSlide(among: frames), CGRect(x: 10, y: 20, width: 640, height: 360))
        XCTAssertNil(Filmstrip.liveSlide(among: [CGRect(x: 0, y: 0, width: 400, height: 300)]))
    }

    // MARK: - Ink dials

    func testThicknessIsClampedRoundedAndSkippedWhenUnchanged() {
        XCTAssertEqual(InkAdjust.thickness(current: 3, min: 1, max: 6, arg: "5"), 5)
        XCTAssertEqual(InkAdjust.thickness(current: 3, min: 1, max: 6, arg: "+2"), 5)
        XCTAssertEqual(InkAdjust.thickness(current: 3, min: 1, max: 6, arg: "-9"), 1)
        XCTAssertEqual(InkAdjust.thickness(current: 3, min: 1, max: 6, arg: "12"), 6)
        XCTAssertNil(InkAdjust.thickness(current: 3, min: 1, max: 6, arg: "3.2"))
        XCTAssertNil(InkAdjust.thickness(current: 3, min: 6, max: 6, arg: "4"))
    }

    func testColourStepsWrapLikeACarousel() {
        XCTAssertEqual(InkAdjust.colorIndex(selected: 4, count: 5, arg: "1"), 0)
        XCTAssertEqual(InkAdjust.colorIndex(selected: 0, count: 5, arg: "-1"), 4)
        XCTAssertEqual(InkAdjust.colorIndex(selected: nil, count: 5, arg: nil), 1)
        XCTAssertEqual(InkAdjust.colorIndex(selected: 2, count: 5, arg: "-7"), 0)
        XCTAssertNil(InkAdjust.colorIndex(selected: 2, count: 5, arg: "0"))
        XCTAssertNil(InkAdjust.colorIndex(selected: nil, count: 0, arg: "1"))
    }

    func testTheInkFlyoutPatternsCanBeOverlaid() {
        let cfg = Defaults.overlay(Defaults.config(), json: #"""
        {"powerPointLive": {"inkThicknessPattern": "^Stiftstärke$", "arrowOptionPattern": "^Pfeil",
                            "filmstripItemRoles": ["AXGroup"], "slideContainerAutomationId": "slides"}}
        """#)
        XCTAssertEqual(cfg.powerPointLive.inkThicknessPattern, "^Stiftstärke$")
        XCTAssertEqual(cfg.powerPointLive.arrowOptionPattern, "^Pfeil")
        XCTAssertEqual(cfg.powerPointLive.filmstripItemRoles, ["AXGroup"])
        XCTAssertEqual(cfg.powerPointLive.slideContainerAutomationId, "slides")
    }

    // MARK: - Camera arguments

    func testABareIdSelectsOneCamera() {
        XCTAssertEqual(CameraArguments.parse("cam-1", swap: false), [CameraChoice(id: "cam-1")])
        XCTAssertNil(CameraArguments.parse("  ", swap: false))
    }

    func testASwapNeedsTwoDifferentCameras() {
        XCTAssertEqual(CameraArguments.parse(#"["a","b"]"#, swap: true), [CameraChoice(id: "a"), CameraChoice(id: "b")])
        XCTAssertNil(CameraArguments.parse(#"["a","A"]"#, swap: true))
        XCTAssertNil(CameraArguments.parse(#"["a"]"#, swap: true))
        XCTAssertNil(CameraArguments.parse("a", swap: true))
    }

    func testPreferencesAreParsedAndValidated() {
        let parsed = CameraArguments.parse(
            #"{"cameras":[{"id":"a","mirror":"on","softFocus":"unchanged"},{"id":"b","brightness":"off"}]}"#,
            swap: true
        )
        XCTAssertEqual(parsed, [CameraChoice(id: "a", mirror: true), CameraChoice(id: "b", brightness: false)])
        XCTAssertTrue(parsed?[0].hasPreferences ?? false)
        XCTAssertNil(CameraArguments.parse(#"{"cameras":[{"id":"a","mirror":"sideways"}]}"#, swap: false))
        XCTAssertNil(CameraArguments.parse(#"{"cameras":[{"id":"a"},{"id":"b"}]}"#, swap: false))
    }

    // MARK: - Thumbnails

    private func solid(_ w: Int, _ h: Int, _ r: CGFloat) -> CGImage {
        let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: r, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()!
    }

    func testASlideIsLetterboxedIntoItsSlot() throws {
        let slot = try XCTUnwrap(SlideCapture.compose(solid(320, 180, 1), border: false, width: 200, height: 100))
        XCTAssertEqual(slot.width, 200)
        XCTAssertEqual(slot.height, 100)
    }

    func testEncodedImagesAreDataUrlsWithTheirMimeType() throws {
        let image = solid(20, 10, 1)
        XCTAssertTrue(try XCTUnwrap(SlideCapture.encode(image, type: .png, quality: nil)).hasPrefix("data:image/png;base64,"))
        XCTAssertTrue(try XCTUnwrap(SlideCapture.encode(image, type: .jpeg, quality: 0.7)).hasPrefix("data:image/jpeg;base64,"))
    }

    func testAFadeFrameIsTheSameSizeAsItsEndpoints() throws {
        let frame = try XCTUnwrap(SlideCapture.blend(solid(200, 100, 0), solid(200, 100, 1), alpha: 0.5))
        XCTAssertEqual(frame.width, 200)
        XCTAssertEqual(frame.height, 100)
    }
}
