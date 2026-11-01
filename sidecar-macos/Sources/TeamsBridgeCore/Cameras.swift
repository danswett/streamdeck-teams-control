import AVFoundation
import Foundation

/// One camera the plugin can offer in a key's settings.
public struct CameraDevice: Equatable {
    public var id: String
    public var name: String
}

/// A camera a key asks for, and the video preferences it wants with it.
struct CameraChoice: Equatable {
    var id: String
    var mirror: Bool?
    var softFocus: Bool?
    var brightness: Bool?

    var hasPreferences: Bool { mirror != nil || softFocus != nil || brightness != nil }
}

/**
 * The argument a camera key sends, in either of the shapes the Windows sidecar
 * accepts: a bare id (select), a JSON pair of ids (swap), or an object listing
 * the camera(s) with their video preferences. Same rules as CameraArguments.cs:
 * a swap needs two different ids, and a preference is "on", "off" or "unchanged".
 */
enum CameraArguments {
    static func parse(_ arg: String?, swap: Bool) -> [CameraChoice]? {
        guard let arg, !arg.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let trimmed = arg.trimmingCharacters(in: .whitespacesAndNewlines)

        guard trimmed.hasPrefix("{") else {
            if !swap { return [CameraChoice(id: arg)] }
            guard let data = trimmed.data(using: .utf8),
                  let pair = try? JSONSerialization.jsonObject(with: data) as? [Any],
                  pair.count == 2,
                  let first = pair[0] as? String, let second = pair[1] as? String else { return nil }
            return distinct([CameraChoice(id: first), CameraChoice(id: second)])
        }

        guard let data = trimmed.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let cameras = root["cameras"] as? [Any],
              cameras.count == (swap ? 2 : 1) else { return nil }

        var choices: [CameraChoice] = []
        for raw in cameras {
            guard let camera = raw as? [String: Any],
                  let id = camera["id"] as? String,
                  !id.trimmingCharacters(in: .whitespaces).isEmpty,
                  let mirror = preference(camera["mirror"]),
                  let softFocus = preference(camera["softFocus"]),
                  let brightness = preference(camera["brightness"]) else { return nil }
            choices.append(CameraChoice(id: id, mirror: mirror.value, softFocus: softFocus.value, brightness: brightness.value))
        }
        return swap ? distinct(choices) : choices
    }

    /// Wrapped so "unchanged" (nil inside) can be told from invalid (nil outside).
    private struct Preference { var value: Bool? }

    private static func preference(_ raw: Any?) -> Preference? {
        guard let raw else { return Preference(value: nil) }
        switch raw as? String {
        case "unchanged": return Preference(value: nil)
        case "on": return Preference(value: true)
        case "off": return Preference(value: false)
        default: return nil
        }
    }

    private static func distinct(_ choices: [CameraChoice]) -> [CameraChoice]? {
        guard choices.count == 2,
              !choices[0].id.trimmingCharacters(in: .whitespaces).isEmpty,
              !choices[1].id.trimmingCharacters(in: .whitespaces).isEmpty,
              choices[0].id.caseInsensitiveCompare(choices[1].id) != .orderedSame else { return nil }
        return choices
    }
}

/**
 * The cameras macOS knows about, for a key's settings.
 *
 * Listing devices needs no camera permission - only opening one does - so this
 * never triggers a prompt. The id is AVFoundation's uniqueID, which is stable
 * across reconnects and reboots; whether Teams uses the same string as the DOM
 * id of its camera menu item is what a Mac session has to confirm.
 */
public enum Cameras {
    public static func enumerate() -> [CameraDevice] {
        var types: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera]
        if #available(macOS 14.0, *) {
            types += [.external, .continuityCamera, .deskViewCamera]
        } else {
            types.append(.externalUnknown)
        }
        let session = AVCaptureDevice.DiscoverySession(deviceTypes: types, mediaType: .video, position: .unspecified)
        return session.devices
            .map { CameraDevice(id: $0.uniqueID, name: $0.localizedName) }
            .filter { !$0.id.isEmpty && !$0.name.isEmpty }
    }
}
