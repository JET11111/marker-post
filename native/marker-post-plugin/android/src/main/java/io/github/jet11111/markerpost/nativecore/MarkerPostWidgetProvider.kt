package io.github.jet11111.markerpost.nativecore

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import java.util.TimeZone

/**
 * The home screen widget: the last known marker post and the time of its
 * position. A classic widget drawn with RemoteViews, so it needs no extra
 * libraries and can be redrawn straight from the tracking service.
 *
 * A widget is not a live display and never says it is. Its time line reads
 * "Last updated 14:32", or "No GPS since 14:32" when the position went stale,
 * whether or not tracking is running. It is redrawn by the tracking service
 * on every visible change, by the plugin when the web app hands over the post
 * on screen, and when the launcher asks or gives the widget a new size.
 *
 * It has no timer of its own, with one exception. A time from today is
 * written without its date, and a widget can sit untouched overnight, where
 * yesterday's "14:32" would be read as today's. So every drawing books one
 * redraw for the moment its time will read differently: the next midnight.
 */
class MarkerPostWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        update(context)
    }

    /**
     * The launcher has made the widget another size, or has only now said
     * what size it is. How many lines the line under the post may take goes
     * by the widget's height (WidgetRules.contextLines), so it is drawn again.
     */
    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle?
    ) {
        update(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        // The base class handles the launcher's own messages and calls
        // onUpdate and onAppWidgetOptionsChanged.
        super.onReceive(context, intent)
        val action = intent.action
        if (action == ACTION_REDRAW || action == Intent.ACTION_TIME_CHANGED || action == Intent.ACTION_TIMEZONE_CHANGED) {
            // The booked redraw has arrived, or the clock it was booked by has
            // been changed. Either way that booking is spent: draw, and book afresh.
            redrawBookedFor = 0L
            update(context)
        }
    }

    companion object {
        private const val ACTION_REDRAW = "io.github.jet11111.markerpost.nativecore.action.REDRAW_WIDGET"
        private const val REQUEST_REDRAW = 4

        /** The redraw may come up to ten minutes after the moment asked for: Android's shortest window. */
        private const val REDRAW_WINDOW_MS = 600_000L

        /** The moment the booked redraw is for (milliseconds since 1970), so it is booked once and not on every drawing. 0: none. */
        @Volatile
        private var redrawBookedFor = 0L

        /**
         * Draws the stored snapshot on every copy of the widget.
         * Safe to call from any thread, and when there is no widget at all.
         *
         * The text size is read when the widget is drawn. After the phone's
         * text size is changed, the widget goes by the new one from its next
         * drawing: while tracking that is within half a minute, otherwise
         * when the app is next opened.
         */
        fun update(context: Context) {
            try {
                val appContext = context.applicationContext
                val manager = AppWidgetManager.getInstance(appContext)
                val provider = ComponentName(appContext, MarkerPostWidgetProvider::class.java)
                val ids = manager.getAppWidgetIds(provider)
                if (ids == null || ids.isEmpty()) return
                val snapshot = SnapshotStore.read(appContext)
                val fontScale = appContext.resources.configuration.fontScale
                // Each copy by itself: two copies can be two different heights.
                for (id in ids) {
                    manager.updateAppWidget(id, viewsFor(appContext, snapshot, optionsOf(manager, id), fontScale))
                }
                bookRedraw(appContext, snapshot)
            } catch (e: Exception) {
                // No launcher that supports widgets, or it is restarting: there
                // is nothing to draw on, and the next update will try again.
            }
        }

        /** What the launcher has said about one copy of the widget, or null when it cannot be asked. */
        private fun optionsOf(manager: AppWidgetManager, id: Int): Bundle? =
            try {
                manager.getAppWidgetOptions(id)
            } catch (e: Exception) {
                // The widget is still drawn, as for a launcher that says nothing.
                null
            }

        /**
         * The views for one copy of the widget, by the height the launcher
         * gives it. A widget has two heights: its greatest with the phone
         * upright, its least with the phone on its side. Where the two give
         * different answers the launcher is handed both drawings, and shows
         * the one for the way the phone is being held.
         */
        private fun viewsFor(context: Context, snapshot: Snapshot?, options: Bundle?, fontScale: Float): RemoteViews {
            val upright = WidgetRules.contextLines(height(options, AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT), fontScale)
            val onItsSide = WidgetRules.contextLines(height(options, AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT), fontScale)
            val portrait = buildViews(context, snapshot, upright)
            if (snapshot == null || onItsSide == upright) return portrait
            return RemoteViews(buildViews(context, snapshot, onItsSide), portrait)
        }

        /** One of the widget's heights in dp, or 0 when the launcher has not said. */
        private fun height(options: Bundle?, key: String): Int = options?.getInt(key) ?: 0

        /**
         * Books one redraw for the moment the time on the widget will read
         * differently (SurfaceClock.nextChange): at midnight "Last updated
         * 14:32" becomes "Last updated 21 Nov, 14:32".
         *
         * It needs no permission and does not wake a sleeping phone: it runs
         * when the phone is next awake, which is when the widget can be seen.
         * A restart or a forced stop loses the booking. The launcher redraws
         * every widget after a restart, and the app redraws this one whenever
         * it is opened; both book it again.
         */
        private fun bookRedraw(context: Context, snapshot: Snapshot?) {
            val due = if (snapshot == null) {
                0L
            } else {
                SurfaceClock.nextChange(snapshot.fixTime, System.currentTimeMillis(), TimeZone.getDefault())
            }
            if (due == redrawBookedFor) return
            try {
                val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
                if (due == 0L) {
                    alarms.cancel(redrawIntent(context))
                } else {
                    alarms.setWindow(AlarmManager.RTC, due, REDRAW_WINDOW_MS, redrawIntent(context))
                }
                redrawBookedFor = due
            } catch (e: Exception) {
                // Without the booking the time gains its date the next time
                // anything redraws the widget: tracking, or the app being opened.
            }
        }

        private fun redrawIntent(context: Context): PendingIntent {
            val intent = Intent(context, MarkerPostWidgetProvider::class.java).setAction(ACTION_REDRAW)
            return PendingIntent.getBroadcast(
                context,
                REQUEST_REDRAW,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        /**
         * The widget's views for a snapshot, or for "no post yet" when there
         * is none. [contextLines] is how many lines the line under the post
         * may take (WidgetRules.contextLines). Not private, so that the debug
         * build's preview screen (src/debug) draws exactly what a home screen
         * is sent.
         */
        internal fun buildViews(context: Context, snapshot: Snapshot?, contextLines: Int): RemoteViews {
            val open = TrackingNotification.openApp(context)

            if (snapshot == null) {
                // Never had a position: say so, and nothing else.
                val empty = RemoteViews(context.packageName, R.layout.markerpost_widget_empty)
                if (open != null) empty.setOnClickPendingIntent(android.R.id.background, open)
                return empty
            }

            // The stale layout is the same views in faded colours (see its file for why).
            val layout = if (snapshot.stale) R.layout.markerpost_widget_stale else R.layout.markerpost_widget
            val views = RemoteViews(context.packageName, layout)

            // A launcher re-uses the views it already has, so every view is set
            // every time: one left alone would keep what the last post put there.

            // Road badge: colour by class of road, text copied from the snapshot.
            val badge = when (snapshot.roadClass) {
                "M" -> R.id.markerpost_badge_motorway
                "A" -> R.id.markerpost_badge_a_road
                else -> R.id.markerpost_badge_other
            }
            views.setViewVisibility(R.id.markerpost_badge_motorway, View.GONE)
            views.setViewVisibility(R.id.markerpost_badge_a_road, View.GONE)
            views.setViewVisibility(R.id.markerpost_badge_other, View.GONE)
            if (snapshot.road.isNotEmpty()) {
                views.setTextViewText(badge, snapshot.road)
                views.setViewVisibility(badge, View.VISIBLE)
            }

            // The post: the chainage, or the recorded reference verbatim when it is unusual.
            val hasChainage = snapshot.km.isNotEmpty()
            views.setTextViewText(R.id.markerpost_km, if (hasChainage) snapshot.km else snapshot.ref)

            // Carriageway letter: filled when the direction of travel chose it,
            // outlined when it is by position only. An unusual reference is shown
            // whole, letter included, so it gets no chip.
            val chip = if (snapshot.confirmed) R.id.markerpost_chip_filled else R.id.markerpost_chip_outline
            views.setViewVisibility(R.id.markerpost_chip_filled, View.GONE)
            views.setViewVisibility(R.id.markerpost_chip_outline, View.GONE)
            if (hasChainage && snapshot.letter.isNotEmpty()) {
                views.setTextViewText(chip, snapshot.letter)
                // A screen reader cannot see an outline, so it is told in words.
                views.setContentDescription(
                    chip,
                    if (snapshot.confirmed) snapshot.letter else SurfaceText.unconfirmedLetter(context, snapshot.letter)
                )
                views.setViewVisibility(chip, View.VISIBLE)
            }

            // The line under the post, when there is one: on two lines where
            // the widget is high enough, otherwise on one, cut at its end.
            views.setTextViewText(R.id.markerpost_context, snapshot.context)
            views.setInt(R.id.markerpost_context, "setMaxLines", if (contextLines >= 2) 2 else 1)
            views.setViewVisibility(
                R.id.markerpost_context,
                if (snapshot.context.isEmpty()) View.GONE else View.VISIBLE
            )

            // Always a time.
            views.setTextViewText(R.id.markerpost_time, SurfaceText.widgetTime(context, snapshot))

            if (open != null) views.setOnClickPendingIntent(android.R.id.background, open)
            return views
        }
    }
}

/**
 * How much room the widget has: the one rule about its layout that is worked
 * out in code. It uses no Android classes, so the unit tests can run it.
 *
 * A launcher draws the widget from a description of it (RemoteViews), and a
 * layout cannot drop a line of text when it runs short of height. The row
 * with the post number gets whatever height the other lines leave
 * (res/layout/markerpost_widget.xml), so on a short widget a second line under
 * the post would be paid for by the number. The number is what the widget is
 * for: the second line is only allowed where there is room for both.
 */
object WidgetRules {

    // The heights below are worked out from the text sizes in
    // res/layout/markerpost_widget.xml (change them together). They are
    // estimates: a phone's own font can be a little taller or shorter.

    /** dp that stay the same at every text size: the widget's padding, 12 above and 12 below, and the road badge's, 3 and 3. */
    private const val FIXED_DP = 30.0

    /**
     * dp of text when the line under the post has two lines, at the ordinary
     * text size (it grows in step with the text size): the time on two lines
     * (32.5), the road badge (17.5), the line under the post on two lines
     * (35), and 30 for the row with the post number. In a row of 30 dp the
     * number is still about 26sp high, and the block the carriageway letter
     * sits in, though squeezed a little, still shows the whole letter.
     *
     * The time can take a third line (a date and large text on a narrow
     * widget). That is not allowed for here: it is rare, and allowing for it
     * would cut the line under the post on widgets that have room for it.
     */
    private const val TEXT_DP = 115.0

    /** The height taken when the launcher does not say: about the least a widget of two cells by two is. */
    private const val ASSUMED_HEIGHT_DP = 146

    /**
     * How many lines the line under the post may take, on a widget
     * [heightDp] high (0 when the launcher has not said) at the phone's text
     * size ([fontScale]: 1 is the ordinary size, 1.3 is 30% larger).
     *
     * Two, so that a long line ("A303 jct · 1.24 km from post") is shown
     * whole, wherever that still leaves the post number room to be read at
     * a glance. One, cut at its end with "…", on a widget too short for both.
     */
    fun contextLines(heightDp: Int, fontScale: Float): Int {
        val height = if (heightDp > 0) heightDp else ASSUMED_HEIGHT_DP
        // A text size that is not a number above nought is taken as the ordinary one.
        val scale = if (fontScale > 0f) fontScale.toDouble() else 1.0
        return if (height.toDouble() >= FIXED_DP + TEXT_DP * scale) 2 else 1
    }
}
