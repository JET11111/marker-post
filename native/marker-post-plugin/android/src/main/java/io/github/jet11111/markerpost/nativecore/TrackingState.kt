package io.github.jet11111.markerpost.nativecore

import java.util.concurrent.CopyOnWriteArrayList

/**
 * The little that the tracking service and the plugin need to share. They
 * run in the same process, so a plain object is enough: no binding, no
 * broadcasts. The service is the only writer of "active"; the plugin reads it
 * and listens for changes so the web app can be told.
 *
 * It holds no reference to the service or to the app's screen, so it cannot
 * keep either alive. When the process ends, this ends with it, which is the
 * truth: nothing is tracking any more.
 */
object TrackingState {

    // The reasons the web app understands (docs/native-apps.md, section 1).
    const val REASON_LOCATION_DENIED = "location-denied"
    const val REASON_LOCATION_DISABLED = "location-disabled"
    const val REASON_LOCATION_IMPRECISE = "location-imprecise"
    const val REASON_NOTIFICATIONS_DENIED = "notifications-denied"
    const val REASON_NO_DATA = "no-data"
    const val REASON_UNSUPPORTED = "unsupported"
    const val REASON_STOPPED_BY_USER = "stopped-by-user"

    interface Listener {
        /** Tracking started or stopped. [reason] says why it stopped, when that is known. */
        fun onTrackingChanged(active: Boolean, reason: String?)

        /** A start was asked for and could not happen. Tracking was not running and still is not. */
        fun onStartFailed(reason: String)
    }

    /** True while the tracking service is running in the foreground. */
    @Volatile
    var active: Boolean = false
        private set

    /** When tracking started (milliseconds since 1970). 0 when not tracking. */
    @Volatile
    var since: Long = 0L
        private set

    /** Why tracking last stopped or failed to start. Null when it is running or has never stopped. */
    @Volatile
    var lastReason: String? = null
        private set

    /** The app's "choose the carriageway by direction of travel" preference. Read on every fix. */
    @Volatile
    var useHeading: Boolean = true

    private val listeners = CopyOnWriteArrayList<Listener>()

    fun addListener(listener: Listener) {
        listeners.addIfAbsent(listener)
    }

    fun removeListener(listener: Listener) {
        listeners.remove(listener)
    }

    /** Called by the service once it is in the foreground and has asked for positions. */
    fun markStarted(startedAt: Long) {
        since = startedAt
        lastReason = null
        active = true
        for (listener in listeners) listener.onTrackingChanged(true, null)
    }

    /** Called by the service when it stops, for any reason. */
    fun markStopped(reason: String?) {
        active = false
        since = 0L
        lastReason = reason
        for (listener in listeners) listener.onTrackingChanged(false, reason)
    }

    /** Called by the service when it was started but could not begin tracking. */
    fun reportStartFailed(reason: String) {
        lastReason = reason
        for (listener in listeners) listener.onStartFailed(reason)
    }
}
