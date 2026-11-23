import Foundation
import XCTest
import MarkerPostCore

// The times and the fixed words that the Lock Screen, the Dynamic Island,
// CarPlay and the widgets put around a post: SurfaceText and
// PostSnapshot.textLine, in Sources/MarkerPostCore/Shared/PostSnapshot.swift.
//
// Three rules are checked here (docs/native-apps.md, section 7):
//   * times are 24-hour, and a time that is not from today carries its day;
//   * on a line that may be cut short, the time comes first;
//   * a carriageway letter that is not confirmed is never printed as if it were.
//
//   cd native/marker-post-plugin && MARKERPOST_CORE_ONLY=1 swift test

final class SurfaceTextTests: XCTestCase {

    private let london = TimeZone(identifier: "Europe/London")!

    /// A time on the wall clock in London.
    private func at(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = london
        let parts = DateComponents(year: year, month: month, day: day, hour: hour, minute: minute)
        return calendar.date(from: parts)!
    }

    private func post(road: String = "M27", km: String = "17.4", letter: String = "A", ref: String = "P17/4A",
                      confirmed: Bool = true, stale: Bool = false, fixTime: Date) -> PostSnapshot {
        return PostSnapshot(road: road, roadClass: "M", km: km, letter: letter, ref: ref, context: "J4 – J5",
                            confirmed: confirmed, fixTime: fixTime, stale: stale, tracking: false)
    }

    // MARK: times

    func testATimeOfDayIsAlwaysTwentyFourHourAndTwoDigitsEach() {
        XCTAssertEqual(SurfaceText.clock(at(2026, 11, 22, 14, 32), timeZone: london), "14:32")
        XCTAssertEqual(SurfaceText.clock(at(2026, 11, 22, 0, 5), timeZone: london), "00:05")
        XCTAssertEqual(SurfaceText.clock(at(2026, 11, 22, 9, 7), timeZone: london), "09:07")
        XCTAssertEqual(SurfaceText.clock(at(2026, 7, 1, 23, 59), timeZone: london), "23:59", "in summer time too")
    }

    func testATimeIsReadInTheGivenTimeZone() {
        // 14:32 in London in November is 14:32 UTC, and 15:32 in Paris.
        let fix = at(2026, 11, 22, 14, 32)
        XCTAssertEqual(SurfaceText.clock(fix, timeZone: TimeZone(identifier: "UTC")!), "14:32")
        XCTAssertEqual(SurfaceText.clock(fix, timeZone: TimeZone(identifier: "Europe/Paris")!), "15:32")
        // In July London is an hour ahead of UTC.
        XCTAssertEqual(SurfaceText.clock(at(2026, 7, 1, 14, 32), timeZone: TimeZone(identifier: "UTC")!), "13:32")
    }

    func testATimeFromTodayIsTheClockTimeAlone() {
        let now = at(2026, 11, 22, 16, 5)
        XCTAssertEqual(SurfaceText.time(at(2026, 11, 22, 14, 32), now: now, timeZone: london), "14:32")
        XCTAssertEqual(SurfaceText.time(at(2026, 11, 22, 0, 0), now: now, timeZone: london), "00:00")
        XCTAssertFalse(SurfaceText.isAnotherDay(at(2026, 11, 22, 0, 0), now: now, timeZone: london))
    }

    /// The same form as fmtClock in the web app's core/posts.js.
    func testATimeThatIsNotFromTodayCarriesItsDay() {
        let now = at(2026, 11, 22, 0, 10)
        XCTAssertEqual(SurfaceText.time(at(2026, 11, 21, 23, 59), now: now, timeZone: london), "21 Nov, 23:59")
        XCTAssertEqual(SurfaceText.time(at(2026, 9, 5, 8, 0), now: now, timeZone: london), "5 Sep, 08:00")
        XCTAssertTrue(SurfaceText.isAnotherDay(at(2026, 11, 21, 23, 59), now: now, timeZone: london))
        XCTAssertEqual(SurfaceText.day(at(2026, 11, 21, 23, 59), now: now, timeZone: london), "21 Nov")
    }

    func testADayInAnotherYearCarriesItsYear() {
        let now = at(2026, 1, 1, 0, 10)
        XCTAssertEqual(SurfaceText.time(at(2025, 12, 31, 23, 50), now: now, timeZone: london), "31 Dec 2025, 23:50")
        XCTAssertEqual(SurfaceText.day(at(2025, 12, 31, 23, 50), now: now, timeZone: london), "31 Dec 2025")
    }

    func testEveryMonthIsWrittenAsTheWebAppWritesIt() {
        let names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        let now = at(2027, 1, 1, 12, 0)
        for month in 1...12 {
            XCTAssertEqual(SurfaceText.day(at(2027, month, 9, 12, 0), now: now, timeZone: london), "9 \(names[month - 1])")
        }
    }

    /// A widget can sit untouched overnight, so it books a redraw for the
    /// moment its time will read differently.
    func testTheWrittenTimeNextChangesAtMidnightAndThenAtTheNewYear() {
        let now = at(2026, 11, 22, 16, 5)
        XCTAssertEqual(SurfaceText.nextChange(at(2026, 11, 22, 14, 32), now: now, timeZone: london),
                       at(2026, 11, 23, 0, 0), "from today: at midnight it gains its day")
        XCTAssertEqual(SurfaceText.nextChange(at(2026, 11, 21, 14, 32), now: now, timeZone: london),
                       at(2027, 1, 1, 0, 0), "from earlier this year: at the new year it gains its year")
        XCTAssertNil(SurfaceText.nextChange(at(2025, 11, 21, 14, 32), now: now, timeZone: london),
                     "from an earlier year: it never changes again")
        XCTAssertEqual(SurfaceText.nextChange(at(2026, 12, 31, 23, 50), now: at(2026, 12, 31, 23, 55), timeZone: london),
                       at(2027, 1, 1, 0, 0))
        XCTAssertEqual(SurfaceText.nextChange(at(2026, 11, 23, 9, 0), now: now, timeZone: london),
                       at(2026, 11, 23, 0, 0), "a fix later than now (the clock was put back): look again at midnight")
        // The night the clocks go forward has 23 hours; midnight is still midnight.
        XCTAssertEqual(SurfaceText.nextChange(at(2026, 3, 28, 14, 0), now: at(2026, 3, 28, 15, 0), timeZone: london),
                       at(2026, 3, 29, 0, 0))
    }

    func testTheTimeReadsDifferentlyFromTheMomentItIsDueToChange() {
        let fix = at(2026, 11, 22, 14, 32)
        let midnight = SurfaceText.nextChange(fix, now: at(2026, 11, 22, 16, 5), timeZone: london)!
        XCTAssertEqual(SurfaceText.time(fix, now: midnight.addingTimeInterval(-1), timeZone: london), "14:32")
        XCTAssertEqual(SurfaceText.time(fix, now: midnight, timeZone: london), "22 Nov, 14:32")
        let newYear = SurfaceText.nextChange(fix, now: midnight, timeZone: london)!
        XCTAssertEqual(SurfaceText.time(fix, now: newYear.addingTimeInterval(-1), timeZone: london), "22 Nov, 14:32")
        XCTAssertEqual(SurfaceText.time(fix, now: newYear, timeZone: london), "22 Nov 2026, 14:32")
        XCTAssertNil(SurfaceText.nextChange(fix, now: newYear, timeZone: london))
    }

    // MARK: the fixed words

    func testAWidgetNeverSaysLiveOrUpdatedByItself() {
        XCTAssertEqual(SurfaceText.widgetWords(stale: false), "Last updated")
        XCTAssertEqual(SurfaceText.widgetWords(stale: true), "No GPS since")
        XCTAssertEqual(SurfaceText.liveWords(stale: false), "Updated")
        XCTAssertEqual(SurfaceText.liveWords(stale: true), "No GPS since")
    }

    // MARK: the post in plain words

    func testALetterThatIsNotConfirmedIsLeftOutOfPlainText() {
        let fix = at(2026, 11, 22, 14, 32)
        XCTAssertEqual(post(confirmed: true, fixTime: fix).textLine(withRoad: true), "M27 17.4 A")
        XCTAssertEqual(post(confirmed: true, fixTime: fix).textLine(withRoad: false), "17.4 A")
        XCTAssertEqual(post(confirmed: false, fixTime: fix).textLine(withRoad: true), "M27 17.4")
        XCTAssertEqual(post(confirmed: false, fixTime: fix).textLine(withRoad: false), "17.4")
        XCTAssertEqual(post(letter: "", confirmed: true, fixTime: fix).textLine(withRoad: true), "M27 17.4")
        XCTAssertEqual(post(road: "", confirmed: true, fixTime: fix).textLine(withRoad: true), "17.4 A")
    }

    func testAnUnusualReferenceIsPrintedAsRecorded() {
        let fix = at(2026, 11, 22, 14, 32)
        XCTAssertEqual(post(km: "", ref: "MP 23.5", confirmed: false, fixTime: fix).textLine(withRoad: true), "M27 MP 23.5")
        XCTAssertEqual(post(km: "", ref: "MP 23.5", confirmed: true, fixTime: fix).textLine(withRoad: false), "MP 23.5")
    }

    /// `oneLine` is left as it was: other code may rely on it.
    func testTheOldOneLineFormIsUnchanged() {
        let fix = at(2026, 11, 22, 14, 32)
        XCTAssertEqual(post(confirmed: false, fixTime: fix).oneLine, "M27 17.4 A")
        XCTAssertEqual(post(km: "", confirmed: true, fixTime: fix).oneLine, "M27 P17/4A")
    }

    // MARK: one line of plain text (the Lock Screen's inline widget)

    func testTheOneLineFormsOfACurrentPostFromToday() {
        let now = at(2026, 11, 22, 16, 5)
        let lines = SurfaceText.oneLiners(post(fixTime: at(2026, 11, 22, 14, 32)), now: now, timeZone: london)
        XCTAssertEqual(lines, ["14:32 · M27 17.4 A", "14:32 · 17.4 A"])
    }

    func testTheOneLineFormsOfACurrentPostFromAnotherDay() {
        let now = at(2026, 11, 22, 16, 5)
        let lines = SurfaceText.oneLiners(post(fixTime: at(2026, 11, 21, 14, 32)), now: now, timeZone: london)
        XCTAssertEqual(lines, ["21 Nov, 14:32 · M27 17.4 A", "21 Nov, 14:32 · 17.4 A", "21 Nov · 17.4 A"])
    }

    func testTheOneLineFormsOfAStalePostFromToday() {
        let now = at(2026, 11, 22, 16, 5)
        let lines = SurfaceText.oneLiners(post(stale: true, fixTime: at(2026, 11, 22, 14, 32)), now: now, timeZone: london)
        XCTAssertEqual(lines, ["No GPS since 14:32 · M27 17.4 A", "No GPS since 14:32 · 17.4 A",
                               "No GPS 14:32 · 17.4 A", "No GPS since 14:32"])
    }

    func testTheOneLineFormsOfAStalePostFromAnotherDay() {
        let now = at(2026, 11, 22, 16, 5)
        let lines = SurfaceText.oneLiners(post(stale: true, fixTime: at(2026, 11, 21, 14, 32)), now: now, timeZone: london)
        XCTAssertEqual(lines, ["No GPS since 21 Nov, 14:32 · M27 17.4 A", "No GPS since 21 Nov, 14:32 · 17.4 A",
                               "No GPS 21 Nov, 14:32 · 17.4 A", "No GPS 21 Nov · 17.4 A", "No GPS since 21 Nov"])
    }

    /// Whatever the post, whatever its age: the time first, the stale words in
    /// front of it, no letter that is not confirmed, and each line no longer
    /// than the one before it.
    func testEveryOneLineFormKeepsTheThreeRules() {
        let now = at(2026, 11, 22, 16, 5)
        let fixes = [at(2026, 11, 22, 14, 32), at(2026, 11, 21, 14, 32), at(2025, 11, 21, 14, 32)]
        let roads = ["M27", "A3(M)", "Chilworth · M3 / M27", "M27 / M275 interchange", ""]
        for fix in fixes {
            let stamp = SurfaceText.time(fix, now: now, timeZone: london)
            let dayOnly = SurfaceText.day(fix, now: now, timeZone: london)
            for road in roads {
                for confirmed in [true, false] {
                    for stale in [true, false] {
                        let snapshot = post(road: road, km: "117.8", letter: "K", ref: "P117/8K",
                                            confirmed: confirmed, stale: stale, fixTime: fix)
                        let lines = SurfaceText.oneLiners(snapshot, now: now, timeZone: london)
                        XCTAssertFalse(lines.isEmpty)
                        XCTAssertLessThanOrEqual(lines.count, 5, "the inline widget offers five")
                        var previous = Int.max
                        for line in lines {
                            XCTAssertEqual(line.hasPrefix("No GPS"), stale, line)
                            var rest = line
                            if rest.hasPrefix("No GPS since ") {
                                rest = String(rest.dropFirst("No GPS since ".count))
                            } else if rest.hasPrefix("No GPS ") {
                                rest = String(rest.dropFirst("No GPS ".count))
                            }
                            XCTAssertTrue(rest.hasPrefix(stamp) || rest.hasPrefix(dayOnly), "the time comes first: \(line)")
                            if !confirmed {
                                XCTAssertFalse(line.hasSuffix("117.8 K"), "a letter that is not confirmed: \(line)")
                            }
                            XCTAssertLessThanOrEqual(line.count, previous, "shorter each time: \(line)")
                            previous = line.count
                        }
                    }
                }
            }
        }
    }
}
