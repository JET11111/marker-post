import Foundation

// The recorded marker posts and the nearest-post lookup: a direct port of
// findNearest in the web app's core/posts.js.
//
// Everything that takes judgement (travel bearings, display names, junction
// sections) is worked out once by the web app's own JavaScript and written to
// posts.tsv by scripts/build-native-data.mjs. This file only reads that list,
// measures distances and compares bearings, so the phone's Lock Screen can
// never word a post differently from the app.
//
// Pure Foundation: no UIKit and no Core Location types, so it also builds on a
// Mac, where the tests run.

/// One recorded marker post, exactly as one line of posts.tsv describes it.
public struct Post: Hashable, Sendable {
    public let lat: Double
    public let lng: Double
    /// Direction traffic flows past the post, in degrees. Nil where the records do not say.
    public let bearing: Double?
    /// "M" motorway, "A" A-road, "O" other. Chooses the badge colour only.
    public let roadClass: String
    /// Display road name: "M27", "A3(M)".
    public let road: String
    /// Chainage for display, "17.4". Empty when the reference is not in the usual form.
    public let km: String
    /// Carriageway letter. May be empty.
    public let letter: String
    /// The recorded reference, verbatim: "P17/4A".
    public let ref: String
    /// The line under the post: "J4 – J5", "At J5", "A303 jct · 349 m", or empty.
    public let context: String

    public init(lat: Double, lng: Double, bearing: Double?, roadClass: String, road: String,
                km: String, letter: String, ref: String, context: String) {
        self.lat = lat
        self.lng = lng
        self.bearing = bearing
        self.roadClass = roadClass
        self.road = road
        self.km = km
        self.letter = letter
        self.ref = ref
        self.context = context
    }

    /// The value every glanceable surface shows for this post. The strings are
    /// copied as they are: nothing about a post is reworded here.
    public func snapshot(confirmed: Bool, fixTime: Date, stale: Bool, tracking: Bool) -> PostSnapshot {
        return PostSnapshot(road: road, roadClass: roadClass, km: km, letter: letter, ref: ref,
                            context: context, confirmed: confirmed, fixTime: fixTime,
                            stale: stale, tracking: tracking)
    }
}

/// The answer of a lookup.
public struct NearestPost: Equatable, Sendable {
    /// Position of the post in the list (the data line number in posts.tsv, from 0).
    public let index: Int
    /// Straight-line distance to it in metres.
    public let distance: Double
    /// True when the direction of travel decided the carriageway. False means
    /// the post was chosen by position only.
    public let headingUsed: Bool

    public init(index: Int, distance: Double, headingUsed: Bool) {
        self.index = index
        self.distance = distance
        self.headingUsed = headingUsed
    }
}

/// Why the post list could not be used. Any of these means "no data": a list
/// that is damaged or cut short is refused rather than half used.
public enum PostDataError: Error, Equatable {
    /// posts.tsv is not in the bundle.
    case resourceMissing
    /// The file says it is in a format this code does not know.
    case unsupportedFormat(String)
    /// A data line does not have the nine expected fields, or its position is not a number.
    case malformedLine(Int)
    /// The file holds a different number of posts from the count in its first line.
    case countMismatch(declared: Int, found: Int)
    /// The file holds no posts at all.
    case noPosts
}

/// The post list, in the app's own order, and the nearest-post lookup over it.
public struct PostStore: Sendable {
    /// Plain numbers only, so the scan below never touches a post's strings.
    private struct ScanPoint: Sendable {
        let lat: Double
        let lng: Double
        let bearing: Double?
    }

    /// Every post, in file order. The order matters: the first of two equally
    /// near posts wins, as it does in the web app.
    public let posts: [Post]
    /// The short checksum from the file's first line, if it had one. The tests
    /// use it to confirm that the expected answers were made from the same list.
    public let digest: String?

    private let points: [ScanPoint]

    public init(posts: [Post], digest: String? = nil) {
        self.posts = posts
        self.digest = digest
        self.points = posts.map { ScanPoint(lat: $0.lat, lng: $0.lng, bearing: $0.bearing) }
    }

    /// Read the text of posts.tsv. The format is documented at the top of
    /// scripts/build-native-data.mjs: lines starting with "#" are headers, and
    /// each other line is nine tab-separated fields:
    /// lat, lng, bearing, roadClass, road, km, letter, ref, context.
    public init(tsv text: String) throws {
        var posts: [Post] = []
        posts.reserveCapacity(6000)
        var declaredCount: Int?
        var digest: String?
        var lineNumber = 0

        // isNewline also covers a Windows line ending, which Swift treats as one character.
        for line in text.split(whereSeparator: { $0.isNewline }) {
            lineNumber += 1
            if line.hasPrefix("#") {
                let header = line.split(separator: "\t", omittingEmptySubsequences: false)
                if header.count >= 3, header[0] == "# markerpost-posts" {
                    guard header[1] == "v1" else { throw PostDataError.unsupportedFormat(String(header[1])) }
                    declaredCount = Int(header[2])
                    if header.count >= 4 { digest = String(header[3]) }
                }
                continue
            }

            // Empty fields must be kept: a post with no bearing, or no context,
            // has an empty field there, and dropping it would shift the rest.
            let fields = line.split(separator: "\t", omittingEmptySubsequences: false)
            guard fields.count == 9,
                  let lat = Double(fields[0]), lat.isFinite,
                  let lng = Double(fields[1]), lng.isFinite else {
                throw PostDataError.malformedLine(lineNumber)
            }
            var bearing: Double?
            if !fields[2].isEmpty {
                guard let value = Double(fields[2]), value.isFinite else {
                    throw PostDataError.malformedLine(lineNumber)
                }
                bearing = value
            }
            posts.append(Post(lat: lat, lng: lng, bearing: bearing,
                              roadClass: String(fields[3]), road: String(fields[4]),
                              km: String(fields[5]), letter: String(fields[6]),
                              ref: String(fields[7]), context: String(fields[8])))
        }

        guard !posts.isEmpty else { throw PostDataError.noPosts }
        if let declared = declaredCount, declared != posts.count {
            throw PostDataError.countMismatch(declared: declared, found: posts.count)
        }
        self.init(posts: posts, digest: digest)
    }

    /// The post list that ships inside the app.
    public static func loadBundled() throws -> PostStore {
        guard let url = Bundle.module.url(forResource: "posts", withExtension: "tsv") else {
            throw PostDataError.resourceMissing
        }
        let text = try String(contentsOf: url, encoding: .utf8)
        return try PostStore(tsv: text)
    }

    /// Nearest recorded post to a position, or nil if there are no posts.
    ///
    /// With a usable direction of travel, posts whose carriageway flows the
    /// other way (more than 90 degrees off) are skipped, which drops the
    /// opposite carriageway sitting a few metres to the side. Posts with no
    /// travel bearing stay in. If that leaves nothing, every post is considered.
    ///
    /// - Parameters:
    ///   - heading: direction of travel in degrees, or nil when the system reported none.
    ///   - speed: metres per second, or nil when the system reported none.
    ///   - useHeading: the "prefer my direction of travel" setting.
    public func findNearest(lat: Double, lng: Double, heading: Double?, speed: Double?,
                            useHeading: Bool) -> NearestPost? {
        var best = -1
        var bestD = Double.infinity
        var headingUsed = false

        if Geo.headingUsable(heading: heading, speed: speed, useHeading: useHeading), let heading = heading {
            for index in points.indices {
                let point = points[index]
                if let bearing = point.bearing, Geo.angleDiff(bearing, heading) > 90 { continue }
                let d = Geo.haversine(lat, lng, point.lat, point.lng)
                // Strictly less: the first of two equally near posts wins.
                if d < bestD {
                    bestD = d
                    best = index
                }
            }
            headingUsed = best >= 0 && points[best].bearing != nil
        }

        if best < 0 {
            for index in points.indices {
                let point = points[index]
                let d = Geo.haversine(lat, lng, point.lat, point.lng)
                if d < bestD {
                    bestD = d
                    best = index
                }
            }
        }

        guard best >= 0 else { return nil }
        return NearestPost(index: best, distance: bestD, headingUsed: headingUsed)
    }
}

/// Decides whether the carriageway letter may be shown as confirmed.
///
/// A carriageway is confirmed when the direction of travel chose it. Once
/// confirmed it stays confirmed while the nearest post is on the same road and
/// letter and the vehicle is within 300 m of where it was confirmed: you cannot
/// change carriageway without driving. This only changes the label, never which
/// post is reported.
public struct CarriagewayConfirmation: Sendable {
    /// How far the vehicle may be from the confirmed position and still keep the confirmation.
    public static let carryDistanceM: Double = 300

    private struct Anchor: Sendable {
        let road: String
        let letter: String
        let lat: Double
        let lng: Double
    }

    private var last: Anchor?

    public init() {}

    /// Whether the post found for this fix counts as confirmed. Remembers a
    /// new confirmation when `headingUsed` is true.
    public mutating func confirmed(post: Post, headingUsed: Bool, lat: Double, lng: Double) -> Bool {
        if headingUsed {
            last = Anchor(road: post.road, letter: post.letter, lat: lat, lng: lng)
            return true
        }
        guard let anchor = last else { return false }
        return anchor.road == post.road && anchor.letter == post.letter &&
            Geo.haversine(lat, lng, anchor.lat, anchor.lng) < CarriagewayConfirmation.carryDistanceM
    }

    /// Forget the last confirmation, for example when the direction-of-travel
    /// setting is switched off.
    public mutating func reset() {
        last = nil
    }
}

/// How old a fix may be before the post it gave must be shown as "last known".
public enum StaleRule {
    /// While moving faster than `Geo.headingMinSpeed` the post changes every few seconds.
    public static let movingLimit: TimeInterval = 15
    /// When the last fix carried no speed.
    public static let unknownSpeedLimit: TimeInterval = 30
    /// When the last fix said the vehicle was stopped or crawling.
    public static let stationaryLimit: TimeInterval = 120

    /// The longest a fix may go without a successor, given the last known speed
    /// in metres per second (nil when unknown).
    public static func limit(lastSpeed: Double?) -> TimeInterval {
        guard let speed = lastSpeed else { return unknownSpeedLimit }
        return speed > Geo.headingMinSpeed ? movingLimit : stationaryLimit
    }

    /// True when a fix of this age (in seconds) is too old to show as current.
    public static func isStale(fixAge: TimeInterval, lastSpeed: Double?) -> Bool {
        return fixAge > limit(lastSpeed: lastSpeed)
    }

    /// True when the system having paused its position updates accounts for a
    /// fix having no successor, so that the fix may go on being shown as current.
    ///
    /// iOS stops sending positions once it judges that the phone is no longer
    /// moving. Silence is then expected, and the last position is still right,
    /// but only if it was taken where the vehicle came to rest. So:
    ///  - a fix taken at speed is never excused: the vehicle has moved on from it;
    ///  - nor is a fix that was already older than `movingLimit` when the pause
    ///    began: positions had stopped arriving before the pause, and the pause
    ///    does not explain that.
    /// A fix that is not excused follows `isStale` as usual.
    ///
    /// - Parameters:
    ///   - pauseBegan: when the system said it was pausing its updates, or nil
    ///     if it has not paused them.
    ///   - fixTime: the time of the fix in question.
    ///   - lastSpeed: the speed of that fix in metres per second, or nil when it had none.
    public static func pauseExplainsSilence(pauseBegan: Date?, fixTime: Date, lastSpeed: Double?) -> Bool {
        guard let began = pauseBegan else { return false }
        if let speed = lastSpeed, speed > Geo.headingMinSpeed { return false }
        return began.timeIntervalSince(fixTime) <= movingLimit
    }
}
