package io.github.jet11111.markerpost.nativecore

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The tracking rules that need no phone to check: when the carriageway
 * counts as confirmed, when a post counts as stale, what counts as a visible
 * change, and the one-line forms of a post.
 */
class TrackingRulesTest {

    private fun post(road: String, letter: String): Post =
        Post(51.0, -1.0, 90.0, "M", road, "17.4", letter, "P17/4" + letter, "J4 – J5")

    private fun snapshot(): Snapshot =
        Snapshot("M27", "M", "17.4", "A", "P17/4A", "J4 – J5", true, 1_795_000_000_000L, false, true)

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

    @Test
    fun staleLimitsFollowTheSpeedOfTheLastFix() {
        assertEquals(15_000L, TrackingRules.staleAfterMs(30.0))
        assertEquals(15_000L, TrackingRules.staleAfterMs(2.6))
        assertEquals(120_000L, TrackingRules.staleAfterMs(2.5))
        assertEquals(120_000L, TrackingRules.staleAfterMs(0.0))
        assertEquals(30_000L, TrackingRules.staleAfterMs(null))
    }

    @Test
    fun aFixIsStaleOnlyOnceItIsOlderThanTheLimit() {
        assertFalse(TrackingRules.isStale(15_000L, 30.0))
        assertTrue(TrackingRules.isStale(15_001L, 30.0))
        assertFalse(TrackingRules.isStale(30_000L, null))
        assertTrue(TrackingRules.isStale(30_001L, null))
        assertFalse(TrackingRules.isStale(120_000L, 0.0))
        assertTrue(TrackingRules.isStale(120_001L, 0.0))
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
        assertFalse(first.showsSameAs(first.copy(tracking = false)))
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
        val live = Snapshot.live(post("M27", "A"), true, 1_795_000_000_000L)
        assertEquals("M27", live.road)
        assertEquals("M", live.roadClass)
        assertEquals("17.4", live.km)
        assertEquals("A", live.letter)
        assertEquals("P17/4A", live.ref)
        assertEquals("J4 – J5", live.context)
        assertTrue(live.confirmed)
        assertEquals(1_795_000_000_000L, live.fixTime)
        assertFalse(live.stale)
        assertTrue(live.tracking)
    }
}
