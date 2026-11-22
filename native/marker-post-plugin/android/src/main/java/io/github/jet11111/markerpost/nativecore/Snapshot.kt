package io.github.jet11111.markerpost.nativecore

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONException
import org.json.JSONObject

/**
 * What every native surface shows (the notification, the widget): the
 * nearest recorded marker post and the time of the position it came from.
 *
 * The strings are prepared by the app's own JavaScript (posts.tsv for the
 * native tracker, publishPost for the web view) and are only ever copied.
 * This class and the two rule classes below it use no Android classes, so
 * the unit tests can run them on the build machine.
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
    /** "J4 – J5", "At J5", "A303 jct · 349 m", "Link M27B/M3B", or empty. */
    val context: String,
    /** True when the direction of travel chose the carriageway. False: chosen by position only. */
    val confirmed: Boolean,
    /** Time of the GPS fix, in milliseconds since 1970. */
    val fixTime: Long,
    /** No usable fix recently: show as last known, never as current. */
    val stale: Boolean,
    /** Live tracking was running when this was written. */
    val tracking: Boolean
) {

    /** One line for narrow places: "M27 17.4 A", or "M27 P17/4A" when the reference is unusual. */
    fun oneLine(): String {
        val post = if (km.isEmpty()) ref else if (letter.isEmpty()) km else "$km $letter"
        return if (road.isEmpty()) post else "$road $post"
    }

    /** The post without its road, for the status bar chip: "17.4A", or the reference when it is unusual. */
    fun shortText(): String = if (km.isEmpty()) ref else km + letter

    /**
     * True when the two would look the same on screen, apart from the time.
     * Used to avoid redrawing every second when only the fix time moved on.
     * (The contract lists road, ref, context, confirmed and stale; "tracking"
     * is included as well because a widget words its time line by it.)
     */
    fun showsSameAs(other: Snapshot): Boolean =
        road == other.road && ref == other.ref && context == other.context &&
            confirmed == other.confirmed && stale == other.stale && tracking == other.tracking

    companion object {
        /** The snapshot for a post found by the live tracker from a fresh fix. */
        fun live(post: Post, confirmed: Boolean, fixTime: Long): Snapshot =
            Snapshot(
                post.road, post.roadClass, post.km, post.letter, post.ref, post.context,
                confirmed, fixTime, false, true
            )
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
 * When a post stops being current. Moving, a gap of 15 s matters (the post
 * changes every few seconds). Stationary, the post cannot change, so only a
 * long silence is flagged. With no speed reported, something in between.
 * The same limits as the web app (checkStale in app.js).
 */
object TrackingRules {
    const val STALE_MOVING_MS = 15_000L
    const val STALE_UNKNOWN_SPEED_MS = 30_000L
    const val STALE_STATIONARY_MS = 120_000L

    /** How old the last fix may be, given the speed that fix reported (null: it reported none). */
    fun staleAfterMs(lastSpeed: Double?): Long {
        if (lastSpeed == null) return STALE_UNKNOWN_SPEED_MS
        val speed: Double = lastSpeed
        return if (speed > PostLookup.HEADING_MIN_SPEED) STALE_MOVING_MS else STALE_STATIONARY_MS
    }

    fun isStale(ageMs: Long, lastSpeed: Double?): Boolean = ageMs > staleAfterMs(lastSpeed)
}

/**
 * The last known post, kept as JSON in SharedPreferences "markerpost_state",
 * key "snapshot". The tracking service and publishPost write it; the widget
 * reads it. It never leaves the phone (the app's backups are switched off).
 */
object SnapshotStore {
    private const val PREFERENCES = "markerpost_state"
    private const val KEY = "snapshot"

    /**
     * The last known post, or null if there has never been one.
     *
     * If it says live tracking was running but no tracker is running in this
     * process, the app was closed without a chance to write its final
     * snapshot (the system removed it, or the user pressed Stop in the task
     * manager). It is corrected here, once, so that no surface goes on
     * describing an old position as live.
     */
    fun read(context: Context): Snapshot? {
        val stored = decode(preferences(context).getString(KEY, null)) ?: return null
        if (stored.tracking && !TrackingState.active) {
            val corrected = stored.copy(tracking = false)
            write(context, corrected)
            return corrected
        }
        return stored
    }

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
