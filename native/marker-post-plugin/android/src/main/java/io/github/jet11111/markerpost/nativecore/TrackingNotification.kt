package io.github.jet11111.markerpost.nativecore

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat

/**
 * The ongoing notification that live tracking runs behind: the nearest post
 * on the lock screen and in the notification shade, with one action, "Stop".
 *
 * Quiet by design: low importance, no sound, no vibration, and it only
 * redraws. It is shown in full on the lock screen because the whole point is
 * to read it without unlocking the phone.
 */
object TrackingNotification {

    const val CHANNEL_ID = "live_tracking"
    const val NOTIFICATION_ID = 4127

    private const val REQUEST_OPEN = 1
    private const val REQUEST_STOP = 2
    private const val REQUEST_DISMISSED = 3

    /**
     * Creates the notification channel (Android 8 and later). Safe to call
     * every time: an existing channel keeps the importance the user has set.
     */
    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            if (manager != null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    context.getString(R.string.markerpost_channel_name),
                    NotificationManager.IMPORTANCE_LOW
                )
                channel.description = context.getString(R.string.markerpost_channel_description)
                channel.setShowBadge(false)
                channel.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
                manager.createNotificationChannel(channel)
            }
        }
    }

    /**
     * True when the user has switched off the "Live tracking" category by
     * itself (Android 8 and later), leaving the app's other notifications on.
     * Tracking then runs with nothing to see, exactly as when notifications
     * are off for the whole app, and the web app is told the same way.
     */
    fun channelSwitchedOff(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return false
        // No channel yet: tracking has never started, so nothing is switched off.
        val channel = manager.getNotificationChannel(CHANNEL_ID) ?: return false
        return channel.importance == NotificationManager.IMPORTANCE_NONE
    }

    /**
     * Builds the notification for a snapshot, or the "Waiting for GPS…" one
     * when [snapshot] is null (before the first fix).
     */
    fun build(context: Context, snapshot: Snapshot?): Notification {
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_markerpost)
            .setContentTitle(SurfaceText.notificationTitle(context, snapshot))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            // The time is written into the text ("Updated 14:32"); the
            // notification's own clock would show when it was last redrawn,
            // which is not the same thing.
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            // Without this, Android 12 and later may hold the notification back for ten seconds.
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, context.getString(R.string.markerpost_action_stop), toService(context, TrackingService.ACTION_STOP, REQUEST_STOP))
            // Android 14 and later let an ongoing notification be swiped away.
            // Tracking with nothing on screen to show for it would be a
            // surprise, so swiping it away stops tracking too.
            .setDeleteIntent(toService(context, TrackingService.ACTION_DISMISSED, REQUEST_DISMISSED))

        val text = SurfaceText.notificationText(context, snapshot)
        if (text != null) {
            builder.setContentText(text)
            // Closed up, a notification shows one line of its text and cuts
            // the end off a long one. Opened out, this shows all of it.
            builder.setStyle(NotificationCompat.BigTextStyle().bigText(text))
        }

        val open = openApp(context)
        if (open != null) builder.setContentIntent(open)

        requestLiveUpdate(builder, snapshot?.chipText())
        return builder.build()
    }

    /**
     * Asks Android 16 and later to show the notification as a Live Update: at
     * the top of the shade and as a chip in the status bar carrying the post.
     * Older versions ignore the request. Whether to honour it is up to the
     * system and the user; nothing depends on it.
     *
     * These two calls exist from androidx.core 1.17.0, the version Capacitor 8
     * pins. If the build ever reports them missing, delete this function's two
     * lines: everything else works without them.
     *
     * [chip] is the post for the chip (Snapshot.chipText), or null for no
     * text: while waiting for GPS, and whenever the snapshot gives none.
     */
    private fun requestLiveUpdate(builder: NotificationCompat.Builder, chip: String?) {
        builder.setRequestPromotedOngoing(true)
        if (chip != null) builder.setShortCriticalText(chip)
    }

    /** Opens the app (its launcher screen). Used by the notification and by the widget. */
    fun openApp(context: Context): PendingIntent? {
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
        return PendingIntent.getActivity(
            context,
            REQUEST_OPEN,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }

    private fun toService(context: Context, action: String, requestCode: Int): PendingIntent {
        val intent = Intent(context, TrackingService::class.java).setAction(action)
        return PendingIntent.getService(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
