package io.github.jet11111.markerpost.nativecore

import android.content.Context
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * Every line of text the notification and the widget show, in one place.
 *
 * The post itself is copied from the snapshot and never re-worded. The only
 * words added are the fixed ones in res/values/strings.xml, and a time: every
 * surface says when its position was taken, so an old post cannot pass for a
 * current one.
 */
object SurfaceText {

    /**
     * The time of a fix as every surface shows it: "14:32" (24-hour, in the
     * phone's language and time zone). When that was not today the day is
     * added, "14:32, 21 Nov", and the year too once it is not this year.
     */
    fun time(context: Context, fixTime: Long): String {
        val locale = Locale.getDefault()
        val then = Calendar.getInstance()
        then.timeInMillis = fixTime
        val now = Calendar.getInstance()
        val sameYear = then.get(Calendar.YEAR) == now.get(Calendar.YEAR)
        val sameDay = sameYear && then.get(Calendar.DAY_OF_YEAR) == now.get(Calendar.DAY_OF_YEAR)

        // A new formatter each time: SimpleDateFormat must not be shared between threads.
        val date = Date(fixTime)
        val clock = SimpleDateFormat("HH:mm", locale).format(date)
        if (sameDay) return clock
        val day = SimpleDateFormat(if (sameYear) "d MMM" else "d MMM yyyy", locale).format(date)
        return context.getString(R.string.markerpost_time_on_another_day, clock, day)
    }

    /** Notification title: the post on one line, or "Waiting for GPS…" before the first fix. */
    fun notificationTitle(context: Context, snapshot: Snapshot?): String {
        if (snapshot == null) return context.getString(R.string.markerpost_waiting_for_gps)
        return snapshot.oneLine()
    }

    /**
     * Notification text: "J4 – J5 · updated 14:32", or when the position has
     * gone quiet "No GPS since 14:32 · last known post". Null before the first fix.
     */
    fun notificationText(context: Context, snapshot: Snapshot?): String? {
        if (snapshot == null) return null
        val at = time(context, snapshot.fixTime)
        if (snapshot.stale) return context.getString(R.string.markerpost_notification_stale, at)
        if (snapshot.context.isEmpty()) return context.getString(R.string.markerpost_notification_updated, at)
        return context.getString(R.string.markerpost_notification_context_updated, snapshot.context, at)
    }

    /**
     * The widget's time line. "Live" is only said for a snapshot written by a
     * tracker that is still running: SnapshotStore.read has already cleared
     * the tracking mark of one that is not.
     */
    fun widgetTime(context: Context, snapshot: Snapshot): String {
        val at = time(context, snapshot.fixTime)
        if (snapshot.stale) return context.getString(R.string.markerpost_widget_no_gps_since, at)
        if (snapshot.tracking) return context.getString(R.string.markerpost_widget_live, at)
        return context.getString(R.string.markerpost_widget_last_updated, at)
    }
}
