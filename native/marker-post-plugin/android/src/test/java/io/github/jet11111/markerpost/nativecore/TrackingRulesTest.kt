package io.github.jet11111.markerpost.nativecore

import java.util.TimeZone
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The tracking rules that need no phone to check: which fixes are used and
 * the time they carry, when the carriageway counts as confirmed, when a post
 * counts as stale, what is shown a long way from every recorded post, how a
 * distance and a time are written, what counts as a visible change, what the
 * notification says and in what order, how many lines the widget gives the
 * line under the post, and the one-line forms of a post.
 */
class TrackingRulesTest {

    private val fixTime = 1_795_000_000_000L

    /** A post on the given carriageway at 51.0, -1.0, traffic flowing due east. */
    private fun post(road: String, letter: String): Post =
        Post(51.0, -1.0, 90.0, "M", road, "17.4", letter, "P17/4" + letter, "J4 – J5")

    private fun snapshot(): Snapshot =
        Snapshot("M27", "M", "17.4", "A", "P17/4A", "J4 – J5", true, fixTime, false, true)

    /**
     * What the tracker shows for a fix at this latitude, due north of the one
     * post there is (at 51.0). 0.001 degrees of latitude is about 111 m.
     */
    private fun forFix(lat: Double, heading: Double?, speed: Double?, memory: CarriagewayMemory): Snapshot =
        Snapshot.forFix(listOf(post("M27", "A")), lat, -1.0, heading, speed, true, fixTime, memory)
            ?: throw AssertionError("no snapshot for a fix at latitude " + lat)

    // ---- which fixes are used ----

    @Test
    fun aFixThatIsTooRoughIsNotUsed() {
        assertEquals(100.0, TrackingRules.MAX_USABLE_ACCURACY_M, 0.0)
        assertTrue(TrackingRules.accuracyIsUsable(5.0))
        assertTrue("exactly 100 m is still used", TrackingRules.accuracyIsUsable(100.0))
        assertFalse(TrackingRules.accuracyIsUsable(100.5))
        assertFalse(TrackingRules.accuracyIsUsable(1500.0))
        assertTrue("a fix with no accuracy figure is accepted", TrackingRules.accuracyIsUsable(null))
        assertTrue("a figure that is not a number is no figure", TrackingRules.accuracyIsUsable(Double.NaN))
    }

    /** The age of a fix is taken off "now" to give the time the position was true. */
    @Test
    fun theTimeOfAFixIsWhenThePositionWasTrueAndNeverInTheFuture() {
        assertEquals(10_000L, TrackingRules.MAX_FIX_AGE_MS)
        // Three seconds old by the uptime clock: that is its age, not "it arrived just now".
        assertEquals(3_000L, TrackingRules.fixAgeMs(3_000L, 3_000L))
        assertEquals(0L, TrackingRules.fixAgeMs(0L, 0L))
        assertEquals("a stamp in the future is brought back to now", 0L, TrackingRules.fixAgeMs(-40_000L, 0L))
        assertEquals("at the limit it still has its own age", 10_000L, TrackingRules.fixAgeMs(10_000L, 10_000L))
        // The ordinary clock can be wrong (a receiver with the wrong date, a
        // phone set to the wrong time). It is not asked about a fix that is
        // fresh by the uptime clock.
        assertEquals(3_000L, TrackingRules.fixAgeMs(3_000L, 600_000_000L))
        assertEquals(3_000L, TrackingRules.fixAgeMs(3_000L, -600_000_000L))
    }

    @Test
    fun aPositionThePhoneHadKeptFromEarlierIsNotUsed() {
        // Both clocks say it is older than ten seconds: a left-over.
        assertNull(TrackingRules.fixAgeMs(10_001L, 10_001L))
        assertNull(TrackingRules.fixAgeMs(300_000L, 300_000L))
        // Only the uptime clock says so: the two disagree, and a fix is not
        // thrown away on the word of one. It is used, as old as a fix may be.
        assertEquals(10_000L, TrackingRules.fixAgeMs(300_000L, 0L))
        assertEquals(10_000L, TrackingRules.fixAgeMs(10_001L, 10_000L))
        // So a fix that is used can never be stale already when it arrives.
        assertFalse(TrackingRules.isStale(TrackingRules.MAX_FIX_AGE_MS, 30.0))
    }

    // ---- confirmed carriageway ----

    @Test
    fun aMatchByPositionIsNotConfirmedUntilTheHeadingHasChosen() {
        val memory = CarriagewayMemory()
        assertFalse(memory.confirm(post("M27", "A"), false, 51.0, -1.0))
        assertTrue(memory.confirm(post("M27", "A"), true, 51.0, -1.0))
    }

    @Test
    fun staysConfirmedOnTheSameCarriagewayWithin300Metres() {
        val memory = CarriagewayMemory()
        assertTrue(memory.confirm(post("M27", "A"), true, 51.0, -1.0))
        // About 111 m further on (0.001 degrees of latitude), with no usable heading.
        assertTrue(memory.confirm(post("M27", "A"), false, 51.001, -1.0))
        // About 445 m from where the heading last chose: no longer taken on trust.
        assertFalse(memory.confirm(post("M27", "A"), false, 51.004, -1.0))
        // The place the heading chose is remembered, not the last place asked about.
        assertTrue(memory.confirm(post("M27", "A"), false, 51.002, -1.0))
    }

    @Test
    fun anotherLetterOrRoadIsNotConfirmedFromMemory() {
        val memory = CarriagewayMemory()
        assertTrue(memory.confirm(post("M27", "A"), true, 51.0, -1.0))
        assertFalse(memory.confirm(post("M27", "B"), false, 51.0, -1.0))
        assertFalse(memory.confirm(post("M3", "A"), false, 51.0, -1.0))
    }

    @Test
    fun aNewHeadingMatchMovesTheRememberedPlace() {
        val memory = CarriagewayMemory()
        assertTrue(memory.confirm(post("M27", "A"), true, 51.0, -1.0))
        assertTrue(memory.confirm(post("M27", "B"), true, 51.01, -1.0))
        assertTrue(memory.confirm(post("M27", "B"), false, 51.011, -1.0))
        assertFalse(memory.confirm(post("M27", "A"), false, 51.0, -1.0))
    }

    @Test
    fun aResetForgetsTheLastConfirmation() {
        val memory = CarriagewayMemory()
        assertTrue(memory.confirm(post("M27", "A"), true, 51.0, -1.0))
        memory.reset()
        assertFalse(memory.confirm(post("M27", "A"), false, 51.0, -1.0))
    }

    // ---- stale ----

    /**
     * The web app's staleAfterMs: 15 s above 2.5 m/s, 120 s at or below it,
     * 30 s when the speed is unknown, and "not a number" is unknown.
     */
    @Test
    fun staleLimitsFollowTheSpeedOfTheLastFix() {
        assertEquals(15_000L, TrackingRules.staleAfterMs(30.0))
        assertEquals(15_000L, TrackingRules.staleAfterMs(2.6))
        assertEquals(120_000L, TrackingRules.staleAfterMs(2.5))
        assertEquals(120_000L, TrackingRules.staleAfterMs(0.0))
        assertEquals(30_000L, TrackingRules.staleAfterMs(null))
        assertEquals("not a number is an unknown speed, as in the web app", 30_000L, TrackingRules.staleAfterMs(Double.NaN))
    }

    @Test
    fun aFixIsStaleOnlyOnceItIsOlderThanTheLimit() {
        assertFalse(TrackingRules.isStale(15_000L, 30.0))
        assertTrue(TrackingRules.isStale(15_001L, 30.0))
        assertFalse(TrackingRules.isStale(30_000L, null))
        assertTrue(TrackingRules.isStale(30_001L, null))
        assertFalse(TrackingRules.isStale(30_000L, Double.NaN))
        assertTrue(TrackingRules.isStale(30_001L, Double.NaN))
        assertFalse(TrackingRules.isStale(120_000L, 0.0))
        assertTrue(TrackingRules.isStale(120_001L, 0.0))
    }

    // ---- distances ----

    @Test
    fun aDistanceIsWrittenAsTheWebAppWritesIt() {
        // Whole metres below 1000 m.
        assertEquals("0 m", DistanceText.fmtDist(0.0))
        assertEquals("38 m", DistanceText.fmtDist(38.0))
        assertEquals("38 m", DistanceText.fmtDist(38.4))
        assertEquals("half way goes up", "1 m", DistanceText.fmtDist(0.5))
        assertEquals("half way goes up", "251 m", DistanceText.fmtDist(250.5))
        assertEquals("999 m", DistanceText.fmtDist(999.4))
        assertEquals("still under 1000 m, so still in metres", "1000 m", DistanceText.fmtDist(999.5))

        // Two decimal places below 10 km.
        assertEquals("1.00 km", DistanceText.fmtDist(1000.0))
        assertEquals("1.24 km", DistanceText.fmtDist(1240.0))
        assertEquals("still under 10 km, so still two places", "10.00 km", DistanceText.fmtDist(9999.0))

        // One decimal place from 10 km.
        assertEquals("10.0 km", DistanceText.fmtDist(10000.0))
        assertEquals("12.4 km", DistanceText.fmtDist(12400.0))
        assertEquals("123.5 km", DistanceText.fmtDist(123456.789))
    }

    /**
     * JavaScript's toFixed rounds the exact value a number holds, and takes
     * the higher figure when that is exactly half way. These are the cases a
     * careless port gets wrong.
     */
    @Test
    fun aDistanceIsRoundedAsJavaScriptRoundsIt() {
        // Exactly half way in binary (1.125, 1.375, 12.25, 12.75): up.
        assertEquals("1.13 km", DistanceText.fmtDist(1125.0))
        assertEquals("1.38 km", DistanceText.fmtDist(1375.0))
        assertEquals("12.3 km", DistanceText.fmtDist(12250.0))
        assertEquals("12.8 km", DistanceText.fmtDist(12750.0))
        // Looks half way, but the number held is a hair below (1.00499999…, 9.99499999…): down.
        assertEquals("1.00 km", DistanceText.fmtDist(1005.0))
        assertEquals("9.99 km", DistanceText.fmtDist(9995.0))
        // Looks half way, but the number held is a hair above (10.0500000…1): up.
        assertEquals("10.1 km", DistanceText.fmtDist(10050.0))
        // The largest number below a half is not a half.
        assertEquals("0 m", DistanceText.fmtDist(0.49999999999999994))
    }

    @Test
    fun somethingThatIsNotADistanceIsNotWritten() {
        assertEquals("", DistanceText.fmtDist(Double.NaN))
        assertEquals("", DistanceText.fmtDist(Double.POSITIVE_INFINITY))
        assertEquals("", DistanceText.fmtDist(-5.0))
    }

    // ---- far from any recorded post ----

    @Test
    fun aPostMoreThan250MetresAwayIsFar() {
        assertEquals(250.0, TrackingRules.FAR_POST_M, 0.0)
        assertFalse(TrackingRules.isFar(0.0))
        assertFalse("exactly 250 m is not far", TrackingRules.isFar(250.0))
        assertTrue(TrackingRules.isFar(250.01))
        assertTrue(TrackingRules.isFar(12400.0))

        assertEquals("Nearest recorded post · 334 m away", TrackingRules.farContext(333.58))
        assertEquals("Nearest recorded post · 1.24 km away", TrackingRules.farContext(1240.0))
        assertEquals("Nearest recorded post · 12.4 km away", TrackingRules.farContext(12400.0))
    }

    @Test
    fun nearAPostTheSnapshotIsThePostsOwn() {
        val memory = CarriagewayMemory()

        // About 56 m from the post, travelling with its carriageway.
        val near = forFix(51.0005, 90.0, 30.0, memory)
        assertEquals("M27", near.road)
        assertEquals("P17/4A", near.ref)
        assertEquals("J4 – J5", near.context)
        assertTrue(near.confirmed)
        assertEquals(fixTime, near.fixTime)
        assertFalse(near.stale)
        assertTrue(near.tracking)

        // About 222 m: a long way for a motorway, but not far.
        val further = forFix(51.002, 90.0, 30.0, memory)
        assertEquals("J4 – J5", further.context)
        assertTrue(further.confirmed)
    }

    @Test
    fun farFromAnyPostTheLineSaysSoAndTheCarriagewayIsNotConfirmed() {
        val memory = CarriagewayMemory()

        // About 334 m from the post. The heading matches the post's
        // carriageway, and would confirm it if the post were near.
        val far = forFix(51.003, 90.0, 30.0, memory)
        assertEquals("Nearest recorded post · 334 m away", far.context)
        assertFalse("never confirmed when far, whatever the heading says", far.confirmed)
        // Everything else is still the post's own.
        assertEquals("M27", far.road)
        assertEquals("M", far.roadClass)
        assertEquals("17.4", far.km)
        assertEquals("A", far.letter)
        assertEquals("P17/4A", far.ref)
        assertEquals(fixTime, far.fixTime)
        assertFalse(far.stale)
        assertTrue(far.tracking)
        // So every surface marks the letter as one to check.
        assertTrue(far.letterUnconfirmed())

        // About 1.23 km and 11.1 km.
        val further = forFix(51.0111, null, null, memory)
        assertEquals("Nearest recorded post · 1.23 km away", further.context)
        assertFalse(further.confirmed)
        val furthest = forFix(51.1, 90.0, 30.0, memory)
        assertEquals("Nearest recorded post · 11.1 km away", furthest.context)
        assertFalse(furthest.confirmed)
    }

    @Test
    fun aFarFixNeitherMakesNorForgetsAConfirmation() {
        val memory = CarriagewayMemory()

        // Far, with a heading that matches. Then near and standing still: the
        // far fix must not have left a confirmation behind.
        forFix(51.003, 90.0, 30.0, memory)
        assertFalse(forFix(51.0005, null, 0.0, memory).confirmed)

        // Confirmed near the post, then far, then back where it was confirmed
        // and standing still: the far fix must not have wiped the confirmation either.
        assertTrue(forFix(51.0005, 90.0, 30.0, memory).confirmed)
        assertFalse(forFix(51.003, 90.0, 30.0, memory).confirmed)
        assertTrue(forFix(51.0005, null, 0.0, memory).confirmed)
    }

    @Test
    fun noPostsGivesNoSnapshot() {
        assertNull(Snapshot.forFix(emptyList(), 51.0, -1.0, null, null, true, fixTime, CarriagewayMemory()))
    }

    @Test
    fun theLineUnderAFarPostIsKnownByItsWords() {
        assertTrue(TrackingRules.isFarContext(TrackingRules.farContext(333.58)))
        assertTrue(TrackingRules.isFarContext(TrackingRules.farContext(12400.0)))
        assertFalse(TrackingRules.isFarContext("J4 – J5"))
        assertFalse(TrackingRules.isFarContext("A303 jct · 1.24 km from post"))
        assertFalse(TrackingRules.isFarContext("Link M27B/M3B · survey date unknown"))
        assertFalse(TrackingRules.isFarContext(""))
    }

    /** How far away a far post is changes with every fix, so that alone is redrawn at a slower pace. */
    @Test
    fun onlyTheDistanceToAFarPostChangingIsToldApartFromARealChange() {
        val memory = CarriagewayMemory()
        val far = forFix(51.003, 90.0, 30.0, memory)
        val aLittleFurther = forFix(51.00301, 90.0, 30.0, memory)
        assertFalse("the two lines give different distances", far.showsSameAs(aLittleFurther))
        assertTrue(aLittleFurther.differsOnlyInFarDistance(far))
        assertTrue(far.differsOnlyInFarDistance(aLittleFurther))

        // The same line is no difference at all.
        assertFalse(far.differsOnlyInFarDistance(far.copy(fixTime = fixTime + 1000L)))
        // Another post, or the same post gone stale, is a real change.
        assertFalse(aLittleFurther.differsOnlyInFarDistance(far.copy(ref = "P17/5A")))
        assertFalse(aLittleFurther.differsOnlyInFarDistance(far.copy(stale = true)))
        // Coming back within reach of the post is a real change, and so is leaving it.
        val near = forFix(51.002, 90.0, 30.0, memory)
        assertFalse(near.differsOnlyInFarDistance(far))
        assertFalse(far.differsOnlyInFarDistance(near))
        // Two different junction lines are not a far post at all.
        assertFalse(near.differsOnlyInFarDistance(near.copy(context = "Within J5")))
    }

    // ---- the time on every surface ----

    private val london: TimeZone = TimeZone.getTimeZone("Europe/London")

    // 14:32 on 22 November 2026 in London (winter time, the same as UTC).
    private val afternoon = 1_795_357_920_000L

    @Test
    fun aTimeFromTodayIsTheTwentyFourHourClock() {
        assertEquals("14:32", SurfaceClock.label(afternoon, afternoon, london))
        assertEquals("14:32", SurfaceClock.label(afternoon, 1_795_391_999_000L, london)) // 23:59:59 that night
        // 09:05 on 5 January 2026: both figures are written with two digits.
        assertEquals("09:05", SurfaceClock.label(1_767_603_900_000L, 1_767_603_900_000L, london))
        // In another time zone the same moment reads by that zone's clock.
        assertEquals("15:32", SurfaceClock.label(afternoon, afternoon, TimeZone.getTimeZone("Europe/Paris")))
    }

    @Test
    fun aTimeFromAnotherDayCarriesItsDate() {
        // One second later it is 23 November.
        assertEquals("22 Nov, 14:32", SurfaceClock.label(afternoon, 1_795_392_000_000L, london))
        // From 1 January 2027 it carries its year as well.
        assertEquals("22 Nov 2026, 14:32", SurfaceClock.label(afternoon, 1_798_761_600_000L, london))
        // The day is the phone's own day, not UTC's: 23:30 on 30 June 2026 in
        // London is 22:30 UTC, and midnight there is 23:00 UTC.
        val summerEvening = 1_782_858_600_000L
        assertEquals("23:30", SurfaceClock.label(summerEvening, 1_782_860_399_000L, london))
        assertEquals("30 Jun, 23:30", SurfaceClock.label(summerEvening, 1_782_860_400_000L, london))
    }

    @Test
    fun theTimeNextReadsDifferentlyAtMidnightThenAtTheNewYear() {
        // From today: at the coming midnight it gains its date.
        assertEquals(1_795_392_000_000L, SurfaceClock.nextChange(afternoon, afternoon, london))
        assertEquals(1_782_860_400_000L, SurfaceClock.nextChange(1_782_858_600_000L, 1_782_858_600_000L, london))
        // From an earlier day of this year: at the new year it gains its year.
        assertEquals(1_798_761_600_000L, SurfaceClock.nextChange(afternoon, 1_795_392_000_000L, london))
        // From an earlier year: it already says everything, and never changes.
        assertEquals(0L, SurfaceClock.nextChange(afternoon, 1_798_761_600_000L, london))
        // On the last night of the year both happen at once.
        val lastNight = 1_798_758_600_000L // 23:10 on 31 December 2026
        assertEquals(1_798_761_600_000L, SurfaceClock.nextChange(lastNight, lastNight, london))
        assertEquals("31 Dec 2026, 23:10", SurfaceClock.label(lastNight, 1_798_761_600_000L, london))
    }

    /** A redraw booked for the moment nextChange gives finds the old words just before it and new ones at it. */
    @Test
    fun aRedrawBookedForTheNextChangeFindsTheLabelChanged() {
        val summerEvening = 1_782_858_600_000L // 23:30 on 30 June 2026
        val lastNight = 1_798_758_600_000L // 23:10 on 31 December 2026
        val nextDay = 1_795_392_000_000L // midnight, 23 November 2026
        // Each pair is the time of a fix, then the time the surface is drawn.
        val cases = listOf(
            longArrayOf(afternoon, afternoon),
            longArrayOf(afternoon, nextDay),
            longArrayOf(afternoon, lastNight),
            longArrayOf(summerEvening, summerEvening),
            longArrayOf(lastNight, lastNight)
        )
        for (times in cases) {
            val fix = times[0]
            val now = times[1]
            val before = SurfaceClock.label(fix, now, london)
            val due = SurfaceClock.nextChange(fix, now, london)
            assertTrue("the change is still to come for " + before, due > now)
            assertEquals(before, SurfaceClock.label(fix, due - 1L, london))
            assertFalse(before + " did not change", before == SurfaceClock.label(fix, due, london))
        }
    }

    @Test
    fun aClockPutBackIsLookedAtAgainEveryMidnight() {
        // The fix is "tomorrow afternoon" by a clock that has been put back a day.
        val yesterday = afternoon - 86_400_000L
        assertEquals(1_795_305_600_000L, SurfaceClock.nextChange(afternoon, yesterday, london)) // midnight, 22 November
    }

    // ---- what counts as a visible change ----

    @Test
    fun aLaterFixTimeAloneIsNotAVisibleChange() {
        val first = snapshot()
        assertTrue(first.showsSameAs(first.copy(fixTime = first.fixTime + 1000L)))
    }

    @Test
    fun eachVisibleFieldIsAVisibleChange() {
        val first = snapshot()
        assertFalse(first.showsSameAs(first.copy(road = "M3")))
        assertFalse(first.showsSameAs(first.copy(ref = "P17/5A")))
        assertFalse(first.showsSameAs(first.copy(context = "At J5")))
        assertFalse(first.showsSameAs(first.copy(confirmed = false)))
        assertFalse(first.showsSameAs(first.copy(stale = true)))
    }

    /** No surface is worded by it: a widget says "Last updated" whether or not tracking is running. */
    @Test
    fun whetherTrackingIsRunningIsNotAVisibleChange() {
        val first = snapshot()
        assertTrue(first.showsSameAs(first.copy(tracking = false)))
    }

    // ---- a letter that is not confirmed ----

    @Test
    fun aLetterChosenByPositionOnlyIsMarkedAsOneToCheck() {
        assertFalse(snapshot().letterUnconfirmed())
        assertTrue(snapshot().copy(confirmed = false).letterUnconfirmed())
        assertTrue("stale or not", snapshot().copy(confirmed = false, stale = true).letterUnconfirmed())
        // No letter on show, so nothing to mark.
        assertFalse(snapshot().copy(confirmed = false, letter = "").letterUnconfirmed())
        // An unusual reference is shown whole: it has no separate letter.
        assertFalse(snapshot().copy(confirmed = false, km = "", letter = "", ref = "P17/4AB").letterUnconfirmed())
    }

    @Test
    fun theStatusBarChipLeavesOutALetterThatIsNotConfirmed() {
        assertEquals("17.4A", snapshot().chipText())
        assertEquals("17.4", snapshot().copy(confirmed = false).chipText())
        assertEquals("17.4", snapshot().copy(letter = "").chipText())
    }

    @Test
    fun theStatusBarChipShowsNothingRatherThanAnOldOrCutPost() {
        assertNull("a chip cannot say last known", snapshot().copy(stale = true).chipText())
        // Android shows a chip in full only when it is shorter than seven characters.
        assertEquals("117.4A", snapshot().copy(km = "117.4", ref = "P117/4A").chipText())
        assertNull(snapshot().copy(km = "1117.4", ref = "P1117/4A").chipText())
        val unusual = snapshot().copy(km = "", letter = "", ref = "P17/4AB")
        assertNull("seven characters would be cut", unusual.chipText())
        assertEquals("P17/4X", unusual.copy(ref = "P17/4X").chipText())
        assertEquals("the same whether or not it is confirmed", "P17/4X", unusual.copy(ref = "P17/4X", confirmed = false).chipText())
    }

    @Test
    fun theStatusBarChipShowsNothingForAPostThatIsFarAway() {
        // A chip cannot say "nearest recorded post, 334 m away" any more than "last known".
        assertNull(forFix(51.003, 90.0, 30.0, CarriagewayMemory()).chipText())
        assertNull(snapshot().copy(context = TrackingRules.farContext(48656.0)).chipText())
        // Near the same post it is shown as usual.
        assertEquals("17.4A", forFix(51.0005, 90.0, 30.0, CarriagewayMemory()).chipText())
    }

    // ---- what the notification says ----

    // The phone's own words (res/values/strings.xml), with 14:32 for the time.
    private val updatedWords = "Updated 14:32"
    private val noGpsWords = "No GPS since 14:32"
    private val checkWords = "Check carriageway"
    private val lastKnownWords = "last known post"

    /** The parts of the notification's text for a snapshot, in the order they are shown. */
    private fun parts(shown: Snapshot): List<String> =
        shown.notificationParts(updatedWords, noGpsWords, checkWords, lastKnownWords)

    /** The same, joined as the phone joins them. */
    private fun line(shown: Snapshot): String = parts(shown).joinToString(" · ")

    @Test
    fun theNotificationSaysTheTimeFirstAndTheLineUnderThePostLast() {
        assertEquals("Updated 14:32 · J4 – J5", line(snapshot()))
        assertEquals("Updated 14:32", line(snapshot().copy(context = "")))
        assertEquals(
            "Updated 14:32 · Link M27B/M3B · survey date unknown",
            line(snapshot().copy(context = "Link M27B/M3B · survey date unknown"))
        )
    }

    @Test
    fun aLetterByPositionOnlyIsSaidInWordsStraightAfterTheTime() {
        val byPosition = snapshot().copy(confirmed = false)
        assertEquals("Updated 14:32 · Check carriageway · J4 – J5", line(byPosition))
        assertEquals("Updated 14:32 · Check carriageway", line(byPosition.copy(context = "")))
        // Nothing to check where no separate letter is on show.
        assertEquals("Updated 14:32 · J4 – J5", line(byPosition.copy(letter = "")))
        assertEquals("Updated 14:32 · J4 – J5", line(byPosition.copy(km = "", letter = "", ref = "P17/4AB")))
    }

    @Test
    fun aStaleNotificationSaysNoGpsSinceAndNeverUpdated() {
        val lastKnownPost = snapshot().copy(stale = true)
        assertEquals("No GPS since 14:32 · last known post · J4 – J5", line(lastKnownPost))
        assertEquals("No GPS since 14:32 · last known post", line(lastKnownPost.copy(context = "")))
        assertEquals(
            "No GPS since 14:32 · Check carriageway · last known post · J4 – J5",
            line(lastKnownPost.copy(confirmed = false))
        )
        assertFalse(parts(lastKnownPost).contains(updatedWords))
        assertFalse(parts(snapshot()).contains(noGpsWords))
    }

    /**
     * The far line comes before everything but the time. Cut off, as the end
     * of a one-line notification is, it would leave the post in the title
     * looking like the vehicle's own.
     */
    @Test
    fun farFromAPostTheNotificationSaysSoStraightAfterTheTime() {
        val far = forFix(51.003, 90.0, 30.0, CarriagewayMemory())
        assertEquals("Updated 14:32 · Nearest recorded post · 334 m away · Check carriageway", line(far))
        assertEquals(
            "No GPS since 14:32 · Nearest recorded post · 334 m away · Check carriageway · last known post",
            line(far.copy(stale = true))
        )
        // An unusual reference has no separate letter to check. The far line still comes first.
        assertEquals(
            "Updated 14:32 · Nearest recorded post · 334 m away",
            line(far.copy(km = "", letter = "", ref = "P17/4AB"))
        )
    }

    /**
     * Whatever the state: the time is the first part, so it is never the part
     * a one-line notification cuts off; near a post the line under it is the
     * last part, so it is the first to go; and nothing is said twice.
     */
    @Test
    fun inEveryStateTheTimeComesFirstAndNothingIsSaidTwice() {
        val farLine = TrackingRules.farContext(1240.0)
        for (context in listOf("", "J4 – J5", "Link M27B/M3B · survey date unknown", farLine)) {
            for (stale in listOf(false, true)) {
                for (confirmed in listOf(false, true)) {
                    for (letter in listOf("A", "")) {
                        val shown = snapshot().copy(context = context, stale = stale, confirmed = confirmed, letter = letter)
                        val said = parts(shown)
                        val what = said.toString()
                        assertEquals(what, if (stale) noGpsWords else updatedWords, said[0])
                        assertEquals(what, said.size.toLong(), said.distinct().size.toLong())
                        assertEquals(what, stale, said.contains(lastKnownWords))
                        assertEquals(what, !confirmed && letter == "A", said.contains(checkWords))
                        assertFalse(what, said.contains(""))
                        if (context == farLine) {
                            assertEquals(what, farLine, said[1])
                        } else if (context.isNotEmpty()) {
                            assertEquals(what, context, said[said.size - 1])
                        }
                    }
                }
            }
        }
    }

    @Test
    fun theNotificationTitleIsThePostOnOneLine() {
        assertEquals("M27 17.4 A", snapshot().notificationTitle())
        // Near the post a letter by position only stays: "Check carriageway" is beside the time.
        assertEquals("M27 17.4 A", snapshot().copy(confirmed = false).notificationTitle())
        assertEquals("M27 17.4 A", snapshot().copy(stale = true).notificationTitle())
        assertEquals("M27 17.4", snapshot().copy(letter = "").notificationTitle())
        assertEquals("M27 P17/4AB", snapshot().copy(km = "", letter = "", ref = "P17/4AB").notificationTitle())
        // The form the emulator check looks for (scripts/smoke-android.mjs).
        assertTrue(Regex("^M27 \\d+\\.\\d [AB]$").matches(snapshot().notificationTitle()))
    }

    @Test
    fun farFromAPostTheNotificationTitleLeavesTheLetterOut() {
        val far = forFix(51.003, 90.0, 30.0, CarriagewayMemory())
        assertEquals("M27 17.4", far.notificationTitle())
        assertEquals("M27 17.4", far.copy(stale = true).notificationTitle())
        assertEquals("17.4", far.copy(road = "").notificationTitle())
        // An unusual reference is shown whole, as it is recorded.
        assertEquals("M27 P17/4AB", far.copy(km = "", letter = "", ref = "P17/4AB").notificationTitle())
        // Within reach of the post the letter is there, confirmed or not.
        assertEquals("M27 17.4 A", forFix(51.002, null, null, CarriagewayMemory()).notificationTitle())
    }

    /**
     * A letter that is not confirmed is never left looking confirmed: either
     * the title leaves it out, or "Check carriageway" is the very next thing
     * after the time, where a notification that shows one line still shows it.
     */
    @Test
    fun aLetterThatIsNotConfirmedIsLeftOutOrHasItsWarningBesideTheTime() {
        val farLine = TrackingRules.farContext(1240.0)
        for (context in listOf("", "J4 – J5", "Link M27B/M3B · survey date unknown", farLine)) {
            for (stale in listOf(false, true)) {
                val shown = snapshot().copy(context = context, stale = stale, confirmed = false)
                val title = shown.notificationTitle()
                val what = title + " / " + parts(shown)
                if (title.endsWith(" A")) {
                    assertEquals(what, checkWords, parts(shown)[1])
                } else {
                    assertEquals(what, "M27 17.4", title)
                    assertEquals(what, farLine, context)
                }
            }
        }
    }

    // ---- room on the widget ----

    @Test
    fun theLineUnderThePostHasTwoLinesOnlyWhereThePostNumberKeepsItsRoom() {
        // At the ordinary text size: a widget of two cells by two, down to about the least it can be.
        assertEquals(2L, WidgetRules.contextLines(184, 1.0f).toLong())
        assertEquals(2L, WidgetRules.contextLines(146, 1.0f).toLong())
        assertEquals(2L, WidgetRules.contextLines(145, 1.0f).toLong())
        // Shorter than that (one row of cells, or a phone on its side) the number comes first.
        assertEquals(1L, WidgetRules.contextLines(144, 1.0f).toLong())
        assertEquals(1L, WidgetRules.contextLines(110, 1.0f).toLong())
    }

    @Test
    fun largerTextNeedsAHigherWidgetForTwoLines() {
        // Text 30% larger.
        assertEquals(1L, WidgetRules.contextLines(146, 1.3f).toLong())
        assertEquals(1L, WidgetRules.contextLines(179, 1.3f).toLong())
        assertEquals(2L, WidgetRules.contextLines(180, 1.3f).toLong())
        assertEquals(2L, WidgetRules.contextLines(184, 1.3f).toLong())
        // Text twice the size.
        assertEquals(1L, WidgetRules.contextLines(184, 2.0f).toLong())
        assertEquals(1L, WidgetRules.contextLines(259, 2.0f).toLong())
        assertEquals(2L, WidgetRules.contextLines(260, 2.0f).toLong())
        // Smaller text needs less.
        assertEquals(1L, WidgetRules.contextLines(127, 0.85f).toLong())
        assertEquals(2L, WidgetRules.contextLines(128, 0.85f).toLong())
    }

    @Test
    fun aWidgetOfUnknownHeightIsTakenForASmallOne() {
        // 0: the launcher has not said. As for 146 dp, about the least two cells by two can be.
        assertEquals(2L, WidgetRules.contextLines(0, 1.0f).toLong())
        assertEquals(1L, WidgetRules.contextLines(0, 1.3f).toLong())
        assertEquals(1L, WidgetRules.contextLines(-1, 1.3f).toLong())
        // A text size that is not a number above nought is taken as the ordinary one.
        assertEquals(2L, WidgetRules.contextLines(145, 0.0f).toLong())
        assertEquals(2L, WidgetRules.contextLines(145, Float.NaN).toLong())
        assertEquals(1L, WidgetRules.contextLines(144, Float.NaN).toLong())
    }

    // ---- one-line forms ----

    @Test
    fun oneLineIsRoadChainageLetter() {
        assertEquals("M27 17.4 A", snapshot().oneLine())
        assertEquals("M27 17.4", snapshot().copy(letter = "").oneLine())
        assertEquals("17.4 A", snapshot().copy(road = "").oneLine())
    }

    @Test
    fun anUnusualReferenceIsShownVerbatim() {
        val unusual = snapshot().copy(km = "", letter = "", ref = "P17/4AB")
        assertEquals("M27 P17/4AB", unusual.oneLine())
        assertEquals("P17/4AB", unusual.shortText())
    }

    @Test
    fun shortTextIsChainageAndLetterTogether() {
        assertEquals("17.4A", snapshot().shortText())
        assertEquals("17.4", snapshot().copy(letter = "").shortText())
    }

    @Test
    fun aLiveSnapshotCopiesThePostAndIsNeitherStaleNorStopped() {
        val live = Snapshot.live(post("M27", "A"), true, fixTime)
        assertEquals("M27", live.road)
        assertEquals("M", live.roadClass)
        assertEquals("17.4", live.km)
        assertEquals("A", live.letter)
        assertEquals("P17/4A", live.ref)
        assertEquals("J4 – J5", live.context)
        assertTrue(live.confirmed)
        assertEquals(fixTime, live.fixTime)
        assertFalse(live.stale)
        assertTrue(live.tracking)
    }
}
