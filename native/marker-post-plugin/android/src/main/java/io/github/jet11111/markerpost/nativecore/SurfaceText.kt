package io.github.jet11111.markerpost.nativecore

import android.content.Context
import java.util.Calendar
import java.util.GregorianCalendar
import java.util.TimeZone

/**
 * The time of a fix as every surface writes it. A port of fmtClock in
 * core/posts.js, so a time reads the same on the lock screen as in the app.
 * Plain Kotlin with no Android classes, so the unit tests can run it.
 */
object SurfaceClock {

    private val MONTHS = arrayOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

    /**
     * "14:32": always the 24-hour clock, whatever the phone's own setting,
     * because that is how Traffic Officers log. When the fix was not today
     * the date goes in front, "21 Nov, 14:32" (with the year once that
     * differs too), so an old time can never be read as today's.
     *
     * [fixTime] and [now] are milliseconds since 1970; [zone] is the phone's
     * time zone. The digits and the month are written out here rather than
     * taken from the phone's language, so the line is the same on every phone.
     */
    fun label(fixTime: Long, now: Long, zone: TimeZone): String {
        val then = calendar(fixTime, zone)
        val today = calendar(now, zone)
        val clock = twoDigits(then.get(Calendar.HOUR_OF_DAY)) + ":" + twoDigits(then.get(Calendar.MINUTE))
        val sameYear = then.get(Calendar.YEAR) == today.get(Calendar.YEAR)
        if (sameYear && then.get(Calendar.DAY_OF_YEAR) == today.get(Calendar.DAY_OF_YEAR)) return clock
        val year = if (sameYear) "" else " " + then.get(Calendar.YEAR)
        return then.get(Calendar.DAY_OF_MONTH).toString() + " " + MONTHS[then.get(Calendar.MONTH)] + year + ", " + clock
    }

    /**
     * When the label for [fixTime] will next read differently, in
     * milliseconds since 1970, or 0 when it never will: the coming midnight
     * for a time from today (it then gains its date), the coming new year for
     * an earlier day of this year (it then gains its year). A surface that
     * can sit untouched overnight books a redraw for this moment.
     */
    fun nextChange(fixTime: Long, now: Long, zone: TimeZone): Long {
        val then = calendar(fixTime, zone)
        val today = calendar(now, zone)
        val year = today.get(Calendar.YEAR)
        val sameYear = then.get(Calendar.YEAR) == year
        val sameDay = sameYear && then.get(Calendar.DAY_OF_YEAR) == today.get(Calendar.DAY_OF_YEAR)
        // A fix from "later than now" means the phone's clock has been put
        // back since. Look again every midnight until the clock has caught up.
        if (sameDay || fixTime > now) {
            // The day after the last of a month is the first of the next.
            return startOfDay(zone, year, today.get(Calendar.MONTH), today.get(Calendar.DAY_OF_MONTH) + 1)
        }
        if (sameYear) return startOfDay(zone, year + 1, Calendar.JANUARY, 1)
        return 0L
    }

    private fun calendar(time: Long, zone: TimeZone): Calendar {
        // The everyday calendar on every phone, whatever its region uses.
        val moment = GregorianCalendar(zone)
        moment.timeInMillis = time
        return moment
    }

    private fun startOfDay(zone: TimeZone, year: Int, month: Int, day: Int): Long {
        val midnight = GregorianCalendar(zone)
        midnight.clear()
        midnight.set(year, month, day, 0, 0, 0)
        return midnight.timeInMillis
    }

    private fun twoDigits(value: Int): String = if (value < 10) "0$value" else value.toString()
}

/**
 * Every line of text the notification and the widget show, in one place.
 *
 * The post itself is copied from the snapshot and never re-worded. The only
 * words added are the fixed ones in res/values/strings.xml, and a time: every
 * surface says when its position was taken, so an old post cannot pass for a
 * current one.
 */
object SurfaceText {

    /** The time of a fix as every surface shows it, read against the phone's own clock: see SurfaceClock.label. */
    fun clock(fixTime: Long): String =
        SurfaceClock.label(fixTime, System.currentTimeMillis(), TimeZone.getDefault())

    /**
     * Notification title: the post on one line (Snapshot.notificationTitle),
     * or "Waiting for GPS…" before the first fix.
     */
    fun notificationTitle(context: Context, snapshot: Snapshot?): String {
        if (snapshot == null) return context.getString(R.string.markerpost_waiting_for_gps)
        return snapshot.notificationTitle()
    }

    /**
     * Notification text: "Updated 14:32 · J4 – J5", or when the position has
     * gone quiet "No GPS since 14:32 · last known post · J4 – J5". Null
     * before the first fix.
     *
     * A lock screen shows one line of it and cuts that line at the end. So
     * the time comes first and is never the part that is lost, and the line
     * under the post comes last. Which parts there are, and their order, is
     * Snapshot.notificationParts, where it is tested; only the words, from
     * strings.xml, are put in here.
     */
    fun notificationText(context: Context, snapshot: Snapshot?): String? {
        if (snapshot == null) return null
        val at = clock(snapshot.fixTime)
        val parts = snapshot.notificationParts(
            updated = context.getString(R.string.markerpost_notification_updated, at),
            noGpsSince = context.getString(R.string.markerpost_no_gps_since, at),
            check = context.getString(R.string.markerpost_check_carriageway),
            lastKnown = context.getString(R.string.markerpost_last_known_post)
        )
        // There is always a first part: the time.
        return parts.reduce { line, part -> joined(context, line, part) }
    }

    /**
     * The widget's time line: "Last updated 14:32", or "No GPS since 14:32"
     * when its position went stale. A widget is not a live display, so it
     * never says "Live", whether or not tracking is running.
     */
    fun widgetTime(context: Context, snapshot: Snapshot): String {
        val at = clock(snapshot.fixTime)
        if (snapshot.stale) return context.getString(R.string.markerpost_no_gps_since, at)
        return context.getString(R.string.markerpost_widget_last_updated, at)
    }

    /** What a screen reader says for a letter drawn as an outline: "A, check carriageway". */
    fun unconfirmedLetter(context: Context, letter: String): String =
        context.getString(R.string.markerpost_letter_unconfirmed, letter)

    private fun joined(context: Context, first: String, second: String): String =
        context.getString(R.string.markerpost_joined, first, second)
}
