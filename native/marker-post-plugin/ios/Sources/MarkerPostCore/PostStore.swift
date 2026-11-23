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
    /// The line under the post: "J4 – J5", "Within J5", "A303 jct · 349 m from post", "Link M27B/M3B · survey date unknown", or empty.
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

    /// Steps 2 to 4 of "on every fix" (docs/native-apps.md, section 4): find
    /// the post, decide whether the carriageway is confirmed, and build what
    /// the surfaces show. Nil if there are no posts.
    ///
    /// A post more than `FarPost.farPostM` from the fix is still reported, but
    /// only as the nearest one on record: its carriageway is never shown as
    /// confirmed, whatever the heading says, and the line under it gives the
    /// distance instead of the junction section. Such a fix leaves the last
    /// confirmation as it was. It neither makes one nor forgets one.
    ///
    /// - Parameter confirmation: the tracker's memory of the last
    ///   heading-confirmed carriageway. Updated when the heading confirms one.
    public func liveSnapshot(lat: Double, lng: Double, heading: Double?, speed: Double?, useHeading: Bool,
                             fixTime: Date, confirmation: inout CarriagewayConfirmation) -> PostSnapshot? {
        guard let nearest = findNearest(lat: lat, lng: lng, heading: heading,
                                        speed: speed, useHeading: useHeading) else { return nil }
        let post = posts[nearest.index]
        if FarPost.isFar(nearest.distance) {
            var snapshot = post.snapshot(confirmed: false, fixTime: fixTime, stale: false, tracking: true)
            snapshot.context = FarPost.context(distance: nearest.distance)
            return snapshot
        }
        let confirmed = confirmation.confirmed(post: post, headingUsed: nearest.headingUsed, lat: lat, lng: lng)
        return post.snapshot(confirmed: confirmed, fixTime: fixTime, stale: false, tracking: true)
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
/// The same rule as staleAfterMs in the web app's core/posts.js.
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
        // A speed that is not a number is no speed at all, as in the web app.
        guard let speed = lastSpeed, !speed.isNaN else { return unknownSpeedLimit }
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

/// Which fixes the tracker may use, and the time each one carries.
public enum FixRule {
    /// A fix whose reported accuracy is worse than this many metres is not
    /// used. The posts are 100 m apart, so a rougher position cannot tell one
    /// post from the next.
    public static let maxUsableAccuracyM: Double = 100

    /// False when a fix is too rough to be a position. Such a fix is ignored:
    /// it does not move the post, and it does not refresh the "updated" time
    /// or put off the moment the last good fix goes stale.
    ///
    /// - Parameter accuracy: the reported accuracy in metres, or nil when the
    ///   fix came with no figure. A fix with no figure is accepted, and so is
    ///   one whose figure is not a number. (Core Location's negative figure
    ///   means something else, that the position itself is not valid, and the
    ///   tracker turns those away before asking here.)
    public static func accuracyIsUsable(_ accuracy: Double?) -> Bool {
        guard let accuracy = accuracy, !accuracy.isNaN else { return true }
        return accuracy <= maxUsableAccuracyM
    }

    /// The time a fix is shown with and goes stale by: the time the position
    /// was true, which is the time the system stamped it with and not the
    /// time it arrived. Never later than now: a fix stamped in the future
    /// would look newer than it is, and would stay "current" for too long.
    public static func fixTime(reported: Date, now: Date) -> Date {
        return reported > now ? now : reported
    }
}

/// Distances, written exactly as the web app writes them (fmtDist in
/// core/posts.js), so a distance reads the same on the Lock Screen as in the app.
public enum DistanceText {
    /// "38 m" below 1000 m, "1.24 km" below 10 km, "12.4 km" from there on.
    ///
    /// Digit for digit what the JavaScript gives, including the two edges
    /// that look odd: 999.5 m is "1000 m" and 9999 m is "10.00 km". A figure
    /// exactly half way goes up, as Math.round and toFixed do. The decimal
    /// point is always a full stop, whatever the phone's language.
    public static func fmtDist(_ metres: Double) -> String {
        // Not a distance. The lookup never gives one of these; nothing is
        // written rather than a number that would mean nothing.
        guard metres.isFinite, metres >= 0, metres < 1e15 else { return "" }
        if metres < 1000 {
            return "\(Int(roundHalfUp(metres))) m"
        }
        return "\(fixed(metres / 1000, decimals: metres < 10000 ? 2 : 1)) km"
    }

    /// Math.round, for a number that is not negative: the nearest whole
    /// number, and the higher one when exactly half way.
    private static func roundHalfUp(_ value: Double) -> Double {
        let below = value.rounded(.down)
        // This subtraction is exact, so "half way" is judged exactly.
        return value - below >= 0.5 ? below + 1 : below
    }

    /// toFixed, for a number of 1 or more: so many decimal places, worked out
    /// from the exact value the number holds, and up when exactly half way.
    ///
    /// Whole-number arithmetic throughout. Multiplying by ten or a hundred
    /// and rounding the result would go wrong now and then, because the
    /// multiplication itself rounds (1.45 to one place would come out as
    /// "1.5", where JavaScript gives "1.4").
    private static func fixed(_ value: Double, decimals: Int) -> String {
        let whole = value.rounded(.down)
        // A number of 1 or more has at most 52 binary places, so its
        // fraction times 2 to the power 52 is a whole number, exactly.
        let fraction = UInt64((value - whole) * 4_503_599_627_370_496)
        var scale: UInt64 = 1
        for _ in 0..<decimals { scale *= 10 }
        // fraction * scale / 2^52, to the nearest whole number, half way up.
        let half: UInt64 = 1 << 51
        let rounded = (fraction * scale + half) >> 52
        let total = UInt64(whole) * scale + rounded
        guard decimals > 0 else { return String(total) }
        let digits = String(total % scale)
        let padding = String(repeating: "0", count: max(0, decimals - digits.count))
        return "\(total / scale).\(padding)\(digits)"
    }
}

/// A fix that is a long way from every recorded post.
///
/// The nearest post is still the nearest one on record, but it no longer says
/// where the vehicle is, so the surfaces must not show it as if it did.
public enum FarPost {
    /// Straight-line distance in metres beyond which the chosen post is "far".
    public static let farPostM: Double = 250

    // The two ends of the line shown under a far post. The distance goes
    // between them.
    private static let lineStart = "Nearest recorded post · "
    private static let lineEnd = " away"

    /// True when the chosen post is more than `farPostM` from the fix.
    public static func isFar(_ distance: Double) -> Bool {
        return distance > farPostM
    }

    /// The line shown under a far post in place of its own:
    /// "Nearest recorded post · 1.24 km away". It says how far the post is and
    /// nothing else: not that the vehicle is off the road, which is not known.
    public static func context(distance: Double) -> String {
        return "\(lineStart)\(DistanceText.fmtDist(distance))\(lineEnd)"
    }

    /// True when a line under a post is one that `context(distance:)` wrote.
    /// No recorded post has such a line of its own (the tests check the whole
    /// list), so the line itself says that the post is far. That is how a far
    /// post is recognised without adding anything to the snapshot.
    public static func isContext(_ line: String) -> Bool {
        return line.hasPrefix(lineStart) && line.hasSuffix(lineEnd)
    }

    /// True when two snapshots are of a far post and look different only in
    /// how far away the post is said to be. That distance changes with every
    /// few metres driven, so the tracker shows it at a slower pace than a
    /// real change (see `ShowRule`).
    public static func onlyDistanceDiffers(_ a: PostSnapshot, _ b: PostSnapshot) -> Bool {
        guard isContext(a.context), isContext(b.context) else { return false }
        // The same test the surfaces' "has anything changed" uses: different
        // as they stand, the same once the two lines are made equal.
        var levelled = a
        levelled.context = b.context
        return !a.showsSameAs(b) && levelled.showsSameAs(b)
    }
}

/// When the live tracker sends what it knows to the surfaces: step 5 of "on
/// every fix" (docs/native-apps.md, section 4).
///
/// Every update to a Live Activity costs the phone something, and iOS holds
/// back an app that sends them like a ticking clock. So nothing is sent
/// unless there is something to say, and what changes all the time is sent
/// at a slower pace.
public enum ShowRule {
    /// A change is shown at most this often.
    public static let minimumInterval: TimeInterval = 1
    /// While the post is unchanged, the "updated" time is refreshed this often.
    public static let heartbeatInterval: TimeInterval = 30
    /// Far from any recorded post, the distance under the post is refreshed
    /// this often. It would otherwise change every second for as long as the
    /// vehicle is off the recorded network. Five seconds is well inside the
    /// time a moving fix stays current (`StaleRule.movingLimit`).
    public static let farDistanceInterval: TimeInterval = 5
    /// While the system's pause accounts for there being no newer position
    /// (`StaleRule.pauseExplainsSilence`), nothing changes; but the display
    /// is still sent again this often. A Live Activity shown as current
    /// carries a time after which iOS marks it out of date by itself, and
    /// this keeps that time ahead for as long as the app is running.
    public static let pausedRefreshInterval: TimeInterval = 10 * 60

    /// What the surfaces are told to show.
    public struct Display: Sendable {
        /// The post from the newest fix. Nil before the first one.
        public var snapshot: PostSnapshot?
        /// Words for a problem, where the surfaces should show any.
        public var problem: String?
        /// True when the system has paused its position updates and that
        /// accounts for the post not being refreshed.
        public var paused: Bool

        public init(snapshot: PostSnapshot?, problem: String?, paused: Bool) {
            self.snapshot = snapshot
            self.problem = problem
            self.paused = paused
        }

        /// Nothing to show yet: waiting for the first position.
        public static let waiting = Display(snapshot: nil, problem: nil, paused: false)
    }

    /// How the newest state differs from the one last shown.
    public enum Difference: Sendable {
        /// Nothing that can be seen. The time of the fix may have moved on.
        case nothing
        /// Only how far away a far post is said to be.
        case farDistance
        /// Anything else: the post, its line, the carriageway label, stale,
        /// a problem, or updates resuming after a pause.
        case change
        /// The system has just paused its updates because the phone stopped
        /// moving.
        case justPaused
    }

    /// True when two posts (or the lack of one) would not look the same on
    /// screen. A fix time that has only moved on is not a difference.
    public static func postDiffers(_ a: PostSnapshot?, _ b: PostSnapshot?) -> Bool {
        switch (a, b) {
        case (nil, nil):
            return false
        case let (first?, second?):
            return !first.showsSameAs(second)
        default:
            return true
        }
    }

    /// How the newest state differs from the one the surfaces were last sent.
    public static func difference(from shown: Display, to newest: Display) -> Difference {
        if newest.paused && !shown.paused { return .justPaused }
        // Updates resuming after a pause shows nothing new, but the Live
        // Activity must be told: it changes how long the display may go
        // without an update before iOS marks it out of date.
        if newest.problem != shown.problem || newest.paused != shown.paused { return .change }
        guard postDiffers(newest.snapshot, shown.snapshot) else { return .nothing }
        if let newer = newest.snapshot, let older = shown.snapshot, FarPost.onlyDistanceDiffers(newer, older) {
            return .farDistance
        }
        return .change
    }

    /// True when `now` is not on the day that `earlier` was on, by the phone's
    /// own clock.
    ///
    /// The surfaces write a time as "14:32", and put the day in front once the
    /// time is no longer today's. A Live Activity is only drawn again when it
    /// is sent something, so one left unchanged overnight has to be sent again
    /// after midnight for its time to gain its day.
    public static func dayChanged(since earlier: Date, now: Date, timeZone: TimeZone = .current) -> Bool {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return !calendar.isDate(earlier, inSameDayAs: now)
    }

    /// True when the newest state should be sent to the surfaces now.
    ///
    /// - Parameters:
    ///   - elapsed: seconds since the surfaces were last sent anything.
    ///     Negative if the phone's clock has been put back since.
    ///   - dayChanged: true when midnight has passed since then (see
    ///     `dayChanged(since:now:timeZone:)`). They are then sent again
    ///     whatever else has or has not changed.
    public static func isDue(from shown: Display, to newest: Display,
                             sinceShown elapsed: TimeInterval, dayChanged: Bool) -> Bool {
        if dayChanged { return true }
        // A negative time means the clock was put back: do not wait for it to catch up.
        let waited = { (interval: TimeInterval) -> Bool in elapsed < 0 || elapsed >= interval }
        switch difference(from: shown, to: newest) {
        case .justPaused:
            // The one thing that does not wait its second. The app may get
            // no more time to run once updates are paused, and a display
            // that was not told would be marked out of date within a minute
            // or two of the vehicle stopping.
            return true
        case .change:
            return waited(minimumInterval)
        case .farDistance:
            return waited(farDistanceInterval)
        case .nothing:
            if newest.snapshot?.fixTime != shown.snapshot?.fixTime {
                return waited(heartbeatInterval)
            }
            return newest.paused && waited(pausedRefreshInterval)
        }
    }
}

/// Telling a Live Activity that the user took off the screen from one that
/// iOS removed by itself.
///
/// The first means "stop tracking": location must not carry on with nothing
/// on screen to show for it. The second does not.
public enum DisplayRule {
    /// iOS ends a Live Activity by itself when its time is up. One that goes
    /// at least this many seconds before then was taken off by hand.
    public static let earlyMargin: TimeInterval = 300
    /// A follow-on that is due to start within this many seconds may be why
    /// the old display went: the system making room for it.
    public static let handoverMargin: TimeInterval = 60

    /// True when a display that is no longer on screen was removed by the user.
    ///
    /// - Parameters:
    ///   - now: the time of the check.
    ///   - dueToEnd: when iOS itself would have ended the display.
    ///   - followOnStarts: when the scheduled follow-on starts, or nil if
    ///     there is none.
    public static func removedByUser(now: Date, dueToEnd: Date, followOnStarts: Date?) -> Bool {
        if let next = followOnStarts, now >= next.addingTimeInterval(-handoverMargin) { return false }
        return now < dueToEnd.addingTimeInterval(-earlyMargin)
    }
}
