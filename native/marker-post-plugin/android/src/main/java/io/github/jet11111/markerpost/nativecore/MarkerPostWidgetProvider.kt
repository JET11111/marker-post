package io.github.jet11111.markerpost.nativecore

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews

/**
 * The home screen widget: the last known marker post and the time of its
 * position. A classic widget drawn with RemoteViews, so it needs no extra
 * libraries and can be redrawn straight from the tracking service.
 *
 * It never refreshes on a timer of its own. It is redrawn by the tracking
 * service on every visible change, by the plugin when the web app hands over
 * the post on screen, and when the launcher asks. Whatever it shows carries a
 * time, and it only says "Live" while a tracker is actually running.
 */
class MarkerPostWidgetProvider : AppWidgetProvider() {

    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) {
        update(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        // The base class handles the launcher's own messages and calls onUpdate.
        super.onReceive(context, intent)
        if (intent.action == ACTION_CHECK) update(context)
    }

    companion object {
        private const val ACTION_CHECK = "io.github.jet11111.markerpost.nativecore.action.CHECK_WIDGET"
        private const val REQUEST_CHECK = 4
        private const val CHECK_AFTER_MS = 180_000L

        /**
         * Draws the stored snapshot on every copy of the widget.
         * Returns true when there is at least one on a home screen.
         * Safe to call from any thread, and when there is no widget at all.
         */
        fun update(context: Context): Boolean {
            try {
                val appContext = context.applicationContext
                // Read first, widget or not: reading is also what corrects a
                // snapshot left marked as tracking by a process that was killed.
                val snapshot = SnapshotStore.read(appContext)
                val manager = AppWidgetManager.getInstance(appContext)
                val provider = ComponentName(appContext, MarkerPostWidgetProvider::class.java)
                val ids = manager.getAppWidgetIds(provider)
                if (ids == null || ids.isEmpty()) return false
                manager.updateAppWidget(provider, buildViews(appContext, snapshot))
                return true
            } catch (e: Exception) {
                // No launcher that supports widgets, or it is restarting: there
                // is nothing to draw on, and the next update will try again.
                return false
            }
        }

        /**
         * Books one redraw a few minutes ahead, while the widget says "Live".
         *
         * If the system removes the app while it is tracking, nothing gets the
         * chance to redraw the widget, and it would go on saying "Live" with an
         * old post. The booked redraw runs in a fresh process, finds no tracker
         * running, and the widget then says "Last updated 14:32" instead. While
         * tracking is healthy the service keeps moving the booking forward, so
         * it does not fire. It does not wake a sleeping phone: it runs when the
         * phone is next awake, which is when the widget can be seen.
         */
        fun bookCheck(context: Context) {
            try {
                val appContext = context.applicationContext
                val alarms = appContext.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
                alarms.set(
                    AlarmManager.ELAPSED_REALTIME,
                    SystemClock.elapsedRealtime() + CHECK_AFTER_MS,
                    checkIntent(appContext)
                )
            } catch (e: Exception) {
                // Without the booking the widget is corrected the next time the app is opened.
            }
        }

        fun cancelCheck(context: Context) {
            try {
                val appContext = context.applicationContext
                val alarms = appContext.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
                alarms.cancel(checkIntent(appContext))
            } catch (e: Exception) {
                // A booking that still fires only redraws the widget, which is harmless.
            }
        }

        private fun checkIntent(context: Context): PendingIntent {
            val intent = Intent(context, MarkerPostWidgetProvider::class.java).setAction(ACTION_CHECK)
            return PendingIntent.getBroadcast(
                context,
                REQUEST_CHECK,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }

        private fun buildViews(context: Context, snapshot: Snapshot?): RemoteViews {
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
                views.setViewVisibility(chip, View.VISIBLE)
            }

            // The junction line, when the records give one.
            views.setTextViewText(R.id.markerpost_context, snapshot.context)
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
