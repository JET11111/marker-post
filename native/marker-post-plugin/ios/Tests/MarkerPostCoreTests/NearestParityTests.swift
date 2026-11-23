import Foundation
import XCTest
import MarkerPostCore

// The Swift lookup must give the same answers as the web app.
//
// scripts/build-native-data.mjs writes two files with the web app's own code:
// posts.tsv (every post) and nearest-fixtures.tsv (about 2,000 positions, each
// with the post, distance and "heading used" flag the web app gave). These
// tests replay every position through the Swift code.
//
//   node scripts/build-native-data.mjs
//   cd native/marker-post-plugin && MARKERPOST_CORE_ONLY=1 swift test

final class NearestParityTests: XCTestCase {

    /// One line of nearest-fixtures.tsv:
    /// lat, lng, heading, speed, useHeading, index, distM, headingUsed, marginM.
    private struct Fixture {
        let line: Int
        let lat: Double
        let lng: Double
        let heading: Double?
        let speed: Double?
        let useHeading: Bool
        let index: Int
        let distM: Double
        let headingUsed: Bool
        let marginM: Double
    }

    private struct FixtureFile {
        var declaredCount: Int?
        var digest: String?
        var rows: [Fixture] = []
    }

    private struct BadFixture: Error, CustomStringConvertible {
        let line: Int
        let text: String
        var description: String { return "nearest-fixtures.tsv line \(line) cannot be read: \(text)" }
    }

    private func resourceText(_ name: String) throws -> String {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: name, withExtension: "tsv"),
            "\(name).tsv is not in the test bundle. Run: node scripts/build-native-data.mjs")
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// A heading or speed column: the word "null" means the web app had no
    /// value, and "NaN" is what a browser reports for "no heading".
    private func optionalNumber(_ field: Substring, line: Int) throws -> Double? {
        if field == "null" { return nil }
        if field == "NaN" { return Double.nan }
        guard let value = Double(field) else { throw BadFixture(line: line, text: String(field)) }
        return value
    }

    private func number(_ field: Substring, line: Int) throws -> Double {
        guard let value = Double(field) else { throw BadFixture(line: line, text: String(field)) }
        return value
    }

    private func loadFixtures() throws -> FixtureFile {
        var file = FixtureFile()
        var lineNumber = 0
        let text = try resourceText("nearest-fixtures")
        for line in text.split(whereSeparator: { $0.isNewline }) {
            lineNumber += 1
            let fields = line.split(separator: "\t", omittingEmptySubsequences: false)
            if line.hasPrefix("#") {
                if fields.count >= 4, fields[0] == "# markerpost-nearest-fixtures" {
                    file.declaredCount = Int(fields[2])
                    file.digest = String(fields[3])
                }
                continue
            }
            guard fields.count == 9, let index = Int(fields[5]) else {
                throw BadFixture(line: lineNumber, text: String(line))
            }
            let lat = try number(fields[0], line: lineNumber)
            let lng = try number(fields[1], line: lineNumber)
            let heading = try optionalNumber(fields[2], line: lineNumber)
            let speed = try optionalNumber(fields[3], line: lineNumber)
            let distM = try number(fields[6], line: lineNumber)
            let marginM = try number(fields[8], line: lineNumber)
            file.rows.append(Fixture(line: lineNumber, lat: lat, lng: lng, heading: heading, speed: speed,
                                     useHeading: fields[4] == "1", index: index, distM: distM,
                                     headingUsed: fields[7] == "1", marginM: marginM))
        }
        return file
    }

    /// The contract, for every fixture:
    ///  1. the distance matches within one millionth of a metre;
    ///  2. "heading used" matches;
    ///  3. the post matches, unless the runner-up was within a millionth of a
    ///     metre (an exact tie, which two maths libraries may break differently).
    func testEveryFixtureGivesTheWebAppsAnswer() throws {
        let store = try PostStore(tsv: resourceText("posts"))
        let fixtures = try loadFixtures()

        XCTAssertGreaterThan(store.posts.count, 1000, "posts.tsv looks cut short")
        XCTAssertGreaterThan(fixtures.rows.count, 1000, "nearest-fixtures.tsv looks cut short")
        if let declared = fixtures.declaredCount {
            XCTAssertEqual(fixtures.rows.count, declared, "nearest-fixtures.tsv does not hold the number of rows its first line promises")
        }
        XCTAssertNotNil(store.digest, "posts.tsv has no checksum in its first line")
        XCTAssertEqual(fixtures.digest, store.digest, "posts.tsv and nearest-fixtures.tsv were not generated from the same data")

        let tolerance = 1e-6
        var problems: [String] = []
        var tiesSkipped = 0
        for fixture in fixtures.rows {
            guard let got = store.findNearest(lat: fixture.lat, lng: fixture.lng, heading: fixture.heading,
                                              speed: fixture.speed, useHeading: fixture.useHeading) else {
                problems.append("line \(fixture.line): no post found")
                continue
            }
            // Written so that a NaN distance fails too.
            if !(abs(got.distance - fixture.distM) <= tolerance) {
                problems.append("line \(fixture.line): distance \(got.distance) m, expected \(fixture.distM) m")
            }
            if got.headingUsed != fixture.headingUsed {
                problems.append("line \(fixture.line): headingUsed \(got.headingUsed), expected \(fixture.headingUsed)")
            }
            if fixture.marginM > tolerance {
                if got.index != fixture.index {
                    problems.append("line \(fixture.line): post \(got.index), expected \(fixture.index)")
                }
            } else {
                tiesSkipped += 1
            }
        }

        XCTAssertLessThan(tiesSkipped, fixtures.rows.count / 2, "too many fixtures are ties to prove anything")
        XCTAssertTrue(problems.isEmpty,
                      "\(problems.count) difference(s) from the web app in \(fixtures.rows.count) fixtures:\n"
                        + problems.prefix(25).joined(separator: "\n"))
    }

    /// The sum inside the distance must be built in the web app's order
    /// (docs/native-apps.md, section 3): each square first, then the two
    /// cosines multiplied together, then that product times the second square.
    ///
    /// Built in any other order the distance comes out a hair different. That
    /// is far inside the tolerance of the test above, so that test cannot see
    /// it; but it is no longer the web app's own number, and it is enough to
    /// break a tie between two posts the other way. So this test compares
    /// exact values, against the same sum written out here in the right order.
    func testTheDistanceIsBuiltInTheWebAppsOrder() throws {
        let store = try PostStore(tsv: resourceText("posts"))
        let fixtures = try loadFixtures()

        var problems: [String] = []
        // How many of these distances another order would change. If it were
        // none, this test could not tell the orders apart and would prove nothing.
        var orderMatters = 0
        for fixture in fixtures.rows where store.posts.indices.contains(fixture.index) {
            let post = store.posts[fixture.index]
            let s1: Double = sin(Geo.toRad(post.lat - fixture.lat) / 2)
            let s2: Double = sin(Geo.toRad(post.lng - fixture.lng) / 2)
            let cosines: Double = cos(Geo.toRad(fixture.lat)) * cos(Geo.toRad(post.lat))
            let inOrder: Double = (s1 * s1) + cosines * (s2 * s2)
            let leftToRight: Double = s1 * s1 + cosines * s2 * s2
            let expected: Double = 2 * Geo.earthRadiusM * asin(sqrt(inOrder))
            let otherwise: Double = 2 * Geo.earthRadiusM * asin(sqrt(leftToRight))

            let got = Geo.haversine(fixture.lat, fixture.lng, post.lat, post.lng)
            if got != expected {
                problems.append("line \(fixture.line): \(got) m, expected exactly \(expected) m")
            }
            if otherwise != expected {
                orderMatters += 1
            }
        }

        XCTAssertGreaterThan(orderMatters, 0, "no fixture tells one order from another, so this test proves nothing")
        XCTAssertTrue(problems.isEmpty,
                      "\(problems.count) distance(s) not built in the web app's order:\n"
                        + problems.prefix(25).joined(separator: "\n"))
    }

    /// The list that ships inside the app is the list these tests ran against.
    func testTheListInsideTheAppIsTheListThatWasTested() throws {
        let bundled = try PostStore.loadBundled()
        let tested = try PostStore(tsv: resourceText("posts"))
        XCTAssertEqual(bundled.digest, tested.digest)
        XCTAssertEqual(bundled.posts.count, tested.posts.count)
        XCTAssertTrue(bundled.posts == tested.posts, "the bundled posts.tsv differs from the copy in the test bundle")
    }
}

final class LookupRuleTests: XCTestCase {

    private func post(_ lat: Double, _ lng: Double, bearing: Double?, road: String = "M27", letter: String = "A") -> Post {
        return Post(lat: lat, lng: lng, bearing: bearing, roadClass: "M", road: road,
                    km: "17.4", letter: letter, ref: "P17/4\(letter)", context: "J4 – J5")
    }

    // MARK: angleDiff

    func testAngleDiffIsTheSmallestAngleBetweenTwoBearings() {
        XCTAssertEqual(Geo.angleDiff(0, 0), 0)
        XCTAssertEqual(Geo.angleDiff(0, 90), 90)
        XCTAssertEqual(Geo.angleDiff(0, 270), 90)
        XCTAssertEqual(Geo.angleDiff(10, 350), 20)
        XCTAssertEqual(Geo.angleDiff(350, 10), 20)
        XCTAssertEqual(Geo.angleDiff(359.5, 0.5), 1)
        XCTAssertEqual(Geo.angleDiff(0.5, 359.5), 1)
        XCTAssertEqual(Geo.angleDiff(0, 180), 180)
        XCTAssertEqual(Geo.angleDiff(180, 0), 180)
        XCTAssertEqual(Geo.angleDiff(90, 270), 180)
        XCTAssertEqual(Geo.angleDiff(270, 90), 180)
    }

    func testAngleDiffWrapsWholeTurns() {
        XCTAssertEqual(Geo.angleDiff(0, 360), 0)
        XCTAssertEqual(Geo.angleDiff(360, 0), 0)
        XCTAssertEqual(Geo.angleDiff(720, 0), 0)
        XCTAssertEqual(Geo.angleDiff(-170, 170), 20)
    }

    /// JavaScript's "%" keeps the sign of the dividend, so a difference below
    /// -540 comes out as 360 rather than 0. Bearings in the data never reach
    /// that, but the port must behave the same way if they did.
    func testAngleDiffKeepsTheSignOfTheDividendLikeJavaScript() {
        XCTAssertEqual(Geo.angleDiff(0, 720), 360)
        XCTAssertEqual(Geo.angleDiff(-400, 320), 360)
    }

    func testAngleDiffOfNotANumberIsNotANumber() {
        XCTAssertTrue(Geo.angleDiff(Double.nan, 10).isNaN)
        XCTAssertTrue(Geo.angleDiff(10, Double.nan).isNaN)
    }

    // MARK: headingUsable

    func testHeadingIsUsableOnlyWhenMovingFasterThanTheThreshold() {
        XCTAssertTrue(Geo.headingUsable(heading: 90, speed: 30, useHeading: true))
        XCTAssertTrue(Geo.headingUsable(heading: 90, speed: 2.5000001, useHeading: true))
        XCTAssertFalse(Geo.headingUsable(heading: 90, speed: 2.5, useHeading: true), "exactly at the threshold is not used")
        XCTAssertFalse(Geo.headingUsable(heading: 90, speed: 0, useHeading: true))
        XCTAssertFalse(Geo.headingUsable(heading: 90, speed: -1, useHeading: true))
    }

    func testHeadingIsNotUsableWithoutAHeadingASpeedOrThePreference() {
        XCTAssertFalse(Geo.headingUsable(heading: nil, speed: 30, useHeading: true))
        XCTAssertFalse(Geo.headingUsable(heading: Double.nan, speed: 30, useHeading: true))
        XCTAssertFalse(Geo.headingUsable(heading: 90, speed: nil, useHeading: true))
        XCTAssertFalse(Geo.headingUsable(heading: 90, speed: Double.nan, useHeading: true))
        XCTAssertFalse(Geo.headingUsable(heading: 90, speed: 30, useHeading: false))
    }

    func testDueNorthIsAHeading() {
        XCTAssertTrue(Geo.headingUsable(heading: 0, speed: 30, useHeading: true))
    }

    // MARK: system readings

    func testCoreLocationsMinusOneMeansNoValue() {
        XCTAssertNil(Geo.travelSpeed(-1))
        XCTAssertNil(Geo.travelSpeed(Double.nan))
        XCTAssertEqual(Geo.travelSpeed(0), 0)
        XCTAssertEqual(Geo.travelSpeed(31.5), 31.5)

        XCTAssertNil(Geo.travelHeading(course: -1, speed: 30))
        XCTAssertNil(Geo.travelHeading(course: 90, speed: -1), "a course without a valid speed is not trusted")
        XCTAssertNil(Geo.travelHeading(course: Double.nan, speed: 30))
        XCTAssertNil(Geo.travelHeading(course: 400, speed: 30))
        XCTAssertEqual(Geo.travelHeading(course: 0, speed: 30), 0)
        XCTAssertEqual(Geo.travelHeading(course: 359.9, speed: 0), 359.9)
    }

    // MARK: distance

    func testHaversine() {
        XCTAssertEqual(Geo.haversine(50.9, -1.3, 50.9, -1.3), 0)
        // One degree of latitude on a sphere of radius 6,371,000 m.
        XCTAssertEqual(Geo.haversine(0, 0, 1, 0), 111_194.9266, accuracy: 0.001)
        XCTAssertEqual(Geo.haversine(50.9, -1.3, 50.91, -1.31), Geo.haversine(50.91, -1.31, 50.9, -1.3), accuracy: 1e-9)
    }

    // MARK: findNearest

    /// Two carriageways about 11 m apart, and a position nearer the westbound one.
    func testTheDirectionOfTravelChoosesTheCarriageway() {
        let eastbound = post(50.0, -1.0, bearing: 90, letter: "A")
        let westbound = post(50.0001, -1.0, bearing: 270, letter: "B")
        let store = PostStore(posts: [eastbound, westbound])
        let lat = 50.00008, lng = -1.0

        let byPosition = store.findNearest(lat: lat, lng: lng, heading: nil, speed: nil, useHeading: true)
        XCTAssertEqual(byPosition?.index, 1)
        XCTAssertEqual(byPosition?.headingUsed, false)

        let goingEast = store.findNearest(lat: lat, lng: lng, heading: 90, speed: 30, useHeading: true)
        XCTAssertEqual(goingEast?.index, 0)
        XCTAssertEqual(goingEast?.headingUsed, true)

        let goingWest = store.findNearest(lat: lat, lng: lng, heading: 270, speed: 30, useHeading: true)
        XCTAssertEqual(goingWest?.index, 1)
        XCTAssertEqual(goingWest?.headingUsed, true)

        let tooSlow = store.findNearest(lat: lat, lng: lng, heading: 90, speed: 2.5, useHeading: true)
        XCTAssertEqual(tooSlow?.index, 1)
        XCTAssertEqual(tooSlow?.headingUsed, false)

        let preferenceOff = store.findNearest(lat: lat, lng: lng, heading: 90, speed: 30, useHeading: false)
        XCTAssertEqual(preferenceOff?.index, 1)
        XCTAssertEqual(preferenceOff?.headingUsed, false)

        let noHeading = store.findNearest(lat: lat, lng: lng, heading: Double.nan, speed: 30, useHeading: true)
        XCTAssertEqual(noHeading?.index, 1)
        XCTAssertEqual(noHeading?.headingUsed, false)
    }

    func testExactlyNinetyDegreesOffIsKeptAndJustOverIsSkipped() {
        let store = PostStore(posts: [post(50.0, -1.0, bearing: 0)])
        let kept = store.findNearest(lat: 50.0, lng: -1.0, heading: 90, speed: 30, useHeading: true)
        XCTAssertEqual(kept?.headingUsed, true)
        // Skipped by the heading, then found again by the pass that ignores it.
        let skipped = store.findNearest(lat: 50.0, lng: -1.0, heading: 90.5, speed: 30, useHeading: true)
        XCTAssertEqual(skipped?.index, 0)
        XCTAssertEqual(skipped?.headingUsed, false)
    }

    func testAPostWithNoBearingIsNeverConfirmedByHeading() {
        let wrongWay = post(50.0, -1.0, bearing: 90)
        let unknown = post(50.01, -1.0, bearing: nil)
        let store = PostStore(posts: [wrongWay, unknown])
        let result = store.findNearest(lat: 50.0, lng: -1.0, heading: 270, speed: 30, useHeading: true)
        XCTAssertEqual(result?.index, 1, "the nearer post flows the other way, so the one with no bearing is left")
        XCTAssertEqual(result?.headingUsed, false)
    }

    func testTheFirstOfTwoEquallyNearPostsWins() {
        let store = PostStore(posts: [post(51.0, -1.0, bearing: nil, letter: "A"), post(51.0, -1.0, bearing: nil, letter: "B")])
        XCTAssertEqual(store.findNearest(lat: 51.0003, lng: -1.0002, heading: nil, speed: nil, useHeading: true)?.index, 0)
        XCTAssertEqual(store.findNearest(lat: 51.0003, lng: -1.0002, heading: 45, speed: 30, useHeading: true)?.index, 0)
    }

    func testNoPostsGivesNoAnswer() {
        XCTAssertNil(PostStore(posts: []).findNearest(lat: 50, lng: -1, heading: nil, speed: nil, useHeading: true))
    }

    // MARK: reading posts.tsv

    func testEmptyFieldsAreKeptAndHeaderLinesSkipped() throws {
        let text = "# markerpost-posts\tv1\t2\tabc123\n"
            + "# lat\tlng\tbearing\troadClass\troad\tkm\tletter\tref\tcontext\n"
            + "50.5\t-1.25\t\tO\tM27 / M275 interchange\t\t\tODD REF\t\n"
            + "51\t-1\t272.5\tM\tM3\t12.3\tA\tP12/3A\tJ4 – J5\n"
        let store = try PostStore(tsv: text)
        XCTAssertEqual(store.digest, "abc123")
        XCTAssertEqual(store.posts.count, 2)

        let odd = store.posts[0]
        XCTAssertEqual(odd.lat, 50.5)
        XCTAssertEqual(odd.lng, -1.25)
        XCTAssertNil(odd.bearing)
        XCTAssertEqual(odd.roadClass, "O")
        XCTAssertEqual(odd.road, "M27 / M275 interchange")
        XCTAssertEqual(odd.km, "")
        XCTAssertEqual(odd.letter, "")
        XCTAssertEqual(odd.ref, "ODD REF")
        XCTAssertEqual(odd.context, "")

        let usual = store.posts[1]
        XCTAssertEqual(usual.bearing, 272.5)
        XCTAssertEqual(usual.road, "M3")
        XCTAssertEqual(usual.km, "12.3")
        XCTAssertEqual(usual.letter, "A")
        XCTAssertEqual(usual.ref, "P12/3A")
        XCTAssertEqual(usual.context, "J4 – J5")
    }

    func testWindowsLineEndingsAreAccepted() throws {
        let store = try PostStore(tsv: "# markerpost-posts\tv1\t1\tabc\r\n51\t-1\t90\tM\tM3\t12.3\tA\tP12/3A\tAt J5\r\n")
        XCTAssertEqual(store.posts.count, 1)
        XCTAssertEqual(store.posts[0].context, "At J5")
    }

    func testADamagedListIsRefused() {
        // Fewer posts than the first line promises: the file was cut short.
        XCTAssertThrowsError(try PostStore(tsv: "# markerpost-posts\tv1\t2\tabc\n51\t-1\t90\tM\tM3\t12.3\tA\tP12/3A\t\n")) { error in
            XCTAssertEqual(error as? PostDataError, PostDataError.countMismatch(declared: 2, found: 1))
        }
        // A line with a field missing.
        XCTAssertThrowsError(try PostStore(tsv: "51\t-1\t90\tM\tM3\t12.3\tA\tP12/3A\n")) { error in
            XCTAssertEqual(error as? PostDataError, PostDataError.malformedLine(1))
        }
        // A position that is not a number.
        XCTAssertThrowsError(try PostStore(tsv: "north\t-1\t90\tM\tM3\t12.3\tA\tP12/3A\t\n")) { error in
            XCTAssertEqual(error as? PostDataError, PostDataError.malformedLine(1))
        }
        // A format this code does not know.
        XCTAssertThrowsError(try PostStore(tsv: "# markerpost-posts\tv2\t1\tabc\n51\t-1\t90\tM\tM3\t12.3\tA\tP12/3A\t\n")) { error in
            XCTAssertEqual(error as? PostDataError, PostDataError.unsupportedFormat("v2"))
        }
        XCTAssertThrowsError(try PostStore(tsv: "# markerpost-posts\tv1\t0\tabc\n")) { error in
            XCTAssertEqual(error as? PostDataError, PostDataError.noPosts)
        }
    }

    // MARK: the "confirmed" label

    func testACarriagewayStaysConfirmedUntilTheVehicleHasMoved() {
        let a = post(50.9, -1.3, bearing: 90, letter: "A")
        let b = post(50.9001, -1.3, bearing: 270, letter: "B")
        let otherRoad = post(50.9, -1.3, bearing: 90, road: "M3", letter: "A")
        var rule = CarriagewayConfirmation()

        XCTAssertFalse(rule.confirmed(post: a, headingUsed: false, lat: 50.9, lng: -1.3), "nothing has been confirmed yet")
        XCTAssertTrue(rule.confirmed(post: a, headingUsed: true, lat: 50.9, lng: -1.3))
        XCTAssertTrue(rule.confirmed(post: a, headingUsed: false, lat: 50.9, lng: -1.3), "stopped on the same carriageway")
        XCTAssertFalse(rule.confirmed(post: b, headingUsed: false, lat: 50.9, lng: -1.3), "the other carriageway is not confirmed")
        XCTAssertFalse(rule.confirmed(post: otherRoad, headingUsed: false, lat: 50.9, lng: -1.3), "another road is not confirmed")

        // 0.002 degrees of latitude is about 222 m; 0.003 is about 334 m.
        XCTAssertTrue(rule.confirmed(post: a, headingUsed: false, lat: 50.902, lng: -1.3))
        XCTAssertFalse(rule.confirmed(post: a, headingUsed: false, lat: 50.903, lng: -1.3), "more than 300 m from where it was confirmed")

        rule.reset()
        XCTAssertFalse(rule.confirmed(post: a, headingUsed: false, lat: 50.9, lng: -1.3))
    }

    // MARK: stale

    func testHowOldAFixMayBe() {
        XCTAssertEqual(StaleRule.limit(lastSpeed: 30), 15)
        XCTAssertEqual(StaleRule.limit(lastSpeed: nil), 30)
        XCTAssertEqual(StaleRule.limit(lastSpeed: 0), 120)
        XCTAssertEqual(StaleRule.limit(lastSpeed: 2.5), 120, "at the threshold counts as stationary")
        XCTAssertEqual(StaleRule.limit(lastSpeed: Double.nan), 30, "not a number is an unknown speed, as in the web app")

        XCTAssertFalse(StaleRule.isStale(fixAge: 15, lastSpeed: 30))
        XCTAssertTrue(StaleRule.isStale(fixAge: 15.1, lastSpeed: 30))
        XCTAssertFalse(StaleRule.isStale(fixAge: 30, lastSpeed: nil))
        XCTAssertTrue(StaleRule.isStale(fixAge: 31, lastSpeed: nil))
        XCTAssertFalse(StaleRule.isStale(fixAge: 120, lastSpeed: 1))
        XCTAssertTrue(StaleRule.isStale(fixAge: 121, lastSpeed: 1))
        XCTAssertFalse(StaleRule.isStale(fixAge: -5, lastSpeed: 30), "a fix stamped slightly in the future is not stale")
    }

    /// iOS stops sending positions once the phone stops moving. That pause
    /// only excuses a fix that was taken where the vehicle came to rest.
    func testAPauseOnlyExcusesAFixTakenWhereTheVehicleStopped() {
        let began = Date(timeIntervalSince1970: 1_795_000_000)
        let justBefore = began.addingTimeInterval(-2)

        XCTAssertTrue(StaleRule.pauseExplainsSilence(pauseBegan: began, fixTime: justBefore, lastSpeed: 0))
        XCTAssertTrue(StaleRule.pauseExplainsSilence(pauseBegan: began, fixTime: justBefore, lastSpeed: nil))
        XCTAssertTrue(StaleRule.pauseExplainsSilence(pauseBegan: began, fixTime: justBefore, lastSpeed: 2.5),
                      "at the threshold counts as stopped")
        XCTAssertFalse(StaleRule.pauseExplainsSilence(pauseBegan: nil, fixTime: justBefore, lastSpeed: 0),
                       "updates are not paused")
        XCTAssertFalse(StaleRule.pauseExplainsSilence(pauseBegan: began, fixTime: justBefore, lastSpeed: 30),
                       "a fix taken at speed is not where the vehicle stopped")

        // How long before the pause the fix may have been taken.
        XCTAssertTrue(StaleRule.pauseExplainsSilence(pauseBegan: began, fixTime: began.addingTimeInterval(-15), lastSpeed: 0))
        XCTAssertFalse(StaleRule.pauseExplainsSilence(pauseBegan: began, fixTime: began.addingTimeInterval(-16), lastSpeed: 0),
                       "positions had already stopped arriving before the pause")

        // A fix that arrives while updates are paused.
        let during = began.addingTimeInterval(40)
        XCTAssertTrue(StaleRule.pauseExplainsSilence(pauseBegan: began, fixTime: during, lastSpeed: 0))
        XCTAssertFalse(StaleRule.pauseExplainsSilence(pauseBegan: began, fixTime: during, lastSpeed: 30))
    }

    // MARK: snapshot

    func testASnapshotCopiesThePostsStringsUnchanged() {
        let fixTime = Date(timeIntervalSince1970: 1_795_000_000)
        let snapshot = post(50.9, -1.3, bearing: 90, letter: "A")
            .snapshot(confirmed: true, fixTime: fixTime, stale: false, tracking: true)
        XCTAssertEqual(snapshot.road, "M27")
        XCTAssertEqual(snapshot.roadClass, "M")
        XCTAssertEqual(snapshot.km, "17.4")
        XCTAssertEqual(snapshot.letter, "A")
        XCTAssertEqual(snapshot.ref, "P17/4A")
        XCTAssertEqual(snapshot.context, "J4 – J5")
        XCTAssertTrue(snapshot.confirmed)
        XCTAssertEqual(snapshot.fixTime, fixTime)
        XCTAssertFalse(snapshot.stale)
        XCTAssertTrue(snapshot.tracking)
    }
}
