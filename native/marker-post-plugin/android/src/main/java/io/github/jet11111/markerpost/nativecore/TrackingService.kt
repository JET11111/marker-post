package io.github.jet11111.markerpost.nativecore

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationManager
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * Live tracking: a foreground service that keeps the nearest marker post
 * current while the screen is off or another app is in front.
 *
 * It is started by the plugin while the app is on screen (the only time
 * Android allows a location service to begin) and runs until "Stop" is
 * pressed in the app or on the notification, or the notification is swiped
 * away. It uses location "while in use" only: background location is never
 * requested, and START_NOT_STICKY means Android never restarts the service by
 * itself, because a restart from the background could not get location back.
 *
 * Everything here runs on the main thread: the start and stop commands, the
 * position callbacks and the timers. One lookup is a few thousand distance
 * calculations, once a second, so there is nothing to gain from more threads
 * and nothing to lock.
 */
class TrackingService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private val carriageway = CarriagewayMemory()

    /** The direction-of-travel preference as of the last fix, to notice it being switched off. */
    private var headingWasPreferred = true

    private var posts: List<Post> = emptyList()

    /** True from the moment positions are being asked for until the service is destroyed. */
    private var running = false
    private var destroyed = false

    /** True once this service has asked to be stopped. It cannot be started again after that. */
    private var stopping = false

    /** A start arrived after the stop: a fresh service is started once this one has finished. */
    private var restartWanted = false

    /** Why the service is stopping, for the web app. Null when the reason is not known. */
    private var stopReason: String? = null

    private var fusedClient: FusedLocationProviderClient? = null
    private var gpsActive = false
    private var screenReceiverRegistered = false

    /** The newest snapshot, shown or not. Null until the first fix. */
    private var current: Snapshot? = null

    /** The snapshot on the notification and the widget right now, when it was drawn, and the time written on it. */
    private var shown: Snapshot? = null
    private var shownAt = 0L
    private var shownClock = ""

    /** When the last fix was taken (on the clock of SystemClock.elapsedRealtime) and the speed it reported, if any. */
    private var lastFixAt = 0L
    private var lastSpeed: Double? = null

    private val staleTimer = object : Runnable {
        override fun run() {
            if (destroyed) return
            checkStale()
            handler.postDelayed(this, STALE_CHECK_MS)
        }
    }

    private val fusedCallback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val location = result.lastLocation
            if (location != null) onFix(location)
        }
    }

    private val gpsListener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            onFix(location)
        }

        // Before Android 11 the next three have no built-in empty version, and
        // the system does call them. Leaving any of them out would crash there.
        @Deprecated("Deprecated in Java")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {
        }

        override fun onProviderEnabled(provider: String) {
        }

        override fun onProviderDisabled(provider: String) {
        }
    }

    private val screenOnReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (!destroyed) checkStale()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val action = intent?.action
        if (action == ACTION_START) {
            if (stopping) {
                // A start that arrived just behind a stop. This service is
                // already on its way out and cannot be revived, so a fresh one
                // is started the moment it has finished (see onDestroy).
                restartWanted = true
            } else if (!enterForeground()) {
                // Entering the foreground comes first, every time: Android
                // gives a service started this way only a few seconds to show
                // its notification.
                stopNow()
            } else if (!running) {
                beginTracking()
            }
        } else if (action == ACTION_STOP || action == ACTION_DISMISSED) {
            stopReason = TrackingState.REASON_STOPPED_BY_USER
            restartWanted = false
            stopNow()
        } else if (!running) {
            // Nothing was asked for and nothing is running: do not linger.
            stopNow()
        }
        return START_NOT_STICKY
    }

    private fun stopNow() {
        stopping = true
        stopSelf()
    }

    override fun onDestroy() {
        destroyed = true
        handler.removeCallbacksAndMessages(null)
        stopLocationUpdates()
        if (screenReceiverRegistered) {
            try {
                unregisterReceiver(screenOnReceiver)
            } catch (e: Exception) {
                // Already gone.
            }
            screenReceiverRegistered = false
        }

        val wasRunning = running
        running = false
        if (wasRunning) {
            // The final snapshot: the newest post, no longer marked as tracked.
            // The widget keeps it, with the time of its position.
            val last = current
            if (last != null) SnapshotStore.write(this, last.copy(tracking = false))
        }
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        } catch (e: Exception) {
            // The notification goes with the service in any case.
        }
        if (wasRunning) TrackingState.markStopped(stopReason)
        MarkerPostWidgetProvider.update(this)

        if (restartWanted) {
            // The app asked to start again while this service was stopping.
            try {
                TrackingService.start(applicationContext)
            } catch (e: Exception) {
                TrackingState.reportStartFailed(TrackingState.REASON_UNSUPPORTED)
            }
        }
        super.onDestroy()
    }

    // ------------------------------------------------------------- starting

    /**
     * Puts the service in the foreground with its notification. Returns false
     * when Android refuses: the app was not on screen, a permission was
     * withdrawn, or the phone's battery settings forbid it. That is reported
     * to the app, never retried.
     */
    private fun enterForeground(): Boolean {
        try {
            TrackingNotification.ensureChannel(this)
            // Service types only exist from Android 10.
            val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
            } else {
                0
            }
            ServiceCompat.startForeground(
                this,
                TrackingNotification.NOTIFICATION_ID,
                TrackingNotification.build(this, shown),
                type
            )
            return true
        } catch (e: Exception) {
            val reason = startFailureReason()
            if (running) stopReason = reason else TrackingState.reportStartFailed(reason)
            return false
        }
    }

    private fun beginTracking() {
        val loaded = PostStore.get(this)
        if (loaded == null) {
            failStart(TrackingState.REASON_NO_DATA)
            return
        }
        posts = loaded
        if (!startLocationUpdates()) {
            failStart(startFailureReason())
            return
        }
        running = true
        handler.postDelayed(staleTimer, STALE_CHECK_MS)
        listenForScreenOn()
        TrackingState.markStarted(System.currentTimeMillis())
    }

    private fun failStart(reason: String) {
        TrackingState.reportStartFailed(reason)
        stopNow()
    }

    /** The closest reason the web app knows for "Android would not let tracking start". */
    private fun startFailureReason(): String {
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            return if (granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                TrackingState.REASON_LOCATION_IMPRECISE
            } else {
                TrackingState.REASON_LOCATION_DENIED
            }
        }
        val manager = getSystemService(Context.LOCATION_SERVICE) as? LocationManager
        if (manager != null && !LocationManagerCompat.isLocationEnabled(manager)) {
            return TrackingState.REASON_LOCATION_DISABLED
        }
        return TrackingState.REASON_UNSUPPORTED
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    // ------------------------------------------------------------- location

    /**
     * Asks for a position every second at the best accuracy: from Google Play
     * services where the phone has them, otherwise straight from the GPS
     * receiver. Returns false when neither can be started.
     */
    private fun startLocationUpdates(): Boolean {
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) return false
        if (startFusedUpdates()) return true
        return startGpsUpdates()
    }

    @SuppressLint("MissingPermission") // startLocationUpdates has just checked it.
    private fun startFusedUpdates(): Boolean {
        try {
            val available = GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(this)
            if (available != ConnectionResult.SUCCESS) return false
            val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, FIX_INTERVAL_MS)
                .setMinUpdateIntervalMillis(FIX_INTERVAL_MS)
                .build()
            val client = LocationServices.getFusedLocationProviderClient(this)
            client.requestLocationUpdates(request, fusedCallback, Looper.getMainLooper())
                .addOnFailureListener { onFusedUnavailable() }
            fusedClient = client
            return true
        } catch (e: Exception) {
            fusedClient = null
            return false
        }
    }

    /** Play services accepted the request and then could not honour it: fall back to the GPS receiver. */
    private fun onFusedUnavailable() {
        if (destroyed || gpsActive) return
        removeFusedUpdates()
        if (!startGpsUpdates()) {
            stopReason = TrackingState.REASON_UNSUPPORTED
            stopNow()
        }
    }

    @SuppressLint("MissingPermission") // Checked by startLocationUpdates; a refusal is caught below as well.
    private fun startGpsUpdates(): Boolean {
        try {
            val manager = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return false
            manager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER,
                FIX_INTERVAL_MS,
                0f,
                gpsListener,
                Looper.getMainLooper()
            )
            gpsActive = true
            return true
        } catch (e: Exception) {
            // No GPS receiver on this device, or the permission has just been withdrawn.
            return false
        }
    }

    private fun removeFusedUpdates() {
        val client = fusedClient
        fusedClient = null
        if (client != null) {
            try {
                client.removeLocationUpdates(fusedCallback)
            } catch (e: Exception) {
                // Play services has gone away; there is nothing left to remove.
            }
        }
    }

    private fun stopLocationUpdates() {
        removeFusedUpdates()
        if (gpsActive) {
            gpsActive = false
            try {
                val manager = getSystemService(Context.LOCATION_SERVICE) as? LocationManager
                manager?.removeUpdates(gpsListener)
            } catch (e: Exception) {
                // Nothing left to remove.
            }
        }
    }

    // ------------------------------------------------------------ each fix

    private fun onFix(location: Location) {
        if (!running || destroyed) return
        val lat = location.latitude
        val lng = location.longitude
        if (lat.isNaN() || lng.isNaN()) return

        // The time of a fix is the time the position was true, never the time
        // it arrived: "Updated 14:32" and the stale rule both count from it.
        // TrackingRules.fixAgeMs works out how old the fix is, and gives no
        // age for a position the phone had kept from earlier: that one says
        // where the phone was, not where it is, and is not used at all.
        val now = SystemClock.elapsedRealtime()
        val ageMs = TrackingRules.fixAgeMs(
            now - location.elapsedRealtimeNanos / 1_000_000L,
            System.currentTimeMillis() - location.time
        ) ?: return
        val fixAt = now - ageMs
        // Never let an older position replace a newer one.
        if (fixAt < lastFixAt) return

        // A position too rough to tell one post from the next is not a
        // position (without satellites the phone can still answer from Wi-Fi
        // and phone masts). It is ignored altogether, so the last good fix
        // goes stale in the usual way and the surfaces say "No GPS since 14:32".
        val accuracy: Double? = if (location.hasAccuracy()) location.accuracy.toDouble() else null
        if (!TrackingRules.accuracyIsUsable(accuracy)) return

        // 1. Direction of travel and speed, or "none". Only what the position
        //    itself reports: never the compass, which says where the phone points.
        //    A direction with no valid speed beside it is not trusted either.
        val speed: Double? = if (location.hasSpeed()) usableSpeed(location.speed) else null
        val heading: Double? = if (speed != null && location.hasBearing()) usableBearing(location.bearing) else null

        // The web app forgets the last confirmed carriageway when "prefer my
        // direction of travel" is switched off. Do the same.
        val useHeading = TrackingState.useHeading
        if (headingWasPreferred && !useHeading) carriageway.reset()
        headingWasPreferred = useHeading

        // 2 to 4. The nearest post, whether its carriageway is known or only
        //    guessed from position, and the snapshot (Snapshot.forFix; a long
        //    way from every recorded post the snapshot says so). The time on it
        //    is the fix's own, read against this phone's clock: that is the
        //    clock "14:32" is compared with.
        val snapshot = Snapshot.forFix(
            posts, lat, lng, heading, speed, useHeading, System.currentTimeMillis() - ageMs, carriageway
        ) ?: return
        lastFixAt = fixAt
        lastSpeed = speed
        current = snapshot

        // 5. Show it when something visible changed, but not more than once a
        //    second. Otherwise every 30 seconds, so the "updated" time stays honest
        //    while the post is unchanged.
        val previous = shown
        val sinceShown = now - shownAt
        val due: Boolean
        if (previous == null) {
            due = true
        } else if (!snapshot.showsSameAs(previous)) {
            due = sinceShown >= changeInterval(snapshot, previous)
        } else {
            due = sinceShown >= HEARTBEAT_MS
        }
        if (due) show(snapshot)
    }

    /**
     * How soon after the last redraw a change may be shown: a second. The
     * one exception is how far away a far post is said to be. Away from the
     * recorded roads that figure changes with every fix, and redrawing the
     * notification and the widget every second for it would wear the battery
     * for nothing, so it is redrawn every five seconds (the same pace as the
     * web app and the iPhone).
     */
    private fun changeInterval(newest: Snapshot, previous: Snapshot): Long =
        if (newest.differsOnlyInFarDistance(previous)) FAR_DISTANCE_INTERVAL_MS else MIN_SHOW_INTERVAL_MS

    /** A bearing is a heading only when it is a real direction. 0.0 is one (due north). */
    private fun usableBearing(bearing: Float): Double? =
        if (bearing.isNaN() || bearing < 0f || bearing > 360f) null else bearing.toDouble()

    private fun usableSpeed(speed: Float): Double? =
        if (speed.isNaN() || speed.isInfinite() || speed < 0f) null else speed.toDouble()

    /**
     * Runs every five seconds, and whenever the screen comes on.
     *
     * A post that is no longer being updated must not look current. When the
     * last fix is too old (15 s when it was moving, 30 s when it gave no
     * speed, 120 s when stationary) the snapshot is shown again as stale: "No
     * GPS since 14:32".
     */
    private fun checkStale() {
        if (!running) return
        val latest = current ?: return
        val now = SystemClock.elapsedRealtime()
        if (!latest.stale && TrackingRules.isStale(now - lastFixAt, lastSpeed)) {
            val lastKnown = latest.copy(stale = true)
            current = lastKnown
            show(lastKnown)
            return
        }
        val previous = shown ?: return
        val sinceShown = now - shownAt
        // A change that came too soon after the last redraw was held back. If
        // no later fix has carried it through, show it now.
        val heldBack = !latest.showsSameAs(previous) && sinceShown >= changeInterval(latest, previous)
        // The same goes for a time that no longer reads as it was written:
        // left overnight, "No GPS since 23:58" must gain its date at midnight.
        val clockMoved = sinceShown >= MIN_SHOW_INTERVAL_MS && SurfaceText.clock(previous.fixTime) != shownClock
        if (heldBack || clockMoved) show(latest)
    }

    // ------------------------------------------------------------- showing

    /** Puts a snapshot on every surface: the shared store, the notification and the widget. */
    private fun show(snapshot: Snapshot) {
        shown = snapshot
        shownAt = SystemClock.elapsedRealtime()
        shownClock = SurfaceText.clock(snapshot.fixTime)
        SnapshotStore.write(this, snapshot)
        postNotification(snapshot)
        MarkerPostWidgetProvider.update(this)
    }

    private fun postNotification(snapshot: Snapshot) {
        try {
            val manager = getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
            manager.notify(TrackingNotification.NOTIFICATION_ID, TrackingNotification.build(this, snapshot))
        } catch (e: Exception) {
            // Notifications are switched off for the app. Tracking still runs
            // and the widget still updates.
        }
    }

    /**
     * With the screen off and no GPS, the phone may sleep and the five-second
     * timer sleeps with it. Checking the moment the screen comes on means the
     * lock screen never shows an old post as current while the timer catches up.
     */
    private fun listenForScreenOn() {
        try {
            ContextCompat.registerReceiver(
                this,
                screenOnReceiver,
                IntentFilter(Intent.ACTION_SCREEN_ON),
                ContextCompat.RECEIVER_NOT_EXPORTED
            )
            screenReceiverRegistered = true
        } catch (e: Exception) {
            // The timer still does the job, a few seconds later.
        }
    }

    companion object {
        const val ACTION_START = "io.github.jet11111.markerpost.nativecore.action.START"

        /** "Stop" on the notification, or the app's own stop button. */
        const val ACTION_STOP = "io.github.jet11111.markerpost.nativecore.action.STOP"

        /** The notification was swiped away. */
        const val ACTION_DISMISSED = "io.github.jet11111.markerpost.nativecore.action.DISMISSED"

        private const val FIX_INTERVAL_MS = 1_000L
        private const val STALE_CHECK_MS = 5_000L
        private const val MIN_SHOW_INTERVAL_MS = 1_000L
        private const val FAR_DISTANCE_INTERVAL_MS = 5_000L
        private const val HEARTBEAT_MS = 30_000L

        /**
         * Starts tracking. Only call while the app is on screen: Android throws
         * otherwise, and the caller reports that to the web app.
         */
        fun start(context: Context) {
            val intent = Intent(context, TrackingService::class.java).setAction(ACTION_START)
            ContextCompat.startForegroundService(context, intent)
        }

        /**
         * Asks a running service to stop. Sent as a command, not as
         * stopService(): commands arrive in order, so a stop that follows a
         * start closely is handled after the service has shown its
         * notification, which Android insists on.
         */
        fun requestStop(context: Context) {
            val intent = Intent(context, TrackingService::class.java).setAction(ACTION_STOP)
            try {
                context.startService(intent)
            } catch (e: Exception) {
                // Android would not deliver the command (the app is in the
                // background with nothing running). Make sure nothing is left running.
                try {
                    context.stopService(Intent(context, TrackingService::class.java))
                } catch (ignored: Exception) {
                    // Nothing to stop.
                }
            }
        }
    }
}
