import CoreGraphics
import Foundation

/**
 * The geometry behind slide jumps and thumbnails, kept free of the
 * accessibility API so it can be tested without a meeting.
 *
 * PowerPoint Live publishes the name of a slide and never an image of it, and
 * its presenter-view filmstrip is a list of slide-sized items in deck order.
 * The ink tools are list items too, which is why size is part of the test.
 * Mirrors the Windows sidecar's Filmstrip, ClipToViewport and LiveSlide.
 */
enum Filmstrip {
    /// Smallest an item can be and still be a slide rather than a tool.
    static let minWidth: CGFloat = 100
    static let minHeight: CGFloat = 60

    /// How much of a slide must be in view before it is worth showing.
    static let minVisibleFraction: CGFloat = 0.98

    struct Tile<Handle> {
        var handle: Handle
        var frame: CGRect
        var selected: Bool
        var name: String
        /// The list the tile sits in, which is how much of it is on screen.
        var viewport: CGRect?
    }

    /// Slide-sized tiles in deck order: left to right, and row by row when the
    /// grid view lays them out on more than one line.
    static func order<H>(_ tiles: [Tile<H>]) -> [Tile<H>] {
        let slides = tiles.filter { $0.frame.width >= minWidth && $0.frame.height >= minHeight }
        var rows: [[Tile<H>]] = []
        for tile in slides.sorted(by: { $0.frame.minY < $1.frame.minY }) {
            if let last = rows.last?.first, abs(last.frame.minY - tile.frame.minY) < min(last.frame.height, tile.frame.height) / 2 {
                rows[rows.count - 1].append(tile)
            } else {
                rows.append([tile])
            }
        }
        return rows.flatMap { $0.sorted { $0.frame.minX < $1.frame.minX } }
    }

    /**
     * The tile for a one-based slide number.
     *
     * The index is the slide number less one only while the list really holds
     * every slide. If Teams ever virtualizes the strip that mapping points at
     * the wrong slide - and the cost of being wrong is moving the presentation
     * for everyone - so it is checked against the count Teams reports.
     */
    static func index(forSlide wanted: Int, stripCount: Int, reportedTotal: Int?) -> Result<Int, JumpError> {
        if stripCount == 0 { return .failure(.noList) }
        if let total = reportedTotal, total != stripCount { return .failure(.incomplete(stripCount, total)) }
        if wanted < 1 || wanted > stripCount { return .failure(.noSlide(wanted)) }
        return .success(wanted - 1)
    }

    enum JumpError: Error, Equatable {
        case noList
        case incomplete(Int, Int)
        case noSlide(Int)

        var message: String {
            switch self {
            case .noList: return "no slide list open"
            case let .incomplete(have, total): return "slide list has \(have) of \(total) slides"
            case let .noSlide(n): return "no slide \(n)"
            }
        }
    }

    /**
     * The part of a tile actually inside its list, or nil when too little of
     * it is. A tile reports its whole rectangle whether or not it has been
     * scrolled into view, so a half-scrolled one would otherwise be captured
     * with whatever sits beside the list down one edge.
     */
    static func clip(_ rect: CGRect, to view: CGRect) -> CGRect? {
        guard rect.width > 0, rect.height > 0 else { return nil }
        let shown = rect.intersection(view)
        guard !shown.isNull, shown.width > 0, shown.height > 0 else { return nil }
        guard shown.width / rect.width >= minVisibleFraction,
              shown.height / rect.height >= minVisibleFraction else { return nil }
        return shown
    }

    /**
     * The live slide among the images in its container: the 16:9 one. The
     * container itself is a letterboxed box, too big to use as it is, and the
     * slide image has neither a name nor an id to find it by.
     */
    static func liveSlide(among frames: [CGRect]) -> CGRect? {
        frames.first { f in
            f.width >= minWidth && f.height >= minHeight && abs(f.width / f.height - 16.0 / 9.0) <= 0.02
        }
    }
}
