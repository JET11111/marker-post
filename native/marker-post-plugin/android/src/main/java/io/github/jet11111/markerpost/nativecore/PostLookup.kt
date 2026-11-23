package io.github.jet11111.markerpost.nativecore

import java.io.BufferedReader
import java.io.Reader

// The nearest-post lookup: a direct port of findNearest in core/posts.js.
//
// This file is plain Kotlin with no Android classes in it, so the unit tests
// can run it on the build machine and compare every answer with the
// JavaScript one (src/test/.../PostLookupTest.kt).

/**
 * One recorded marker post, as prepared by scripts/build-native-data.mjs.
 * Every string was written by the same JavaScript the app uses. Nothing is
 * re-worded here, so a surface can never describe a post differently.
 */
data class Post(
    val lat: Double,
    val lng: Double,
    /** The direction traffic flows past the post, in degrees. Null when the records do not give one. */
    val bearing: Double?,
    /** "M" motorway, "A" A-road, "O" other. Chooses the badge colour only. */
    val roadClass: String,
    /** Display road name: "M27", "A3(M)". */
    val road: String,
    /** Chainage for display, "17.4". Empty when the recorded reference is unusual: show [ref] instead. */
    val km: String,
    /** Carriageway letter, "A". May be empty. */
    val letter: String,
    /** The recorded reference, verbatim: "P17/4A". */
    val ref: String,
    /** The line under the post: "J4 – J5", "Within J5", "A303 jct · 349 m from post", "Link M27B/M3B · survey date unknown", or empty. */
    val context: String
)

/**
 * The answer to "which post is nearest".
 * [index] is the post's position in posts.tsv (0-based), or -1 when there are no posts at all.
 * [distance] is the straight-line distance in metres.
 * [headingUsed] is true when the direction of travel chose the carriageway.
 */
data class Nearest(val index: Int, val distance: Double, val headingUsed: Boolean)

object PostLookup {

    const val EARTH_RADIUS_M = 6371000.0

    /** Speed (m/s) above which a GPS heading is trusted for choosing the carriageway. */
    const val HEADING_MIN_SPEED = 2.5

    private const val HEADER_PREFIX = "# markerpost-posts\t"
    private const val FORMAT = "v1"
    private const val FIELDS = 9

    /**
     * Reads posts.tsv: one post per line, tab separated, in the app's own order.
     * Lines starting with '#' are comments. Empty fields are kept (an empty
     * bearing means "unknown", an empty context means "the records do not say").
     *
     * Throws IllegalArgumentException if the file is in a format this code
     * does not know, if a line is damaged, or if the file is shorter than its
     * header says. A lookup over half a file would report the wrong post with
     * no sign that anything was missing, so a damaged file counts as no file.
     */
    fun parse(reader: Reader): List<Post> {
        val posts = ArrayList<Post>()
        var expected = -1
        val lines = BufferedReader(reader)
        while (true) {
            val line = lines.readLine() ?: break
            if (line.isEmpty()) continue
            if (line.startsWith("#")) {
                if (line.startsWith(HEADER_PREFIX)) {
                    // "# markerpost-posts <tab> v1 <tab> number of posts <tab> digest"
                    val header = line.split('\t')
                    if (header.size >= 2 && header[1] != FORMAT) {
                        throw IllegalArgumentException("posts.tsv is in format " + header[1] + ", this code reads " + FORMAT)
                    }
                    if (header.size >= 3) expected = header[2].toIntOrNull() ?: -1
                }
                continue
            }
            // Kotlin's split keeps empty fields, including one at the end of the line.
            val f = line.split('\t')
            if (f.size != FIELDS) {
                throw IllegalArgumentException("posts.tsv: a line has " + f.size + " fields, expected " + FIELDS)
            }
            // toDouble throws NumberFormatException (an IllegalArgumentException) for anything that is not a number.
            val lat = f[0].toDouble()
            val lng = f[1].toDouble()
            val bearing: Double? = if (f[2].isEmpty()) null else f[2].toDouble()
            if (!isFinite(lat) || !isFinite(lng) || (bearing != null && !isFinite(bearing))) {
                throw IllegalArgumentException("posts.tsv: a line has a position or bearing that is not a number")
            }
            posts.add(Post(lat, lng, bearing, f[3], f[4], f[5], f[6], f[7], f[8]))
        }
        if (expected >= 0 && expected != posts.size) {
            throw IllegalArgumentException(
                "posts.tsv is incomplete: its header says " + expected + " posts, it holds " + posts.size
            )
        }
        return posts
    }

    private fun isFinite(value: Double): Boolean = !value.isNaN() && !value.isInfinite()

    /** Degrees to radians. Multiply first, then divide: the same order as the JavaScript. */
    fun toRad(d: Double): Double = (d * Math.PI) / 180.0

    /**
     * Great-circle distance in metres.
     *
     * StrictMath, not Math: StrictMath is the same library (fdlibm) on every
     * machine and is the closest match to what the JavaScript engine computes.
     * Squares are written s * s, never pow(). The line for "a" is written
     * exactly as in the contract (docs/native-apps.md, section 3) and in the
     * Swift port. Do not tidy it: a rearranged product can round differently
     * and break a tie between two posts the other way.
     */
    fun haversine(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val dLat = toRad(lat2 - lat1)
        val dLng = toRad(lng2 - lng1)
        val s1 = StrictMath.sin(dLat / 2.0)
        val s2 = StrictMath.sin(dLng / 2.0)
        // Built in the web app's order: the two squares first, then the product.
        // (Left to right, cos * cos * s2 * s2 differs from it in the last bit.)
        val a = (s1 * s1) + (StrictMath.cos(toRad(lat1)) * StrictMath.cos(toRad(lat2))) * (s2 * s2)
        return 2.0 * EARTH_RADIUS_M * StrictMath.asin(StrictMath.sqrt(a))
    }

    /**
     * Smallest difference between two bearings, 0..180.
     * Kotlin's % keeps the sign of the dividend, exactly as JavaScript's does.
     */
    fun angleDiff(a: Double, b: Double): Double = Math.abs(((a - b + 540.0) % 360.0) - 180.0)

    /**
     * True when a GPS heading is reliable enough to choose a carriageway with:
     * the preference is on, there is a heading (0.0 is a heading, NaN is not)
     * and the speed is above walking pace. Exactly 2.5 m/s is not enough.
     */
    fun headingUsable(heading: Double?, speed: Double?, useHeading: Boolean): Boolean {
        if (!useHeading || heading == null || speed == null) return false
        // Plain doubles from here on, so the comparison follows the usual
        // floating-point rule that NaN is never greater than anything.
        val h: Double = heading
        val s: Double = speed
        return !h.isNaN() && s > HEADING_MIN_SPEED
    }

    /**
     * Nearest recorded post to a position. A straight scan in file order: a
     * few thousand points is fast enough once a second.
     *
     * With a usable heading, posts whose carriageway flows the other way (more
     * than 90 degrees off) are skipped, which drops the opposite carriageway
     * sitting a few metres to the side. Posts with no travel bearing stay in.
     * "Strictly less" means the first of two equally near posts wins.
     */
    fun findNearest(
        posts: List<Post>,
        lat: Double,
        lng: Double,
        heading: Double?,
        speed: Double?,
        useHeading: Boolean
    ): Nearest {
        var best = -1
        var bestD = Double.POSITIVE_INFINITY
        var headingUsed = false

        if (heading != null && headingUsable(heading, speed, useHeading)) {
            val h: Double = heading
            for (i in posts.indices) {
                val p = posts[i]
                val bearing = p.bearing
                if (bearing != null && angleDiff(bearing, h) > 90.0) continue
                val d = haversine(lat, lng, p.lat, p.lng)
                if (d < bestD) {
                    bestD = d
                    best = i
                }
            }
            headingUsed = best >= 0 && posts[best].bearing != null
        }

        if (best < 0) {
            for (i in posts.indices) {
                val p = posts[i]
                val d = haversine(lat, lng, p.lat, p.lng)
                if (d < bestD) {
                    bestD = d
                    best = i
                }
            }
        }
        return Nearest(best, bestD, headingUsed)
    }
}
