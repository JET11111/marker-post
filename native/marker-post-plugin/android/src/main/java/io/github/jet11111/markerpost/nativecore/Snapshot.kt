package io.github.jet11111.markerpost.nativecore

import android.content.Context
import android.content.SharedPreferences
import java.math.BigDecimal
import java.math.RoundingMode
import org.json.JSONException
import org.json.JSONObject

/**
 * What every native surface shows (the notification, the widget): the
 * nearest recorded marker post and the time of the position it came from.
 *
 * The strings are prepared by the app's own JavaScript (posts.tsv for the
 * native tracker, publishPost for the web view) and are only ever copied.
 * This class and the rule classes below it use no Android classes, so the
 * unit tests can run them on the build machine.
 */
data class Snapshot(
    /** Display road name: "M27", "A3(M)". */
    val road: String,
    /** "M", "A" or "O". Chooses the badge colour only. */
    val roadClass: String,
    /** Chainage for display, "17.4". Empty when the recorded reference is unusual: then [ref] is shown. */
    val km: String,
    /** Carriageway letter. May be empty. */
    val letter: String,
    /** The recorded reference, verbatim: "P17/4A". */
    val ref: String,
    /**
     * The line under the post: "J4 – J5", "A303 jct · 349 m from post",
     * "Link M27B/M3B · survey date unknown", or empty. A long way from every
     * recorded post the tracker says that here instead (TrackingRules.farContext).
     */
    val context: String,
    /** True when the direction of travel chose the carriageway. False: chosen by position only. */
    val confirmed: Boolean,
    /** The time the position was true, in milliseconds since 1970. */
    val fixTime: Long,
    /** No usable fix recently: show as last known, never as current. */
    val stale: Boolean,
    /** Live tracking was running when this was written. Kept as a record: no surface is worded by it. */
    val tracking: Boolean
) {

    /** One line for narrow places: "M27 17.4 A", or "M27 P17/4A" when the reference is unusual. */
    fun oneLine(): String {
        val post = if (km.isEmpty()) ref else if (letter.isEmpty()) km else "$km $letter"
        return if (road.isEmpty()) post else "$road $post"
    }

    /** The post without its road: "17.4A", or the reference when it is unusual. */
    fun shortText(): String = if (km.isEmpty()) ref else km + letter

    /**
     * True when the letter on show was chosen by position only. A surface
     * must never show such a letter as if it were confirmed: it draws it
     * outlined where it can, says "Check carriageway" where it can only print
     * text, and leaves the letter out where there is no room for words.
     * (The same test as the web app's first page. An unusual reference is
     * shown whole and has no separate letter to mark.)
     */
    fun letterUnconfirmed(): Boolean = !confirmed && km.isNotEmpty() && letter.isNotEmpty()

    /**
     * True when the post is only the nearest one on record, a long way from
     * the position: the line under it says so (TrackingRules.farContext).
     */
    fun farFromPost(): Boolean = TrackingRules.isFarContext(context)

    /**
     * The notification's title: the post on one line, "M27 17.4 A".
     *
     * A long way from the post it is "M27 17.4": a letter that is not
     * confirmed is left out. Near the post such a letter is covered by the
     * words "Check carriageway" straight after the time (notificationParts).
     * A long way off those words come after the far line, where a
     * notification that shows one line may cut them off, and a letter must
     * never be left looking confirmed.
     */
    fun notificationTitle(): String =
        if (farFromPost() && letterUnconfirmed()) copy(letter = "").oneLine() else oneLine()

    /**
     * The notification's text as its parts, in the order they are shown. The
     * phone joins them with a dot: "Updated 14:32 · J4 – J5".
     *
     * A notification often shows one line of its text and cuts that line at
     * its end, so the order decides what can be lost:
     *
     *  1. The time, always: [updated] ("Updated 14:32"), or [noGpsSince]
     *     ("No GPS since 14:32") when the position has gone quiet. It is
     *     never the part cut.
     *  2. A long way from the post, the line that says so ("Nearest recorded
     *     post · 1.24 km away"). With it cut off, the post in the title
     *     would pass for the vehicle's own.
     *  3. [check] ("Check carriageway") when the letter was chosen by
     *     position only: a notification cannot draw the outlined letter.
     *  4. [lastKnown] ("last known post") when the position has gone quiet.
     *  5. The line under the post ("J4 – J5"), last: the first part to go.
     *
     * The words are the fixed ones in strings.xml. They are handed in
     * (SurfaceText.notificationText) so that the order can be tested without
     * a phone.
     */
    fun notificationParts(updated: String, noGpsSince: String, check: String, lastKnown: String): List<String> {
        val far = farFromPost()
        val parts = ArrayList<String>()
        parts.add(if (stale) noGpsSince else updated)
        if (far) parts.add(context)
        if (letterUnconfirmed()) parts.add(check)
        if (stale) parts.add(lastKnown)
        if (!far && context.isNotEmpty()) parts.add(context)
        return parts
    }

    /**
     * The post for the status bar chip: "17.4A", or "17.4" while the letter is
     * not confirmed, because a chip has no room to say "check". Null for no
     * text at all: when the post is stale or a long way off (a chip cannot
     * say "last known" or "nearest recorded post, 1.24 km away", so it must
     * not show the post), and when the text would not fit (half a reference
     * is worse than none).
     */
    fun chipText(): String? {
        if (stale || farFromPost()) return null
        val text = if (letterUnconfirmed()) km else shortText()
        return if (text.isEmpty() || text.length > MAX_CHIP_CHARACTERS) null else text
    }

    /**
     * True when the two would look the same on screen, apart from the time.
     * Used to avoid redrawing every second when only the fix time moved on.
     * The fields are the contract's (docs/native-apps.md, section 4, step 5).
     */
    fun showsSameAs(other: Snapshot): Boolean =
        road == other.road && ref == other.ref && context == other.context &&
            confirmed == other.confirmed && stale == other.stale

    /**
     * True when the two are of a far post and would look different only in
     * how far away the post is said to be. That figure changes with every few
     * metres driven, so the tracker redraws for it at a slower pace than for
     * a real change.
     */
    fun differsOnlyInFarDistance(other: Snapshot): Boolean =
        context != other.context && farFromPost() && other.farFromPost() &&
            copy(context = other.context).showsSameAs(other)

    companion object {
        /** Android shows a status bar chip in full only when it is shorter than seven characters. */
        const val MAX_CHIP_CHARACTERS = 6

        /** The snapshot for a post found by the live tracker from a fresh fix. */
        fun live(post: Post, confirmed: Boolean, fixTime: Long): Snapshot =
            Snapshot(
                post.road, post.roadClass, post.km, post.letter, post.ref, post.context,
                confirmed, fixTime, false, true
            )

        /**
         * Steps 2 to 4 of "on every fix" (docs/native-apps.md, section 4):
         * find the post, decide whether its carriageway is confirmed, and
         * build what the surfaces show. Null when there are no posts.
         *
         * A post further than TrackingRules.FAR_POST_M from the fix is still
         * reported, but only as the nearest one on record: its carriageway is
         * never confirmed, whatever the heading says, and the line under it
         * gives the distance in place of the junction section. Such a fix
         * leaves [memory] alone: it neither makes a confirmation nor forgets one.
         */
        fun forFix(
            posts: List<Post>,
            lat: Double,
            lng: Double,
            heading: Double?,
            speed: Double?,
            useHeading: Boolean,
            fixTime: Long,
            memory: CarriagewayMemory
        ): Snapshot? {
            val nearest = PostLookup.findNearest(posts, lat, lng, heading, speed, useHeading)
            if (nearest.index < 0) return null
            val post = posts[nearest.index]
            if (TrackingRules.isFar(nearest.distance)) {
                return live(post, false, fixTime).copy(context = TrackingRules.farContext(nearest.distance))
            }
            return live(post, memory.confirm(post, nearest.headingUsed, lat, lng), fixTime)
        }
    }
}

/**
 * The "confirmed" rule: is the carriageway letter known, or only guessed
 * from position?
 *
 * It is known when the direction of travel chose it. It stays known while the
 * nearest post is on the same road and letter and the vehicle is still within
 * 300 m of where the direction last chose it: you cannot change carriageway
 * without driving. This affects the label only, never which post is reported.
 */
class CarriagewayMemory {
    private var road: String? = null
    private var letter: String = ""
    private var lat: Double = 0.0
    private var lng: Double = 0.0

    fun confirm(post: Post, headingUsed: Boolean, fixLat: Double, fixLng: Double): Boolean {
        if (headingUsed) {
            road = post.road
            letter = post.letter
            lat = fixLat
            lng = fixLng
            return true
        }
        val confirmedRoad = road ?: return false
        return confirmedRoad == post.road && letter == post.letter &&
            PostLookup.haversine(fixLat, fixLng, lat, lng) < CONFIRMED_WITHIN_M
    }

    /**
     * Forgets the last confirmation. The web app does this when "prefer my
     * direction of travel" is switched off, so the tracker does too.
     */
    fun reset() {
        road = null
        letter = ""
    }

    companion object {
        const val CONFIRMED_WITHIN_M = 300.0
    }
}

/**
 * The tracker's rules that need no phone to check: which fixes it uses, the
 * time a fix carries, when a post stops being current, and what is shown a
 * long way from every recorded post.
 */
object TrackingRules {
    const val STALE_MOVING_MS = 15_000L
    const val STALE_UNKNOWN_SPEED_MS = 30_000L
    const val STALE_STATIONARY_MS = 120_000L

    /**
     * A fix whose reported accuracy is worse than this many metres is not
     * used. The posts are 100 m apart, so a rougher position cannot tell one
     * post from the next.
     */
    const val MAX_USABLE_ACCURACY_M = 100.0

    /** Straight-line distance in metres beyond which the nearest post is only "the nearest one on record". */
    const val FAR_POST_M = 250.0

    /** A fix older than this when it arrives is a left-over, not a position (see fixAgeMs). */
    const val MAX_FIX_AGE_MS = 10_000L

    /**
     * How old the last fix may be before its post stops being current, given
     * the speed that fix reported (null: it reported none). Moving, a gap of
     * 15 s matters (the post changes every few seconds). Stationary, the post
     * cannot change, so only a long silence is flagged. With no speed
     * reported, something in between. The web app's own rule (staleAfterMs in
     * core/posts.js), where a speed that is not a number is no speed at all.
     */
    fun staleAfterMs(lastSpeed: Double?): Long {
        if (lastSpeed == null) return STALE_UNKNOWN_SPEED_MS
        val speed: Double = lastSpeed
        if (speed.isNaN()) return STALE_UNKNOWN_SPEED_MS
        return if (speed > PostLookup.HEADING_MIN_SPEED) STALE_MOVING_MS else STALE_STATIONARY_MS
    }

    fun isStale(ageMs: Long, lastSpeed: Double?): Boolean = ageMs > staleAfterMs(lastSpeed)

    /**
     * False when a fix is too rough to be a position. Such a fix is ignored
     * altogether: it does not move the post, and it does not refresh the
     * "updated" time or put off the moment the last good fix goes stale.
     *
     * [accuracy] is the figure the fix reported, in metres, or null when it
     * reported none. A fix with no figure is accepted, and so is one whose
     * figure is not a number.
     */
    fun accuracyIsUsable(accuracy: Double?): Boolean {
        if (accuracy == null) return true
        val metres: Double = accuracy
        return metres.isNaN() || metres <= MAX_USABLE_ACCURACY_M
    }

    /**
     * How old a fix is when it arrives, in milliseconds, or null for a fix
     * that must not be used at all. The time shown with a post, and the time
     * the stale rule counts from, is now less this age: the time the position
     * was true, not the time it arrived.
     *
     * A fix carries two times. [uptimeAgeMs] is its age by the phone's uptime
     * clock (Location.getElapsedRealtimeNanos), which cannot jump and so is
     * the one an age is measured by. [clockAgeMs] is its age by the ordinary
     * clock (Location.getTime), which can be wrong.
     *
     *  - Normally the age is the uptime age. A fix stamped later than now is
     *    taken as new, so no time on screen is ever in the future.
     *  - When both clocks say the fix is older than MAX_FIX_AGE_MS it is a
     *    left-over: a position the phone had kept from earlier and hands over
     *    when updates are first asked for. It says where the phone was, not
     *    where it is, so it is not used: null.
     *  - When only the uptime clock says so, the two disagree. Either can be
     *    wrong on some phones, and a fresh fix is never thrown away on the
     *    word of one: it is used, as old as a fix may be and no older.
     */
    fun fixAgeMs(uptimeAgeMs: Long, clockAgeMs: Long): Long? {
        if (uptimeAgeMs > MAX_FIX_AGE_MS) return if (clockAgeMs > MAX_FIX_AGE_MS) null else MAX_FIX_AGE_MS
        return if (uptimeAgeMs < 0L) 0L else uptimeAgeMs
    }

    /** True when the chosen post is more than FAR_POST_M from the fix. */
    fun isFar(distance: Double): Boolean = distance > FAR_POST_M

    // The two ends of the line shown under a far post. The distance goes
    // between them. (\u00B7 is the raised dot the app puts between the parts
    // of a line.) The words are fixed here, not in strings.xml, because the
    // line is kept in the snapshot like the ones the JavaScript prepares, and
    // it must read the same as in the web app and on the iPhone.
    private const val FAR_LINE_START = "Nearest recorded post \u00B7 "
    private const val FAR_LINE_END = " away"

    /**
     * The line shown under a far post in place of its own:
     * "Nearest recorded post · 1.24 km away". It says how far the post is and
     * nothing else: not that the vehicle is off the road, which is not known.
     */
    fun farContext(distance: Double): String =
        FAR_LINE_START + DistanceText.fmtDist(distance) + FAR_LINE_END

    /**
     * True when a line under a post is one that farContext wrote. No recorded
     * post has such a line of its own (the tests check the whole list), so the
     * line itself says that the post is far, and nothing has to be added to
     * the snapshot to say so.
     */
    fun isFarContext(line: String): Boolean =
        line.startsWith(FAR_LINE_START) && line.endsWith(FAR_LINE_END)
}

/**
 * Distances, written exactly as the web app writes them (fmtDist in
 * core/posts.js), so a distance reads the same on the lock screen as in the app.
 */
object DistanceText {
    /**
     * "38 m" below 1000 m, "1.24 km" below 10 km, "12.4 km" from there on.
     *
     * Digit for digit what the JavaScript gives, including the two edges that
     * look odd: 999.5 m is "1000 m" and 9999 m is "10.00 km". BigDecimal
     * holds the exact value of the number, as JavaScript's toFixed works from,
     * and a figure exactly half way goes up, as Math.round and toFixed do.
     * The decimal point is always a full stop, whatever the phone's language.
     */
    fun fmtDist(metres: Double): String {
        // Not a distance. The lookup never gives one of these; nothing is
        // written rather than a number that would mean nothing.
        if (metres.isNaN() || metres.isInfinite() || metres < 0.0) return ""
        if (metres < 1000.0) return rounded(metres, 0) + " m"
        return rounded(metres / 1000.0, if (metres < 10000.0) 2 else 1) + " km"
    }

    private fun rounded(value: Double, places: Int): String =
        BigDecimal(value).setScale(places, RoundingMode.HALF_UP).toPlainString()
}

/**
 * The last known post, kept as JSON in SharedPreferences "markerpost_state",
 * key "snapshot". The tracking service and publishPost write it; the widget
 * reads it. It is private to the app and is never copied to a cloud backup
 * (the app switches backups off). Android 12 and later can still carry it to
 * the user's next phone when one phone is copied straight to another.
 */
object SnapshotStore {
    private const val PREFERENCES = "markerpost_state"
    private const val KEY = "snapshot"

    /** The last known post, or null if there has never been one. */
    fun read(context: Context): Snapshot? = decode(preferences(context).getString(KEY, null))

    fun write(context: Context, snapshot: Snapshot) {
        preferences(context).edit().putString(KEY, encode(snapshot)).apply()
    }

    private fun preferences(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    private fun encode(snapshot: Snapshot): String {
        val json = JSONObject()
        json.put("road", snapshot.road)
        json.put("roadClass", snapshot.roadClass)
        json.put("km", snapshot.km)
        json.put("letter", snapshot.letter)
        json.put("ref", snapshot.ref)
        json.put("context", snapshot.context)
        json.put("confirmed", snapshot.confirmed)
        json.put("fixTime", snapshot.fixTime)
        json.put("stale", snapshot.stale)
        json.put("tracking", snapshot.tracking)
        return json.toString()
    }

    /** Null for anything that is not a complete snapshot: a post with no time is never shown. */
    private fun decode(text: String?): Snapshot? {
        if (text == null || text.isEmpty()) return null
        try {
            val json = JSONObject(text)
            val fixTime = json.optLong("fixTime", 0L)
            val km = string(json, "km")
            val ref = string(json, "ref")
            if (fixTime <= 0L) return null
            if (km.isEmpty() && ref.isEmpty()) return null
            return Snapshot(
                string(json, "road"),
                string(json, "roadClass"),
                km,
                string(json, "letter"),
                ref,
                string(json, "context"),
                json.optBoolean("confirmed", false),
                fixTime,
                json.optBoolean("stale", false),
                json.optBoolean("tracking", false)
            )
        } catch (e: JSONException) {
            return null
        }
    }

    private fun string(json: JSONObject, name: String): String {
        val value = json.opt(name)
        return if (value is String) value else ""
    }
}
