package io.github.jet11111.markerpost.nativecore

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.WindowManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/*
 * The Android side of the "MarkerPost" plugin the web app talks to through
 * platform.js. The contract (methods, results, reasons) is in
 * docs/native-apps.md, section 1, and is the same on the iPhone.
 *
 * The web view only starts and stops live tracking and hands over the post
 * it is showing. The tracking itself lives in TrackingService, which carries
 * on when the web view is asleep.
 *
 * Capacitor finds this plugin by reading the source text below, from the
 * annotation to the first declaration after it. Keep the annotation at the
 * start of its line, and keep comments out from between it and the
 * declaration.
 */
@CapacitorPlugin(
    name = "MarkerPost",
    permissions = [
        Permission(
            alias = MarkerPostPlugin.LOCATION,
            strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION]
        ),
        Permission(
            alias = MarkerPostPlugin.NOTIFICATIONS,
            strings = [Manifest.permission.POST_NOTIFICATIONS]
        )
    ]
)
class MarkerPostPlugin : Plugin() {

    private val mainHandler = Handler(Looper.getMainLooper())

    /** startTracking calls waiting to hear from the service whether it really started. */
    private val pendingLock = Any()
    private val pendingStarts = ArrayList<PluginCall>()

    /**
     * True from the moment the service is told to stop until it has stopped.
     * In that short time "active" is still true but is about to be false, so
     * a start request must not be answered with "already running".
     */
    @Volatile
    private var stopRequested = false

    private val stateListener = object : TrackingState.Listener {
        override fun onTrackingChanged(active: Boolean, reason: String?) {
            stopRequested = false
            // A waiting start is answered by a start (here) or by a failure to
            // start (below). A stop is never its answer: a stop seen while a
            // start is waiting is the previous session ending, and the new
            // one reports for itself a moment later.
            if (active) settleStarts(startedResult())
            emitTrackingChanged(active, reason)
        }

        override fun onStartFailed(reason: String) {
            stopRequested = false
            settleStarts(stoppedResult(reason))
        }
    }

    private val startTimeout = Runnable { onStartTimedOut() }

    override fun load() {
        super.load()
        // Nothing here may throw: a plugin that fails to load is missing from the app altogether.
        try {
            applyWebViewBackground()
            TrackingState.addListener(stateListener)
            // If the app was removed from memory while tracking, the stored
            // snapshot still says "tracking". Reading it corrects that, and the
            // widget is redrawn to match. Posted, so it does not hold up the launch.
            val appContext = context.applicationContext
            mainHandler.post { MarkerPostWidgetProvider.update(appContext) }
        } catch (e: Exception) {
            // The plugin still works without any of the above.
        }
    }

    override fun handleOnConfigurationChanged(newConfig: Configuration) {
        super.handleOnConfigurationChanged(newConfig)
        // The phone switched between day and night while the app was open.
        applyWebViewBackground()
    }

    override fun handleOnDestroy() {
        // The screen is going away; the tracking service, if running, carries on.
        TrackingState.removeListener(stateListener)
        mainHandler.removeCallbacksAndMessages(null)
        synchronized(pendingLock) { pendingStarts.clear() }
        super.handleOnDestroy()
    }

    /**
     * Paints the web view itself in the page's background colour (light by
     * day, black at night), so nothing flashes white while the page loads.
     */
    private fun applyWebViewBackground() {
        try {
            val webView = bridge.webView ?: return
            webView.setBackgroundColor(ContextCompat.getColor(context, R.color.markerpost_webview_background))
        } catch (e: Exception) {
            // Only the colour behind the page while it loads.
        }
    }

    // ------------------------------------------------------- plugin methods

    /**
     * { useHeading } -> { active: true, since } or { active: false, reason }.
     * Asks for any permission it needs, once, and resolves with a reason
     * when the answer is no. It never rejects.
     */
    @PluginMethod
    fun startTracking(call: PluginCall) {
        // The app's own default for "prefer my direction of travel" is on.
        TrackingState.useHeading = call.getBoolean("useHeading", true) ?: true
        if (runningAndStaying()) {
            call.resolve(startedResult())
            return
        }
        checkLocation(call, false)
    }

    /** -> { active: false }. The trackingChanged event follows once the service has stopped. */
    @PluginMethod
    fun stopTracking(call: PluginCall) {
        val starting = synchronized(pendingLock) { pendingStarts.isNotEmpty() }
        if (TrackingState.active || starting) {
            stopRequested = true
            TrackingService.requestStop(context.applicationContext)
        }
        call.resolve(stoppedResult(null))
    }

    /** -> { active, since?, reason? } */
    @PluginMethod
    fun getTrackingStatus(call: PluginCall) {
        if (TrackingState.active) {
            call.resolve(startedResult())
        } else {
            call.resolve(stoppedResult(TrackingState.lastReason))
        }
    }

    /** { useHeading } -> {}. A running tracker uses the new preference from its next fix. */
    @PluginMethod
    fun updateTracking(call: PluginCall) {
        val useHeading = call.getBoolean("useHeading")
        if (useHeading != null) TrackingState.useHeading = useHeading
        call.resolve(JSObject())
    }

    /**
     * A snapshot without stale/tracking -> {}. The post the web app is
     * showing, so the widget has a "last known" value even if live tracking
     * was never started. Ignored while tracking is active: the native tracker
     * is then the only source, so two writers can never disagree.
     */
    @PluginMethod
    fun publishPost(call: PluginCall) {
        val snapshot = snapshotFrom(call)
        if (snapshot != null) {
            val appContext = context.applicationContext
            // On the main thread, where the tracking service does all its own
            // writing, so the two can never overlap.
            mainHandler.post {
                if (!TrackingState.active) {
                    SnapshotStore.write(appContext, snapshot)
                    MarkerPostWidgetProvider.update(appContext)
                }
            }
        }
        call.resolve(JSObject())
    }

    /** { on } -> {}. Keeps the screen on while the app is open. */
    @PluginMethod
    fun setKeepAwake(call: PluginCall) {
        // Called with nothing, it means "keep awake" (the same default as on the iPhone).
        val on = call.getBoolean("on", true) ?: true
        val screen = activity
        if (screen == null) {
            call.resolve(JSObject())
            return
        }
        // Window flags may only be changed on the main thread.
        screen.runOnUiThread {
            try {
                if (on) {
                    screen.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    screen.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            } catch (e: Exception) {
                // The screen is closing; there is no window left to change.
            }
            call.resolve(JSObject())
        }
    }

    // ------------------------------------------------ starting, step by step

    /** Location services on, then precise location granted. Asks once. */
    private fun checkLocation(call: PluginCall, alreadyAsked: Boolean) {
        if (!locationServicesOn()) {
            call.resolve(stoppedResult(TrackingState.REASON_LOCATION_DISABLED))
            return
        }
        if (!alreadyAsked && getPermissionState(LOCATION) != PermissionState.GRANTED) {
            requestPermissionForAlias(LOCATION, call, "locationPermissionResult")
            return
        }
        if (!granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
            // "Approximate" was chosen: about 3 square km, which cannot pick a marker post.
            val reason = if (granted(Manifest.permission.ACCESS_COARSE_LOCATION)) {
                TrackingState.REASON_LOCATION_IMPRECISE
            } else {
                TrackingState.REASON_LOCATION_DENIED
            }
            call.resolve(stoppedResult(reason))
            return
        }
        checkNotifications(call, false)
    }

    @PermissionCallback
    private fun locationPermissionResult(call: PluginCall?) {
        if (call == null) return
        checkLocation(call, true)
    }

    /**
     * Android 13 and later ask before an app may show notifications. Tracking
     * works without the answer being yes (the service still runs and the
     * widget still updates), so a refusal does not stop it: the result then
     * carries the reason "notifications-denied" alongside active: true.
     */
    private fun checkNotifications(call: PluginCall, alreadyAsked: Boolean) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !alreadyAsked &&
            getPermissionState(NOTIFICATIONS) != PermissionState.GRANTED
        ) {
            requestPermissionForAlias(NOTIFICATIONS, call, "notificationPermissionResult")
            return
        }
        // A permission answer arrives on the main thread, and reading the post
        // file takes a moment the first time: do the rest on the plugin's own thread.
        execute { launch(call) }
    }

    @PermissionCallback
    private fun notificationPermissionResult(call: PluginCall?) {
        if (call == null) return
        checkNotifications(call, true)
    }

    /** The post data must load; then the service is started and the call waits for its verdict. */
    private fun launch(call: PluginCall) {
        val appContext = context.applicationContext
        if (PostStore.get(appContext) == null) {
            call.resolve(stoppedResult(TrackingState.REASON_NO_DATA))
            return
        }
        if (runningAndStaying()) {
            call.resolve(startedResult())
            return
        }
        synchronized(pendingLock) { pendingStarts.add(call) }
        try {
            TrackingService.start(appContext)
        } catch (e: Exception) {
            // Android only lets tracking begin while the app is on screen.
            settleStarts(stoppedResult(TrackingState.REASON_UNSUPPORTED))
            return
        }
        mainHandler.removeCallbacks(startTimeout)
        mainHandler.postDelayed(startTimeout, START_TIMEOUT_MS)
    }

    /** Resolves every waiting startTracking call with the service's verdict. */
    private fun settleStarts(result: JSObject) {
        val waiting: List<PluginCall> = synchronized(pendingLock) {
            val copy = ArrayList(pendingStarts)
            pendingStarts.clear()
            copy
        }
        if (waiting.isEmpty()) return
        mainHandler.removeCallbacks(startTimeout)
        for (call in waiting) call.resolve(result)
    }

    /** The service never reported back. Do not leave the app waiting, and leave nothing half started. */
    private fun onStartTimedOut() {
        val waiting = synchronized(pendingLock) { pendingStarts.isNotEmpty() }
        if (!waiting) return
        if (runningAndStaying()) {
            settleStarts(startedResult())
            return
        }
        stopRequested = true
        TrackingService.requestStop(context.applicationContext)
        settleStarts(stoppedResult(TrackingState.REASON_UNSUPPORTED))
    }

    /** Tracking is running and nobody has asked it to stop. */
    private fun runningAndStaying(): Boolean = TrackingState.active && !stopRequested

    // -------------------------------------------------------------- helpers

    private fun startedResult(): JSObject {
        val result = JSObject()
        result.put("active", true)
        result.put("since", TrackingState.since)
        if (!notificationsOn()) result.put("reason", TrackingState.REASON_NOTIFICATIONS_DENIED)
        return result
    }

    private fun stoppedResult(reason: String?): JSObject {
        val result = JSObject()
        result.put("active", false)
        if (reason != null) result.put("reason", reason)
        return result
    }

    /** The trackingChanged event: tracking started or stopped, for any reason. */
    private fun emitTrackingChanged(active: Boolean, reason: String?) {
        val event = JSObject()
        event.put("active", active)
        if (reason != null) event.put("reason", reason)
        notifyListeners("trackingChanged", event)
    }

    /**
     * The post handed over by the web app, or null when it cannot be trusted:
     * no recorded reference, or no time for its position. It is dropped, not
     * patched up: the widget must never show a time that was made up here.
     * (The same rule as the iPhone plugin.)
     */
    private fun snapshotFrom(call: PluginCall): Snapshot? {
        val ref = call.getString("ref") ?: ""
        if (ref.isEmpty()) return null

        // A JavaScript number arrives as an Integer, a Long or a Double.
        val fixTime = (call.data.opt("fixTime") as? Number)?.toDouble() ?: return null
        if (fixTime.isNaN() || fixTime.isInfinite() || fixTime <= 0.0) return null

        return Snapshot(
            call.getString("road") ?: "",
            // "O" is the neutral badge: the class only chooses a colour.
            call.getString("roadClass") ?: "O",
            call.getString("km") ?: "",
            call.getString("letter") ?: "",
            ref,
            call.getString("context") ?: "",
            // Not stated means not confirmed: by position only.
            call.getBoolean("confirmed", false) ?: false,
            fixTime.toLong(),
            false,
            false
        )
    }

    private fun granted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

    private fun locationServicesOn(): Boolean {
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return false
        return LocationManagerCompat.isLocationEnabled(manager)
    }

    private fun notificationsOn(): Boolean {
        return try {
            NotificationManagerCompat.from(context).areNotificationsEnabled()
        } catch (e: Exception) {
            false
        }
    }

    companion object {
        const val LOCATION = "location"
        const val NOTIFICATIONS = "notifications"

        /** Long enough for a busy phone to start a service; short enough not to leave the button waiting. */
        private const val START_TIMEOUT_MS = 10_000L
    }
}
