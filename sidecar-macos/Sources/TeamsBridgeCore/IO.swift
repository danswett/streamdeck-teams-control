import Foundation

/// Line-delimited JSON sidecar. stdout is the protocol; stderr is diagnostics.
///
/// Diagnostics are not decoration. The plugin copies this process's stderr into
/// the Stream Deck log, which is the only window a tester on a machine we
/// cannot reach has into what the sidecar decided - and the only reason the
/// execute-bit failure in #7 took one reading rather than a week.
public enum IO {
    private static let lock = NSLock()

    public static func emit(_ obj: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let line = String(data: data, encoding: .utf8) else { return }
        lock.lock()
        fputs(line + "\n", stdout)
        fflush(stdout)
        lock.unlock()
    }

    public static func err(_ message: String) {
        fputs(message + "\n", stderr)
        fflush(stderr)
    }
}
