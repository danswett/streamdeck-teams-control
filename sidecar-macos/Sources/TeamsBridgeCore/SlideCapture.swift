import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

/**
 * Takes a slide off the Teams window as a still, for thumbnails.
 *
 * PowerPoint Live exposes the name of a slide and never its picture, so this is
 * the one part of the sidecar that reads meeting content rather than controls.
 * It is deliberately narrow, as on Windows: the caller names a rectangle inside
 * a Teams window, gets back a downscaled still, and nothing is written to disk
 * or logged.
 *
 * The window is captured on its own (ScreenCaptureKit's desktop-independent
 * window filter, the counterpart of Windows' PrintWindow), so a thumbnail is
 * right even with something on top of Teams, and a rectangle outside the window
 * is refused rather than returning whatever else was at those coordinates.
 *
 * Needs Screen Recording permission, and macOS 14 for the one-shot capture API.
 */
public enum SlideCapture {
    /// Width of the red border Teams draws around the live slide.
    static let borderWidth = 3

    public struct Composed {
        public var image: String
        public var frames: [String]
    }

    public enum Failure: Error, Equatable {
        case permission
        case unsupported
        case noWindow
        case outsideWindow
        case captureFailed(String)

        public var message: String {
            switch self {
            case .permission:
                return "slide thumbnails need Screen Recording permission for Stream Deck; turning on Show the slide in the dial's settings asks for it"
            case .unsupported: return "slide thumbnails need macOS 14 or later"
            case .noWindow: return "could not find the Teams window to capture"
            case .outsideWindow: return "the slide is outside the Teams window"
            case let .captureFailed(why): return "could not capture it: \(why)"
            }
        }
    }

    /**
     * Captures `rect` (global screen points, as the accessibility API reports
     * them) from the Teams window at `windowFrame`, composed into a slot and,
     * with `fadeFrames`, the frames that fade the slot's previous picture into it.
     */
    public static func grab(
        key: String,
        pid: pid_t,
        windowID: CGWindowID?,
        windowFrame: CGRect,
        rect: CGRect,
        border: Bool,
        fadeFrames: Int,
        slotWidth: Int,
        slotHeight: Int
    ) -> Result<Composed, Failure> {
        guard windowFrame.insetBy(dx: -1, dy: -1).contains(rect) else { return .failure(.outsideWindow) }
        // Checked, never requested: asking is the plugin's call, made when the
        // user allows a dial to show the slide.
        guard hasPermission else { return .failure(.permission) }
        guard #available(macOS 14.0, *) else { return .failure(.unsupported) }

        let shot: CGImage
        let scale: CGFloat
        switch captureWindow(pid: pid, id: windowID, frame: windowFrame) {
        case let .success(result): (shot, scale) = result
        case let .failure(failure): return .failure(failure)
        }

        let crop = CGRect(
            x: (rect.minX - windowFrame.minX) * scale,
            y: (rect.minY - windowFrame.minY) * scale,
            width: rect.width * scale,
            height: rect.height * scale
        ).integral
        guard let region = shot.cropping(to: crop),
              let slot = compose(region, border: border, width: slotWidth, height: slotHeight),
              let png = encode(slot, type: UTType.png, quality: nil) else {
            return .failure(.captureFailed("could not compose the thumbnail"))
        }

        lock.lock()
        defer { lock.unlock() }
        var frames: [String] = []
        if fadeFrames > 0, let from = previous[key], from.width == slot.width, from.height == slot.height {
            for i in 1...fadeFrames {
                // Endpoints left out: the picture already shown is frame zero,
                // and the capture itself is the last one.
                if let blended = blend(from, slot, alpha: CGFloat(i) / CGFloat(fadeFrames + 1)),
                   let jpeg = encode(blended, type: UTType.jpeg, quality: 0.7) {
                    frames.append(jpeg)
                }
            }
        }
        previous[key] = slot
        return .success(Composed(image: png, frames: frames))
    }

    /**
     * Forgets the last picture for a slot so nothing fades out of it. A slot
     * name forgets every size of it; nil forgets everything. Held only to fade
     * from, so once a deck stops there is no reason to keep meeting content
     * resident in a process that runs all session.
     */
    public static func forget(_ key: String?) {
        lock.lock()
        defer { lock.unlock() }
        guard let key, !key.isEmpty else {
            previous.removeAll()
            return
        }
        for k in previous.keys where k == key || k.hasPrefix(key + ":") {
            previous.removeValue(forKey: k)
        }
    }

    private static let lock = NSLock()
    private static var previous: [String: CGImage] = [:]

    /// Whether Screen Recording is granted. Never prompts.
    public static var hasPermission: Bool { CGPreflightScreenCaptureAccess() }

    /// Asks macOS for Screen Recording. The system shows its prompt at most
    /// once; after that the user changes it in System Settings.
    public static func requestPermission() {
        _ = CGRequestScreenCaptureAccess()
    }

    @available(macOS 14.0, *)
    private static func captureWindow(pid: pid_t, id: CGWindowID?, frame: CGRect) -> Result<(CGImage, CGFloat), Failure> {
        let content: Result<SCShareableContent, Failure> = wait { done in
            SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, error in
                if let content { done(.success(content)) }
                else { done(.failure(.captureFailed(error?.localizedDescription ?? "no shareable content"))) }
            }
        }
        let shareable: SCShareableContent
        switch content {
        case let .success(value): shareable = value
        case let .failure(failure): return .failure(failure)
        }

        // The window the slide element belongs to, by window-server id. Teams
        // has several windows, and two maximized ones share a frame, so the
        // frame alone is only trusted when exactly one Teams window has it.
        let candidates = shareable.windows.filter { $0.owningApplication?.processID == pid }
        func matchesFrame(_ w: SCWindow) -> Bool {
            abs(w.frame.minX - frame.minX) + abs(w.frame.minY - frame.minY)
                + abs(w.frame.width - frame.width) + abs(w.frame.height - frame.height) < 8
        }
        let window: SCWindow
        if let id, let exact = candidates.first(where: { $0.windowID == id }) {
            window = exact
        } else {
            let framed = candidates.filter(matchesFrame)
            guard framed.count == 1, let only = framed.first else { return .failure(.noWindow) }
            window = only
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)
        let scale = CGFloat(filter.pointPixelScale)
        let config = SCStreamConfiguration()
        config.width = Int((window.frame.width * scale).rounded())
        config.height = Int((window.frame.height * scale).rounded())
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true

        let shot: Result<CGImage, Failure> = wait { done in
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) { image, error in
                if let image { done(.success(image)) }
                else { done(.failure(.captureFailed(error?.localizedDescription ?? "no image"))) }
            }
        }
        return shot.map { ($0, scale) }
    }

    /// Bridges a completion handler into the sidecar's synchronous queue.
    /// Bounded so a capture that never answers cannot wedge every later press.
    private static func wait<T>(_ start: (@escaping (Result<T, Failure>) -> Void) -> Void) -> Result<T, Failure> {
        let semaphore = DispatchSemaphore(value: 0)
        let box = ResultBox<T>()
        start { result in
            box.set(result)
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + 3) == .success, let result = box.get() else {
            return .failure(.captureFailed("timed out"))
        }
        return result
    }

    private final class ResultBox<T> {
        private let lock = NSLock()
        private var value: Result<T, Failure>?
        func set(_ v: Result<T, Failure>) { lock.lock(); value = v; lock.unlock() }
        func get() -> Result<T, Failure>? { lock.lock(); defer { lock.unlock() }; return value }
    }

    /// Letterboxed into the slot it will be shown in, so the picture crosses
    /// the wire once at the size it is drawn.
    static func compose(_ region: CGImage, border: Bool, width: Int, height: Int) -> CGImage? {
        guard width > 0, height > 0, region.width > 0, region.height > 0,
              let ctx = context(width: width, height: height) else { return nil }
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))

        let fit = min(CGFloat(width) / CGFloat(region.width), CGFloat(height) / CGFloat(region.height))
        let w = max(1, (CGFloat(region.width) * fit).rounded())
        let h = max(1, (CGFloat(region.height) * fit).rounded())
        let left = ((CGFloat(width) - w) / 2).rounded(.down)
        let bottom = ((CGFloat(height) - h) / 2).rounded(.down)
        ctx.interpolationQuality = .high
        ctx.draw(region, in: CGRect(x: left, y: bottom, width: w, height: h))

        if border {
            // The red Teams draws around the slide being presented, as four
            // filled bands so the edge is clean on every side.
            let b = CGFloat(min(borderWidth, Int(min(w, h)) / 2))
            ctx.setFillColor(CGColor(red: 0xC4 / 255.0, green: 0x31 / 255.0, blue: 0x4B / 255.0, alpha: 1))
            ctx.fill([
                CGRect(x: left, y: bottom, width: w, height: b),
                CGRect(x: left, y: bottom + h - b, width: w, height: b),
                CGRect(x: left, y: bottom + b, width: b, height: h - 2 * b),
                CGRect(x: left + w - b, y: bottom + b, width: b, height: h - 2 * b),
            ])
        }
        return ctx.makeImage()
    }

    /// `to` drawn over `from` at the given opacity.
    static func blend(_ from: CGImage, _ to: CGImage, alpha: CGFloat) -> CGImage? {
        guard let ctx = context(width: from.width, height: from.height) else { return nil }
        let all = CGRect(x: 0, y: 0, width: from.width, height: from.height)
        ctx.draw(from, in: all)
        ctx.setAlpha(alpha)
        ctx.draw(to, in: all)
        return ctx.makeImage()
    }

    private static func context(width: Int, height: Int) -> CGContext? {
        CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        )
    }

    /// A data URL with its mime type, the only form a touch-strip pixmap accepts.
    static func encode(_ image: CGImage, type: UTType, quality: CGFloat?) -> String? {
        let data = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else { return nil }
        var props: [CFString: Any] = [:]
        if let quality { props[kCGImageDestinationLossyCompressionQuality] = quality }
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        let mime = type == .png ? "image/png" : "image/jpeg"
        return "data:\(mime);base64,\((data as Data).base64EncodedString())"
    }
}
