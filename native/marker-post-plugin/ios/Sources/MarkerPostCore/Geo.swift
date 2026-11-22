import Foundation

// The geometry behind "which post is nearest": a line-for-line port of the web
// app's own code (core/geo.js, and headingUsable in core/posts.js).
//
// The tests compare this file with answers produced by that JavaScript, so the
// order of the arithmetic below is deliberate. Do not tidy it: a rearranged
// sum can round differently and break a tie the other way.
//
// Pure Foundation, so it also builds on a Mac, where the tests run.

public enum Geo {
    /// Mean Earth radius in metres, the value the web app uses.
    public static let earthRadiusM: Double = 6_371_000

    /// Speed in metres per second above which the direction of travel is
    /// trusted to choose a carriageway. At or below it a GPS course wanders.
    public static let headingMinSpeed: Double = 2.5

    /// Degrees to radians. Multiply first, then divide, as the JavaScript does.
    public static func toRad(_ degrees: Double) -> Double {
        return (degrees * Double.pi) / 180
    }

    /// Great-circle (straight-line) distance in metres between two positions.
    public static func haversine(_ lat1: Double, _ lng1: Double, _ lat2: Double, _ lng2: Double) -> Double {
        let dLat = toRad(lat2 - lat1)
        let dLng = toRad(lng2 - lng1)
        let s1 = sin(dLat / 2)
        let s2 = sin(dLng / 2)
        // Squares are written as s * s, never pow(), so no library rounding is involved.
        let a = s1 * s1 + cos(toRad(lat1)) * cos(toRad(lat2)) * s2 * s2
        return 2 * earthRadiusM * asin(sqrt(a))
    }

    /// Smallest difference between two bearings in degrees, 0 to 180.
    ///
    /// The remainder keeps the sign of the dividend, exactly like "%" in
    /// JavaScript. A floored modulo would give different answers for inputs
    /// outside 0 to 360, so truncatingRemainder is the right one here.
    public static func angleDiff(_ a: Double, _ b: Double) -> Double {
        return abs((a - b + 540).truncatingRemainder(dividingBy: 360) - 180)
    }

    /// True when a direction of travel is reliable enough to choose a
    /// carriageway with: the preference is on, there is a heading, and the
    /// vehicle is moving faster than `headingMinSpeed`.
    ///
    /// nil means "the system gave no value". A NaN heading (what a browser
    /// reports when stationary) also counts as no heading.
    public static func headingUsable(heading: Double?, speed: Double?, useHeading: Bool) -> Bool {
        guard useHeading else { return false }
        guard let heading = heading, !heading.isNaN else { return false }
        guard let speed = speed else { return false }
        return speed > headingMinSpeed
    }

    /// The speed to use from a system reading, or nil when the system has none.
    /// Core Location reports a negative number for "no speed".
    public static func travelSpeed(_ rawSpeed: Double) -> Double? {
        return rawSpeed >= 0 ? rawSpeed : nil
    }

    /// The direction of travel to use from a system reading, or nil when there
    /// is none. Core Location reports a negative course for "no course". A
    /// course without a valid speed is not trusted either, so both must be
    /// present. This is the course over ground, never the compass.
    public static func travelHeading(course: Double, speed: Double) -> Double? {
        guard course >= 0, course <= 360, speed >= 0 else { return nil }
        return course
    }
}
