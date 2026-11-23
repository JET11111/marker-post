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
    /// The line under the post: "J4 – J5", "Within J5",
    /// "A303 jct · 1.24 km from post", "Link M27B/M3B · survey date unknown",
    /// "Nearest recorded post · 1.24 km away", or empty when the records do
    /// not say. It can be about 37 characters long. Surfaces show it word for
    /// word: they may cut it at the end, but never shorten it themselves.
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

    /// One-line form: "M27 17.4 A", or "M27 P17/4A" when the reference is unusual.
    ///
    /// The letter is printed whether or not the carriageway is confirmed, so
    /// this is only for a place that shows `confirmed` in some other way. A
    /// place that can only print text uses `textLine(withRoad:)`.
    public var oneLine: String {
        let post = km.isEmpty ? ref : (letter.isEmpty ? km : "\(km) \(letter)")
        return road.isEmpty ? post : "\(road) \(post)"
    }

    /// The post in plain words, for a place that can only print text and so
    /// cannot draw the outlined letter: "M27 17.4 A" when the direction of
    /// travel chose the carriageway, and "M27 17.4" when it did not. A letter
    /// that is not confirmed is left out, never printed as if it were. A
    /// reference that is not in the usual form is printed as recorded.
    ///
    /// - Parameter withRoad: false leaves the road out ("17.4 A"), for where
    ///   there is no room for it.
    public func textLine(withRoad: Bool) -> String {
        var post = ref
        if !km.isEmpty {
            post = (confirmed && !letter.isEmpty) ? "\(km) \(letter)" : km
        }
        return (withRoad && !road.isEmpty) ? "\(road) \(post)" : post
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

/// The times, and the few fixed words, that the glanceable surfaces put around
/// a post. They are here, in plain Foundation, so that the tests can check
/// them without a screen. (Android has the same in SurfaceText.kt.) Nothing
/// about the post itself is reworded here.
///
/// Three rules decide the wording (docs/native-apps.md, section 7):
///  - Times are 24-hour, "14:32", whatever the phone's own setting. A time
///    that is not from today carries its day, "21 Nov, 14:32".
///  - Where a line may be cut short, the time comes first, so the time is
///    never the part that is lost.
///  - A carriageway letter that is not confirmed is never printed as if it were.
public enum SurfaceText {
    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// The calendar every time here is read with: the ordinary (Gregorian)
    /// one, whatever calendar the phone is set to, in the given time zone.
    private static func gregorian(_ timeZone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar
    }

    private static func twoDigits(_ value: Int) -> String {
        return value < 10 ? "0\(value)" : "\(value)"
    }

    // MARK: Times

    /// A time of day: "14:32". Always 24-hour and always two digits each,
    /// whatever the phone's language, region or 12/24-hour setting.
    public static func clock(_ date: Date, timeZone: TimeZone = .current) -> String {
        let parts = gregorian(timeZone).dateComponents([.hour, .minute], from: date)
        return twoDigits(parts.hour ?? 0) + ":" + twoDigits(parts.minute ?? 0)
    }

    /// True when `date` is not on the day that `now` is on.
    public static func isAnotherDay(_ date: Date, now: Date, timeZone: TimeZone = .current) -> Bool {
        return !gregorian(timeZone).isDate(date, inSameDayAs: now)
    }

    /// The day of a fix: "21 Nov", and with its year, "21 Nov 2025", when
    /// that is not the year `now` is in. In English, like every other word on
    /// these surfaces.
    public static func day(_ date: Date, now: Date, timeZone: TimeZone = .current) -> String {
        let calendar = gregorian(timeZone)
        let then = calendar.dateComponents([.year, .month, .day], from: date)
        let monthIndex = min(max((then.month ?? 1) - 1, 0), 11)
        let text = "\(then.day ?? 1) \(months[monthIndex])"
        let year = then.year ?? 0
        if year == calendar.component(.year, from: now) {
            return text
        }
        return "\(text) \(year)"
    }

    /// The time of a fix as every surface writes it: "14:32", or with its day
    /// in front, "21 Nov, 14:32", when the fix is not from the day it is being
    /// read on. The same form as fmtClock in the web app's core/posts.js.
    public static func time(_ date: Date, now: Date, timeZone: TimeZone = .current) -> String {
        let clockText = clock(date, timeZone: timeZone)
        if !isAnotherDay(date, now: now, timeZone: timeZone) {
            return clockText
        }
        return "\(day(date, now: now, timeZone: timeZone)), \(clockText)"
    }

    /// When `time` will next write this fix differently, or nil when it never
    /// will: the coming midnight for a fix from today (it then gains its
    /// day), and the coming new year for an earlier day of this year (it then
    /// gains its year). A surface that can sit untouched overnight books a
    /// redraw for this moment. (Android's SurfaceClock.nextChange is the same.)
    public static func nextChange(_ date: Date, now: Date, timeZone: TimeZone = .current) -> Date? {
        let calendar = gregorian(timeZone)
        // A fix from "later than now" means the phone's clock has been put
        // back since. Look again every midnight until the clock has caught up.
        if !isAnotherDay(date, now: now, timeZone: timeZone) || date > now {
            return calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now))
        }
        let year = calendar.component(.year, from: now)
        if calendar.component(.year, from: date) == year {
            return calendar.date(from: DateComponents(year: year + 1, month: 1, day: 1))
        }
        return nil
    }

    // MARK: Words

    /// The words in front of the time on a live surface (the Live Activity):
    /// "Updated 14:32", or "No GPS since 14:32" when the post is no longer current.
    public static func liveWords(stale: Bool) -> String {
        return stale ? "No GPS since" : "Updated"
    }

    /// The words in front of the time on a widget: "Last updated 14:32", or
    /// "No GPS since 14:32" when the post is no longer current. A widget
    /// never says "Live", and never "Updated" by itself, which could be read
    /// as live: iOS redraws a widget when it chooses to.
    public static func widgetWords(stale: Bool) -> String {
        return stale ? "No GPS since" : "Last updated"
    }

    /// The post and the time of its fix as one line of plain text, for a
    /// place that can show nothing else (the line beside the date on the Lock
    /// Screen). The fullest wording comes first and the shortest last; the
    /// surface shows the first that fits.
    ///
    /// Every line starts with when the position was taken, so if the end of a
    /// line is cut off it is never the time that is lost. A post that is no
    /// longer current starts with "No GPS". The carriageway letter is only
    /// printed when it is confirmed (`PostSnapshot.textLine`). The last line
    /// for a stale post leaves the post out altogether: better that than a
    /// post cut off part of the way through its number.
    ///
    /// Never empty.
    public static func oneLiners(_ snapshot: PostSnapshot, now: Date, timeZone: TimeZone = .current) -> [String] {
        let fix = snapshot.fixTime
        let when = time(fix, now: now, timeZone: timeZone)
        let full = snapshot.textLine(withRoad: true)
        let short = snapshot.textLine(withRoad: false)
        // For the shortest lines of a fix that is not from today: its day
        // without the time of day, which matters less by then.
        var dayOnly: String?
        if isAnotherDay(fix, now: now, timeZone: timeZone) {
            dayOnly = day(fix, now: now, timeZone: timeZone)
        }

        var lines: [String] = []
        if snapshot.stale {
            lines.append("No GPS since \(when) · \(full)")
            lines.append("No GPS since \(when) · \(short)")
            lines.append("No GPS \(when) · \(short)")
            if let dayOnly = dayOnly {
                lines.append("No GPS \(dayOnly) · \(short)")
                lines.append("No GPS since \(dayOnly)")
            } else {
                lines.append("No GPS since \(when)")
            }
        } else {
            lines.append("\(when) · \(full)")
            lines.append("\(when) · \(short)")
            if let dayOnly = dayOnly {
                lines.append("\(dayOnly) · \(short)")
            }
        }
        return lines
    }
}
