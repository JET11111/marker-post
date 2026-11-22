import Foundation

// This file is compiled twice: into the MarkerPostCore package (the app) and
// directly into the widget extension. Keep it free of UIKit and of anything
// that is not available in an app extension.

/// What every glanceable surface shows: the nearest recorded marker post.
///
/// Every string is prepared by the same JavaScript the app uses
/// (scripts/build-native-data.mjs), so the Lock Screen, CarPlay, the widgets
/// and the app can never word a post differently.
public struct PostSnapshot: Codable, Hashable, Sendable {
    /// Display road name: "M27", "A3(M)", "Chilworth · M3 / M27".
    public var road: String
    /// "M" motorway, "A" A-road, "O" other. Chooses the badge colour only.
    public var roadClass: String
    /// Chainage for display, e.g. "17.4". Empty when the recorded reference is
    /// not in the usual form, in which case `ref` is shown instead.
    public var km: String
    /// Carriageway letter, e.g. "A". May be empty.
    public var letter: String
    /// The recorded reference, verbatim: "P17/4A".
    public var ref: String
    /// The line under the post: "J4 – J5", "At J5", "A303 jct · 349 m",
    /// "Link M27B/M3B", or empty when the records do not say.
    public var context: String
    /// True when the direction of travel chose the carriageway. False means the
    /// post was chosen by position only and the carriageway should be checked.
    public var confirmed: Bool
    /// Time of the GPS fix this came from.
    public var fixTime: Date
    /// True when no usable fix has arrived recently: show as "last known", never as current.
    public var stale: Bool
    /// True when live tracking was running when this was written.
    public var tracking: Bool

    public init(road: String, roadClass: String, km: String, letter: String, ref: String, context: String,
                confirmed: Bool, fixTime: Date, stale: Bool, tracking: Bool) {
        self.road = road
        self.roadClass = roadClass
        self.km = km
        self.letter = letter
        self.ref = ref
        self.context = context
        self.confirmed = confirmed
        self.fixTime = fixTime
        self.stale = stale
        self.tracking = tracking
    }

    /// True when the reference splits into a chainage and a letter for the large display.
    public var hasChainage: Bool { !km.isEmpty }

    /// One-line form for narrow places: "M27 17.4 A", or "M27 P17/4A" when the reference is unusual.
    public var oneLine: String {
        let post = km.isEmpty ? ref : (letter.isEmpty ? km : "\(km) \(letter)")
        return road.isEmpty ? post : "\(road) \(post)"
    }

    /// What two snapshots must share to count as "the same thing on screen".
    /// Used to avoid pushing an update when only the fix time moved on.
    public func showsSameAs(_ other: PostSnapshot) -> Bool {
        road == other.road && ref == other.ref && context == other.context &&
            confirmed == other.confirmed && stale == other.stale && tracking == other.tracking
    }

    /// Sample content for widget galleries and previews.
    public static let sample = PostSnapshot(
        road: "M27", roadClass: "M", km: "17.4", letter: "A", ref: "P17/4A", context: "J4 – J5",
        confirmed: true, fixTime: Date(timeIntervalSince1970: 1_795_000_000), stale: false, tracking: false)
}
