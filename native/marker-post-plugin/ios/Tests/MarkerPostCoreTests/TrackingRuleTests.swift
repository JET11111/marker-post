import Foundation
import XCTest
import MarkerPostCore

// The rules the live tracker follows that need no phone to check: which fixes
// it uses and what time they carry, what it shows far from any recorded post,
// how a distance is written, how often it sends anything to the surfaces, and
// when a Live Activity that has gone was taken off the screen by the user.
//
//   node scripts/build-native-data.mjs
//   cd native/marker-post-plugin && MARKERPOST_CORE_ONLY=1 swift test

final class TrackingRuleTests: XCTestCase {

    private let fixTime = Date(timeIntervalSince1970: 1_795_000_000)

    /// One post on the M27, carriageway A, traffic flowing due east.
    private func onePostStore() -> PostStore {
        return PostStore(posts: [
            Post(lat: 50.0, lng: -1.0, bearing: 90, roadClass: "M", road: "M27",
                 km: "17.4", letter: "A", ref: "P17/4A", context: "J4 – J5")
        ])
    }

    /// The snapshot for a fix at this latitude (the post is at 50.0), due
    /// north of the post. 0.001 degrees of latitude is about 111 m.
    private func snapshot(_ store: PostStore, lat: Double, heading: Double?, speed: Double?,
                          memory: inout CarriagewayConfirmation) -> PostSnapshot? {
        return store.liveSnapshot(lat: lat, lng: -1.0, heading: heading, speed: speed, useHeading: true,
                                  fixTime: fixTime, confirmation: &memory)
    }

    // MARK: which fixes are used

    func testAFixThatIsTooRoughIsNotUsed() {
        XCTAssertEqual(FixRule.maxUsableAccuracyM, 100)
        XCTAssertTrue(FixRule.accuracyIsUsable(5))
        XCTAssertTrue(FixRule.accuracyIsUsable(100), "exactly 100 m is still used")
        XCTAssertFalse(FixRule.accuracyIsUsable(100.5))
        XCTAssertFalse(FixRule.accuracyIsUsable(1500))
        XCTAssertTrue(FixRule.accuracyIsUsable(nil), "a fix with no accuracy figure is accepted")
        XCTAssertTrue(FixRule.accuracyIsUsable(Double.nan), "a figure that is not a number is no figure")
    }

    func testTheTimeOfAFixIsWhenThePositionWasTrueAndNeverInTheFuture() {
        let now = Date(timeIntervalSince1970: 1_795_000_000)
        let earlier = now.addingTimeInterval(-3)
        let later = now.addingTimeInterval(40)
        XCTAssertEqual(FixRule.fixTime(reported: earlier, now: now), earlier, "not the time it arrived")
        XCTAssertEqual(FixRule.fixTime(reported: now, now: now), now)
        XCTAssertEqual(FixRule.fixTime(reported: later, now: now), now, "a time in the future is brought back to now")
    }

    // MARK: stale

    /// The web app's staleAfterMs: 15 s above 2.5 m/s, 120 s at or below it,
    /// 30 s when the speed is unknown, and "not a number" is unknown.
    func testTheStaleLimitsAreTheWebApps() {
        XCTAssertEqual(StaleRule.limit(lastSpeed: 31), 15)
        XCTAssertEqual(StaleRule.limit(lastSpeed: 2.6), 15)
        XCTAssertEqual(StaleRule.limit(lastSpeed: 2.5), 120)
        XCTAssertEqual(StaleRule.limit(lastSpeed: 0), 120)
        XCTAssertEqual(StaleRule.limit(lastSpeed: nil), 30)
        XCTAssertEqual(StaleRule.limit(lastSpeed: Double.nan), 30)

        XCTAssertFalse(StaleRule.isStale(fixAge: 30, lastSpeed: Double.nan))
        XCTAssertTrue(StaleRule.isStale(fixAge: 31, lastSpeed: Double.nan))
    }

    // MARK: distances

    func testADistanceIsWrittenAsTheWebAppWritesIt() {
        // Whole metres below 1000 m.
        XCTAssertEqual(DistanceText.fmtDist(0), "0 m")
        XCTAssertEqual(DistanceText.fmtDist(38), "38 m")
        XCTAssertEqual(DistanceText.fmtDist(38.4), "38 m")
        XCTAssertEqual(DistanceText.fmtDist(0.5), "1 m", "half way goes up")
        XCTAssertEqual(DistanceText.fmtDist(250.5), "251 m", "half way goes up")
        XCTAssertEqual(DistanceText.fmtDist(999.4), "999 m")
        XCTAssertEqual(DistanceText.fmtDist(999.5), "1000 m", "still under 1000 m, so still in metres")

        // Two decimal places below 10 km.
        XCTAssertEqual(DistanceText.fmtDist(1000), "1.00 km")
        XCTAssertEqual(DistanceText.fmtDist(1240), "1.24 km")
        XCTAssertEqual(DistanceText.fmtDist(9999), "10.00 km", "still under 10 km, so still two places")

        // One decimal place from 10 km.
        XCTAssertEqual(DistanceText.fmtDist(10000), "10.0 km")
        XCTAssertEqual(DistanceText.fmtDist(12400), "12.4 km")
        XCTAssertEqual(DistanceText.fmtDist(123456.789), "123.5 km")
    }

    /// JavaScript's toFixed rounds the exact value a number holds, and takes
    /// the higher figure when that is exactly half way. These are the cases a
    /// careless port gets wrong.
    func testADistanceIsRoundedAsJavaScriptRoundsIt() {
        // Exactly half way in binary (1.125, 1.375, 12.25, 12.75): up.
        XCTAssertEqual(DistanceText.fmtDist(1125), "1.13 km")
        XCTAssertEqual(DistanceText.fmtDist(1375), "1.38 km")
        XCTAssertEqual(DistanceText.fmtDist(12250), "12.3 km")
        XCTAssertEqual(DistanceText.fmtDist(12750), "12.8 km")
        // Looks half way, but the number held is a hair below (1.00499999…, 9.99499999…): down.
        XCTAssertEqual(DistanceText.fmtDist(1005), "1.00 km")
        XCTAssertEqual(DistanceText.fmtDist(9995), "9.99 km")
        // Looks half way, but the number held is a hair above (10.0500000…1): up.
        XCTAssertEqual(DistanceText.fmtDist(10050), "10.1 km")
    }

    func testSomethingThatIsNotADistanceIsNotWritten() {
        XCTAssertEqual(DistanceText.fmtDist(Double.nan), "")
        XCTAssertEqual(DistanceText.fmtDist(Double.infinity), "")
        XCTAssertEqual(DistanceText.fmtDist(-5), "")
    }

    // MARK: far from any recorded post

    func testAPostMoreThan250MetresAwayIsFar() {
        XCTAssertEqual(FarPost.farPostM, 250)
        XCTAssertFalse(FarPost.isFar(0))
        XCTAssertFalse(FarPost.isFar(250), "exactly 250 m is not far")
        XCTAssertTrue(FarPost.isFar(250.01))
        XCTAssertTrue(FarPost.isFar(12400))

        XCTAssertEqual(FarPost.context(distance: 333.58), "Nearest recorded post · 334 m away")
        XCTAssertEqual(FarPost.context(distance: 1240), "Nearest recorded post · 1.24 km away")
        XCTAssertEqual(FarPost.context(distance: 12400), "Nearest recorded post · 12.4 km away")
    }

    func testNearAPostTheSnapshotIsThePostsOwn() {
        let store = onePostStore()
        var memory = CarriagewayConfirmation()

        // About 56 m from the post, travelling with its carriageway.
        let near = snapshot(store, lat: 50.0005, heading: 90, speed: 30, memory: &memory)
        XCTAssertEqual(near?.road, "M27")
        XCTAssertEqual(near?.ref, "P17/4A")
        XCTAssertEqual(near?.context, "J4 – J5")
        XCTAssertEqual(near?.confirmed, true)
        XCTAssertEqual(near?.fixTime, fixTime)
        XCTAssertEqual(near?.stale, false)
        XCTAssertEqual(near?.tracking, true)

        // About 222 m: a long way for a motorway, but not far.
        let further = snapshot(store, lat: 50.002, heading: 90, speed: 30, memory: &memory)
        XCTAssertEqual(further?.context, "J4 – J5")
        XCTAssertEqual(further?.confirmed, true)
    }

    func testFarFromAnyPostTheLineSaysSoAndTheCarriagewayIsNotConfirmed() {
        let store = onePostStore()
        var memory = CarriagewayConfirmation()

        // About 334 m from the post. The heading matches the post's
        // carriageway, and would confirm it if the post were near.
        let far = snapshot(store, lat: 50.003, heading: 90, speed: 30, memory: &memory)
        XCTAssertEqual(far?.context, "Nearest recorded post · 334 m away")
        XCTAssertEqual(far?.confirmed, false, "never confirmed when far, whatever the heading says")
        // Everything else is still the post's own.
        XCTAssertEqual(far?.road, "M27")
        XCTAssertEqual(far?.roadClass, "M")
        XCTAssertEqual(far?.km, "17.4")
        XCTAssertEqual(far?.letter, "A")
        XCTAssertEqual(far?.ref, "P17/4A")
        XCTAssertEqual(far?.fixTime, fixTime)
        XCTAssertEqual(far?.stale, false)
        XCTAssertEqual(far?.tracking, true)

        // About 1.23 km and 11.1 km.
        let further = snapshot(store, lat: 50.0111, heading: nil, speed: nil, memory: &memory)
        XCTAssertEqual(further?.context, "Nearest recorded post · 1.23 km away")
        XCTAssertEqual(further?.confirmed, false)
        let furthest = snapshot(store, lat: 50.1, heading: 90, speed: 30, memory: &memory)
        XCTAssertEqual(furthest?.context, "Nearest recorded post · 11.1 km away")
        XCTAssertEqual(furthest?.confirmed, false)
    }

    func testAFarFixNeitherMakesNorForgetsAConfirmation() {
        let store = onePostStore()
        var memory = CarriagewayConfirmation()

        // Far, with a heading that matches. Then near and standing still: the
        // far fix must not have left a confirmation behind.
        _ = snapshot(store, lat: 50.003, heading: 90, speed: 30, memory: &memory)
        let stopped = snapshot(store, lat: 50.0005, heading: nil, speed: 0, memory: &memory)
        XCTAssertEqual(stopped?.confirmed, false)

        // Confirmed near the post, then far, then back where it was confirmed
        // and standing still: the far fix must not have wiped the
        // confirmation either.
        let moving = snapshot(store, lat: 50.0005, heading: 90, speed: 30, memory: &memory)
        XCTAssertEqual(moving?.confirmed, true)
        let away = snapshot(store, lat: 50.003, heading: 90, speed: 30, memory: &memory)
        XCTAssertEqual(away?.confirmed, false)
        let back = snapshot(store, lat: 50.0005, heading: nil, speed: 0, memory: &memory)
        XCTAssertEqual(back?.confirmed, true)
    }

    func testNoPostsGivesNoSnapshot() {
        var memory = CarriagewayConfirmation()
        let none = snapshot(PostStore(posts: []), lat: 50.0, heading: nil, speed: nil, memory: &memory)
        XCTAssertNil(none)
    }

    /// The line under a far post is how a far post is recognised, so no
    /// recorded post may have a line of its own that reads like one.
    func testTheFarLineIsRecognisedAndNoRecordedPostHasOne() throws {
        XCTAssertTrue(FarPost.isContext(FarPost.context(distance: 250.5)))
        XCTAssertTrue(FarPost.isContext(FarPost.context(distance: 1240)))
        XCTAssertTrue(FarPost.isContext(FarPost.context(distance: 12400)))
        XCTAssertFalse(FarPost.isContext(""))
        XCTAssertFalse(FarPost.isContext("J4 – J5"))
        XCTAssertFalse(FarPost.isContext("A303 jct · 1.24 km from post"))
        XCTAssertFalse(FarPost.isContext("Link M27B/M3B · survey date unknown"))

        let recorded = try PostStore.loadBundled()
        XCTAssertGreaterThan(recorded.posts.count, 1000, "posts.tsv looks cut short")
        let clashes = recorded.posts.filter { FarPost.isContext($0.context) }
        XCTAssertTrue(clashes.isEmpty,
                      "\(clashes.count) recorded post(s) have a line that reads like a far post's, the first: "
                        + (clashes.first.map { "\($0.ref) \"\($0.context)\"" } ?? ""))
    }

    func testTwoSnapshotsOfAFarPostDifferOnlyInTheDistance() throws {
        let store = onePostStore()
        var memory = CarriagewayConfirmation()
        // About 334 m and 345 m from the post, then about 56 m.
        let first = snapshot(store, lat: 50.003, heading: 90, speed: 30, memory: &memory)
        let second = snapshot(store, lat: 50.0031, heading: 90, speed: 30, memory: &memory)
        let third = snapshot(store, lat: 50.0005, heading: nil, speed: 0, memory: &memory)
        let far = try XCTUnwrap(first)
        let further = try XCTUnwrap(second)
        let near = try XCTUnwrap(third)

        XCTAssertNotEqual(far.context, further.context)
        XCTAssertTrue(FarPost.onlyDistanceDiffers(far, further))
        XCTAssertTrue(FarPost.onlyDistanceDiffers(further, far))
        XCTAssertFalse(FarPost.onlyDistanceDiffers(far, far), "nothing differs at all")
        XCTAssertFalse(FarPost.onlyDistanceDiffers(near, far), "coming within reach of the post is a real change")
        XCTAssertFalse(FarPost.onlyDistanceDiffers(far, near))

        var gone = further
        gone.stale = true
        XCTAssertFalse(FarPost.onlyDistanceDiffers(far, gone), "going stale is a real change")
        var another = further
        another.ref = "P17/5A"
        XCTAssertFalse(FarPost.onlyDistanceDiffers(far, another), "another post is a real change")
    }

    // MARK: how often anything is sent to the surfaces

    private func display(ref: String = "P17/4A", context: String = "J4 – J5", confirmed: Bool = true,
                         stale: Bool = false, secondsOn: TimeInterval = 0,
                         problem: String? = nil, paused: Bool = false) -> ShowRule.Display {
        let post = PostSnapshot(road: "M27", roadClass: "M", km: "17.4", letter: "A", ref: ref, context: context,
                                confirmed: confirmed, fixTime: fixTime.addingTimeInterval(secondsOn),
                                stale: stale, tracking: true)
        return ShowRule.Display(snapshot: post, problem: problem, paused: paused)
    }

    /// Whether `next` would be sent, `seconds` after `shown` was.
    private func due(_ shown: ShowRule.Display, _ next: ShowRule.Display, after seconds: TimeInterval,
                     dayChanged: Bool = false) -> Bool {
        return ShowRule.isDue(from: shown, to: next, sinceShown: seconds, dayChanged: dayChanged)
    }

    func testTheTimingsAreTheContracts() {
        XCTAssertEqual(ShowRule.minimumInterval, 1)
        XCTAssertEqual(ShowRule.heartbeatInterval, 30)
        XCTAssertEqual(ShowRule.farDistanceInterval, 5)
        XCTAssertEqual(ShowRule.pausedRefreshInterval, 600)
        XCTAssertLessThan(ShowRule.farDistanceInterval, StaleRule.movingLimit,
                          "a distance held back must still be shown while its fix is current")
    }

    func testAChangeIsShownAtMostOnceASecond() {
        let shown = display()
        let changes: [ShowRule.Display] = [
            display(ref: "P17/5A"),
            display(context: "At J5"),
            display(confirmed: false),
            display(stale: true),
            display(problem: "Precise Location is off"),
            ShowRule.Display(snapshot: nil, problem: nil, paused: false)
        ]
        for next in changes {
            XCTAssertEqual(ShowRule.difference(from: shown, to: next), .change)
            XCTAssertFalse(due(shown, next, after: 0.5))
            XCTAssertTrue(due(shown, next, after: 1))
            XCTAssertTrue(due(shown, next, after: -3), "the clock was put back: do not wait")
        }
        // The first post of a session.
        XCTAssertEqual(ShowRule.difference(from: ShowRule.Display.waiting, to: shown), .change)
        XCTAssertTrue(due(ShowRule.Display.waiting, shown, after: 5))
        // Nothing to show yet, and nothing was shown.
        XCTAssertEqual(ShowRule.difference(from: ShowRule.Display.waiting, to: ShowRule.Display.waiting), .nothing)
        XCTAssertFalse(due(ShowRule.Display.waiting, ShowRule.Display.waiting, after: 3600))
    }

    func testWhileThePostIsUnchangedTheTimeIsRefreshedEveryThirtySeconds() {
        let shown = display()
        let later = display(secondsOn: 12)
        XCTAssertEqual(ShowRule.difference(from: shown, to: later), .nothing)
        XCTAssertFalse(due(shown, later, after: 12))
        XCTAssertFalse(due(shown, later, after: 29.9))
        XCTAssertTrue(due(shown, later, after: 30))
        // No newer fix at all, and no pause to account for it: nothing is
        // sent, however long it has been. The stale check deals with that.
        XCTAssertFalse(due(shown, shown, after: 3600))
    }

    func testTheDistanceToAFarPostIsShownEveryFiveSeconds() {
        let shown = display(context: FarPost.context(distance: 1240), confirmed: false)
        let moved = display(context: FarPost.context(distance: 1270), confirmed: false, secondsOn: 1)
        XCTAssertEqual(ShowRule.difference(from: shown, to: moved), .farDistance)
        XCTAssertFalse(due(shown, moved, after: 1))
        XCTAssertFalse(due(shown, moved, after: 4.9))
        XCTAssertTrue(due(shown, moved, after: 5))

        // Coming within reach of the post, or leaving it behind, is shown
        // as promptly as any other change.
        let reached = display(confirmed: false, secondsOn: 1)
        XCTAssertEqual(ShowRule.difference(from: shown, to: reached), .change)
        XCTAssertTrue(due(shown, reached, after: 1))
        XCTAssertEqual(ShowRule.difference(from: reached, to: shown), .change)
        // So is a problem that comes up while far from any post.
        let troubled = display(context: FarPost.context(distance: 1270), confirmed: false,
                               secondsOn: 1, problem: "Location permission needed")
        XCTAssertEqual(ShowRule.difference(from: shown, to: troubled), .change)
    }

    /// iOS stops sending positions once the phone stops moving. The display
    /// is told at once, and then sent again every ten minutes so that iOS
    /// does not mark it out of date while the app is still running.
    func testAPauseIsShownAtOnceAndAParkedDisplayIsSentAgainEveryTenMinutes() {
        let moving = display()
        let parked = display(paused: true)
        XCTAssertEqual(ShowRule.difference(from: moving, to: parked), .justPaused)
        XCTAssertTrue(due(moving, parked, after: 0), "does not wait its second")

        XCTAssertEqual(ShowRule.difference(from: parked, to: parked), .nothing)
        XCTAssertFalse(due(parked, parked, after: 599))
        XCTAssertTrue(due(parked, parked, after: 600))

        // Updates resuming shows nothing new, but is sent like a change.
        XCTAssertEqual(ShowRule.difference(from: parked, to: moving), .change)
        XCTAssertFalse(due(parked, moving, after: 0.5))
        XCTAssertTrue(due(parked, moving, after: 1))

        // A pause that begins as the post changes is still told at once.
        let parkedElsewhere = display(ref: "P17/5A", paused: true)
        XCTAssertEqual(ShowRule.difference(from: moving, to: parkedElsewhere), .justPaused)
        XCTAssertTrue(due(moving, parkedElsewhere, after: 0))
    }

    /// A time is written as "14:32", with its day in front once it is not
    /// today's. A Live Activity is only drawn again when it is sent
    /// something, so after midnight it is sent again whatever it shows.
    func testAfterMidnightTheDisplayIsSentAgain() throws {
        let london = try XCTUnwrap(TimeZone(identifier: "Europe/London"))
        // 22 November 2026, a winter day: London is on GMT.
        let lateEvening = Date(timeIntervalSince1970: 1_795_391_880)      // 23:58
        let justAfterMidnight = Date(timeIntervalSince1970: 1_795_392_005) // 00:00:05 the next day
        let earlierThatEvening = Date(timeIntervalSince1970: 1_795_388_400) // 23:00
        XCTAssertTrue(ShowRule.dayChanged(since: lateEvening, now: justAfterMidnight, timeZone: london))
        XCTAssertFalse(ShowRule.dayChanged(since: earlierThatEvening, now: lateEvening, timeZone: london))
        XCTAssertFalse(ShowRule.dayChanged(since: lateEvening, now: lateEvening, timeZone: london))
        // The day is the phone's own: in New York it is still the same evening.
        let newYork = try XCTUnwrap(TimeZone(identifier: "America/New_York"))
        XCTAssertFalse(ShowRule.dayChanged(since: lateEvening, now: justAfterMidnight, timeZone: newYork))

        // A stale post, a parked one and the wait for the first fix all sit
        // unchanged. None would be sent again but for the change of day.
        let lastKnown = display(stale: true)
        let parked = display(paused: true)
        for unchanged in [lastKnown, parked, ShowRule.Display.waiting] {
            XCTAssertFalse(due(unchanged, unchanged, after: 125))
            XCTAssertTrue(due(unchanged, unchanged, after: 125, dayChanged: true))
        }
        // It does not wait its second either: it happens once a night.
        XCTAssertTrue(due(lastKnown, display(), after: 0.2, dayChanged: true))
    }

    // MARK: a Live Activity that has gone

    func testADisplayThatGoesEarlyWasRemovedByTheUser() {
        let started = Date(timeIntervalSince1970: 1_795_000_000)
        // iOS ends a Live Activity eight hours after it starts.
        let dueToEnd = started.addingTimeInterval(8 * 60 * 60)

        XCTAssertTrue(DisplayRule.removedByUser(now: started.addingTimeInterval(3 * 60 * 60),
                                                dueToEnd: dueToEnd, followOnStarts: nil))
        XCTAssertTrue(DisplayRule.removedByUser(now: dueToEnd.addingTimeInterval(-301),
                                                dueToEnd: dueToEnd, followOnStarts: nil))
        XCTAssertFalse(DisplayRule.removedByUser(now: dueToEnd.addingTimeInterval(-300),
                                                 dueToEnd: dueToEnd, followOnStarts: nil),
                       "in the last five minutes it is the system tidying up")
        XCTAssertFalse(DisplayRule.removedByUser(now: dueToEnd.addingTimeInterval(60),
                                                 dueToEnd: dueToEnd, followOnStarts: nil),
                       "after the limit it is the system tidying up")
    }

    func testADisplayThatGoesWhenItsFollowOnIsDueWasNotRemovedByTheUser() {
        let started = Date(timeIntervalSince1970: 1_795_000_000)
        let dueToEnd = started.addingTimeInterval(8 * 60 * 60)
        // The follow-on is scheduled a quarter of an hour before the limit.
        let followOn = started.addingTimeInterval(7 * 60 * 60 + 45 * 60)

        XCTAssertTrue(DisplayRule.removedByUser(now: started.addingTimeInterval(3 * 60 * 60),
                                                dueToEnd: dueToEnd, followOnStarts: followOn),
                      "the follow-on is hours away, so it does not explain the display going")
        XCTAssertTrue(DisplayRule.removedByUser(now: followOn.addingTimeInterval(-61),
                                                dueToEnd: dueToEnd, followOnStarts: followOn))
        XCTAssertFalse(DisplayRule.removedByUser(now: followOn.addingTimeInterval(-60),
                                                 dueToEnd: dueToEnd, followOnStarts: followOn),
                       "the system may be making room for the follow-on")
        XCTAssertFalse(DisplayRule.removedByUser(now: followOn.addingTimeInterval(10),
                                                 dueToEnd: dueToEnd, followOnStarts: followOn))
    }
}
