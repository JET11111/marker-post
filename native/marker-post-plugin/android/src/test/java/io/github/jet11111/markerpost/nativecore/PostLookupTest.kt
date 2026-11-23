package io.github.jet11111.markerpost.nativecore

import java.io.InputStreamReader
import java.io.Reader
import java.io.StringReader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Proves the Kotlin lookup gives the same answers as the JavaScript the app
 * uses. scripts/build-native-data.mjs writes both files into
 * src/test/resources ("npm run build:native"): the posts, and about 2,000
 * sampled positions with the JavaScript answer for each.
 */
class PostLookupTest {

    private fun resource(name: String): Reader {
        val stream = javaClass.classLoader?.getResourceAsStream(name)
            ?: throw AssertionError(
                name + " is not in the test resources. Run \"npm run build:native\" first: it writes the file."
            )
        return InputStreamReader(stream, Charsets.UTF_8)
    }

    private fun lines(name: String): List<String> = resource(name).use { it.readLines() }

    /** A fixture number: a number, the word null, or NaN (a receiver that reports no heading). */
    private fun number(word: String): Double? = when (word) {
        "null" -> null
        "NaN" -> Double.NaN
        else -> word.toDouble()
    }

    /**
     * The contract, for every fixture:
     *  1. the distance matches within one millionth of a metre;
     *  2. "heading used" matches;
     *  3. the post matches, unless the runner-up was within a millionth of a
     *     metre (an exact tie, which two maths libraries may break differently).
     *
     * Every difference is collected before failing, so one run of the tests
     * shows whether one fixture is wrong or all of them.
     */
    @Test
    fun givesTheSameAnswersAsTheWebApp() {
        val posts = resource("posts.tsv").use { PostLookup.parse(it) }
        assertTrue("posts.tsv looks cut short: " + posts.size + " posts", posts.size > 1000)

        val tolerance = 1e-6
        val problems = ArrayList<String>()
        var checked = 0
        var ties = 0
        val fixtureLines = lines("nearest-fixtures.tsv")
        for (n in fixtureLines.indices) {
            val line = fixtureLines[n]
            if (line.isEmpty() || line.startsWith("#")) continue
            val where = "line " + (n + 1)

            // lat  lng  heading  speed  useHeading  index  distM  headingUsed  marginM
            val f = line.split('\t')
            assertEquals("nearest-fixtures.tsv " + where + ": number of fields", 9L, f.size.toLong())
            val lat = f[0].toDouble()
            val lng = f[1].toDouble()
            val heading = number(f[2])
            val speed = number(f[3])
            val useHeading = f[4] == "1"
            val expectedIndex = f[5].toInt()
            val expectedDistance = f[6].toDouble()
            val expectedHeadingUsed = f[7] == "1"
            val margin = f[8].toDouble()

            val nearest = PostLookup.findNearest(posts, lat, lng, heading, speed, useHeading)
            checked++

            // Written so that a distance that is not a number fails too.
            if (!(Math.abs(nearest.distance - expectedDistance) <= tolerance)) {
                problems.add(where + ": distance " + nearest.distance + " m, expected " + expectedDistance + " m")
            }
            if (nearest.headingUsed != expectedHeadingUsed) {
                problems.add(where + ": headingUsed " + nearest.headingUsed + ", expected " + expectedHeadingUsed)
            }
            if (margin > tolerance) {
                if (nearest.index != expectedIndex) {
                    problems.add(where + ": post " + nearest.index + ", expected " + expectedIndex)
                }
            } else {
                ties++
            }
        }

        assertTrue("nearest-fixtures.tsv looks cut short: " + checked + " fixtures", checked > 1000)
        assertTrue("too many fixtures are ties to prove anything: " + ties + " of " + checked, ties < checked / 2)
        assertTrue(
            problems.size.toString() + " difference(s) from the web app in " + checked +
                " fixtures of nearest-fixtures.tsv:\n" + problems.take(25).joinToString("\n"),
            problems.isEmpty()
        )
    }

    /**
     * The sum inside the distance must be built in the web app's order
     * (docs/native-apps.md, section 3): each square first, then the two
     * cosines multiplied together, then that product times the second square.
     *
     * Built in any other order the distance comes out a hair different. That
     * is far inside the tolerance of the test above, so that test cannot see
     * it; but it is no longer the web app's own sum, and it is enough to
     * break a tie between two posts the other way. So this test compares
     * exact values, against the same sum written out here in the right order.
     */
    @Test
    fun theDistanceIsBuiltInTheWebAppsOrder() {
        val posts = resource("posts.tsv").use { PostLookup.parse(it) }
        val problems = ArrayList<String>()
        var checked = 0
        // How many of these distances another order would change. If it were
        // none, this test could not tell the orders apart and would prove nothing.
        var orderMatters = 0
        val fixtureLines = lines("nearest-fixtures.tsv")
        for (n in fixtureLines.indices) {
            val line = fixtureLines[n]
            if (line.isEmpty() || line.startsWith("#")) continue
            val f = line.split('\t')
            val lat = f[0].toDouble()
            val lng = f[1].toDouble()
            val index = f[5].toInt()
            if (index < 0 || index >= posts.size) continue
            val post = posts[index]

            val s1 = StrictMath.sin(PostLookup.toRad(post.lat - lat) / 2.0)
            val s2 = StrictMath.sin(PostLookup.toRad(post.lng - lng) / 2.0)
            val cosines = StrictMath.cos(PostLookup.toRad(lat)) * StrictMath.cos(PostLookup.toRad(post.lat))
            val inOrder = (s1 * s1) + cosines * (s2 * s2)
            val leftToRight = s1 * s1 + cosines * s2 * s2
            val expected = 2.0 * PostLookup.EARTH_RADIUS_M * StrictMath.asin(StrictMath.sqrt(inOrder))
            val otherwise = 2.0 * PostLookup.EARTH_RADIUS_M * StrictMath.asin(StrictMath.sqrt(leftToRight))

            val got = PostLookup.haversine(lat, lng, post.lat, post.lng)
            checked++
            if (got != expected) {
                problems.add("line " + (n + 1) + ": " + got + " m, expected exactly " + expected + " m")
            }
            if (otherwise != expected) orderMatters++
        }

        assertTrue("nearest-fixtures.tsv looks cut short: " + checked + " fixtures", checked > 1000)
        assertTrue("no fixture tells one order from another, so this test proves nothing", orderMatters > 0)
        assertTrue(
            problems.size.toString() + " distance(s) not built in the web app's order:\n" +
                problems.take(25).joinToString("\n"),
            problems.isEmpty()
        )
    }

    /**
     * A long way from every recorded post, the tracker puts its own line under
     * the post, and tells it from a post's own line by its words alone
     * (TrackingRules.isFarContext). So no recorded post may carry such a line.
     */
    @Test
    fun noRecordedPostHasALineThatSaysItIsFarAway() {
        val posts = resource("posts.tsv").use { PostLookup.parse(it) }
        val taken = posts.filter { TrackingRules.isFarContext(it.context) }
        assertTrue(
            taken.size.toString() + " recorded post(s) have a line the tracker would take for its own, the first: " +
                taken.take(1).joinToString { it.road + " " + it.ref + " \"" + it.context + "\"" },
            taken.isEmpty()
        )
    }

    @Test
    fun theTwoFilesComeFromTheSameBuild() {
        // "# markerpost-posts <tab> v1 <tab> count <tab> digest" and the same shape for the fixtures.
        val postsHeader = lines("posts.tsv").first().split('\t')
        val fixtureLines = lines("nearest-fixtures.tsv")
        val fixturesHeader = fixtureLines.first().split('\t')
        assertEquals("# markerpost-posts", postsHeader[0])
        assertEquals("# markerpost-nearest-fixtures", fixturesHeader[0])
        assertEquals(
            "the posts and the fixtures were written by different runs of build-native-data.mjs",
            postsHeader[3],
            fixturesHeader[3]
        )
        val fixtures = fixtureLines.count { it.isNotEmpty() && !it.startsWith("#") }
        assertEquals("nearest-fixtures.tsv is incomplete", fixturesHeader[2].toLong(), fixtures.toLong())
    }

    @Test
    fun readsEmptyFieldsAndSkipsComments() {
        val text = "# markerpost-posts\tv1\t2\tabc\n" +
            "# lat\tlng\tbearing\troadClass\troad\tkm\tletter\tref\tcontext\n" +
            "50.960127\t-1.4267591\t\tO\tChilworth · M3 / M27\t14.7\tJ\tP14/7J\t\n" +
            "50.93795\t-1.352527\t119.5\tM\tM27\t17.4\tA\tP17/4A\tJ4 – J5\n"
        val posts = PostLookup.parse(StringReader(text))
        assertEquals(2L, posts.size.toLong())

        val link = posts[0]
        assertEquals(50.960127, link.lat, 0.0)
        assertEquals(-1.4267591, link.lng, 0.0)
        assertNull("an empty bearing means the direction is not known", link.bearing)
        assertEquals("O", link.roadClass)
        assertEquals("Chilworth · M3 / M27", link.road)
        assertEquals("P14/7J", link.ref)
        assertEquals("an empty last field is kept, not dropped", "", link.context)

        val mainline = posts[1]
        assertEquals(119.5, mainline.bearing ?: Double.NaN, 0.0)
        assertEquals("M", mainline.roadClass)
        assertEquals("M27", mainline.road)
        assertEquals("17.4", mainline.km)
        assertEquals("A", mainline.letter)
        assertEquals("J4 – J5", mainline.context)
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesAFileShorterThanItsHeaderSays() {
        PostLookup.parse(StringReader("# markerpost-posts\tv1\t2\tabc\n50.9\t-1.4\t\tM\tM27\t17.4\tA\tP17/4A\t\n"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesADamagedLine() {
        PostLookup.parse(StringReader("50.9\t-1.4\t\tM\tM27\n"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesALineWithTooManyFields() {
        PostLookup.parse(StringReader("50.9\t-1.4\t\tM\tM27\t17.4\tA\tP17/4A\t\textra\n"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesAPositionThatIsNotANumber() {
        PostLookup.parse(StringReader("fifty\t-1.4\t\tM\tM27\t17.4\tA\tP17/4A\t\n"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesAPositionThatIsNotFinite() {
        PostLookup.parse(StringReader("NaN\t-1.4\t\tM\tM27\t17.4\tA\tP17/4A\t\n"))
    }

    @Test(expected = IllegalArgumentException::class)
    fun refusesAFormatItDoesNotKnow() {
        PostLookup.parse(StringReader("# markerpost-posts\tv2\t1\tabc\n50.9\t-1.4\t\tM\tM27\t17.4\tA\tP17/4A\t\n"))
    }

    @Test
    fun angleDiffIsTheSmallestAngleBetweenTwoBearings() {
        assertEquals(0.0, PostLookup.angleDiff(10.0, 10.0), 1e-9)
        assertEquals(20.0, PostLookup.angleDiff(350.0, 10.0), 1e-9)
        assertEquals(20.0, PostLookup.angleDiff(10.0, 350.0), 1e-9)
        assertEquals(90.0, PostLookup.angleDiff(270.0, 0.0), 1e-9)
        assertEquals(90.0, PostLookup.angleDiff(0.0, 270.0), 1e-9)
        assertEquals(180.0, PostLookup.angleDiff(0.0, 180.0), 1e-9)
        assertEquals(180.0, PostLookup.angleDiff(180.0, 0.0), 1e-9)
        assertEquals(170.0, PostLookup.angleDiff(-175.0, 15.0), 1e-9)
        assertEquals(0.0, PostLookup.angleDiff(0.0, 360.0), 1e-9)
    }

    @Test
    fun headingIsOnlyUsedAboveWalkingPace() {
        assertTrue(PostLookup.headingUsable(90.0, 2.6, true))
        assertTrue(PostLookup.headingUsable(90.0, 30.0, true))
        assertFalse("exactly 2.5 m/s is not fast enough", PostLookup.headingUsable(90.0, 2.5, true))
        assertFalse(PostLookup.headingUsable(90.0, 0.0, true))
    }

    @Test
    fun aHeadingOfZeroIsStillAHeading() {
        assertTrue(PostLookup.headingUsable(0.0, 30.0, true))
    }

    @Test
    fun aMissingHeadingOrSpeedIsNeverUsed() {
        assertFalse("NaN is not a heading", PostLookup.headingUsable(Double.NaN, 30.0, true))
        assertFalse(PostLookup.headingUsable(null, 30.0, true))
        assertFalse(PostLookup.headingUsable(90.0, null, true))
        assertFalse(PostLookup.headingUsable(90.0, Double.NaN, true))
        assertFalse("the preference is off", PostLookup.headingUsable(90.0, 30.0, false))
    }

    private fun post(lat: Double, lng: Double, bearing: Double?, letter: String): Post =
        Post(lat, lng, bearing, "M", "M27", "17.4", letter, "P17/4" + letter, "")

    @Test
    fun theDirectionOfTravelChoosesTheCarriageway() {
        // Two carriageways about eleven metres apart, flowing in opposite directions.
        val posts = listOf(post(51.0, -1.0, 90.0, "A"), post(51.0001, -1.0, 270.0, "B"))
        val lat = 51.00008 // nearer the B post
        val lng = -1.0

        val byPosition = PostLookup.findNearest(posts, lat, lng, null, null, true)
        assertEquals(1L, byPosition.index.toLong())
        assertFalse(byPosition.headingUsed)

        val withTheACarriageway = PostLookup.findNearest(posts, lat, lng, 80.0, 30.0, true)
        assertEquals(0L, withTheACarriageway.index.toLong())
        assertTrue(withTheACarriageway.headingUsed)

        val withTheBCarriageway = PostLookup.findNearest(posts, lat, lng, 260.0, 30.0, true)
        assertEquals(1L, withTheBCarriageway.index.toLong())
        assertTrue(withTheBCarriageway.headingUsed)

        val tooSlow = PostLookup.findNearest(posts, lat, lng, 80.0, 2.5, true)
        assertEquals(1L, tooSlow.index.toLong())
        assertFalse(tooSlow.headingUsed)

        val preferenceOff = PostLookup.findNearest(posts, lat, lng, 80.0, 30.0, false)
        assertEquals(1L, preferenceOff.index.toLong())
        assertFalse(preferenceOff.headingUsed)
    }

    @Test
    fun aPostWithNoBearingStaysInButDoesNotCountAsChosenByHeading() {
        // The nearest post has no travel bearing (an interchange link, for example).
        val posts = listOf(post(51.0, -1.0, 90.0, "A"), post(51.00008, -1.0, null, "J"))
        val nearest = PostLookup.findNearest(posts, 51.00008, -1.0, 80.0, 30.0, true)
        assertEquals(1L, nearest.index.toLong())
        assertEquals(0.0, nearest.distance, 1e-9)
        assertFalse(nearest.headingUsed)
    }

    @Test
    fun whenEveryPostFlowsTheOtherWayTheNearestIsStillReported() {
        val posts = listOf(post(51.0, -1.0, 90.0, "A"), post(51.0001, -1.0, 90.0, "A"))
        val nearest = PostLookup.findNearest(posts, 51.00008, -1.0, 270.0, 30.0, true)
        assertEquals(1L, nearest.index.toLong())
        assertFalse("nothing matched the heading, so it did not choose", nearest.headingUsed)
    }

    @Test
    fun theFirstOfTwoEquallyNearPostsWins() {
        val posts = listOf(post(51.0, -1.0, null, "A"), post(51.0, -1.0, null, "B"))
        assertEquals(0L, PostLookup.findNearest(posts, 51.0, -1.0, null, null, true).index.toLong())
    }

    @Test
    fun noPostsMeansNoAnswer() {
        val nearest = PostLookup.findNearest(emptyList(), 51.0, -1.0, 90.0, 30.0, true)
        assertEquals(-1L, nearest.index.toLong())
        assertFalse(nearest.headingUsed)
    }
}
