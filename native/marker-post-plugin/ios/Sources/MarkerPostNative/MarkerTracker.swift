import CoreLocation
import Foundation
import MarkerPostCore
import UIKit
import WidgetKit

// Live tracking on iPhone: background location, the nearest-post lookup, and
// the surfaces that show the result (Live Activity, shared store, widgets).
// The behaviour is specified in docs/native-apps.md, sections 4 and 5.
//
// The web view is suspended while the phone is locked, so none of this can be
// done in JavaScript. The plugin only starts and stops the tracker.

/// What the plugin reports to JavaScript about live tracking.
struct TrackingStatus: Sendable {
    let active: Bool
    /// When the running session started. Nil when not tracking.
    let since: Date?
    /// One of the reason words in docs/native-apps.md section 1, or nil.
    let reason: String?
}

/// How a request to put the Live Activity back on screen ended. The "Show
/// nearest marker post" shortcut says which, so that it never reports success
/// for something that did not happen.
public enum DisplayRestart: Sendable {
    /// A fresh Live Activity is on screen.
    case shown
    /// Live tracking is not running, so nothing was done. The shortcut never
    /// switches tracking on.
    case trackingOff
    /// iOS would not start a fresh Live Activity, but the one that was on
    /// screen is still there, and the tracker goes on updating it. Nothing
    /// was lost by asking, so the answer must not send the driver to the
    /// phone. (Siri is reported to refuse a new one while another from the
    /// app is showing, so this may be the usual answer to the spoken shortcut.)
    case stillShowing
    /// iOS would not start a Live Activity, and none is on screen. Opening
    /// the app is the way to get one back.
    case refused
}

/// Why no usable position is arriving. Shown on the Live Activity instead of
/// leaving the last post on screen as if all were well.
private enum TrackingProblem: Equatable {
    case servicesOff
    case permissionDenied
    case imprecise
    case needsForeground
    case noSignal

    var text: String {
        switch self {
        case .servicesOff: return "Location Services are off"
        case .permissionDenied: return "Location permission needed"
        case .imprecise: return "Precise Location is off"
        case .needsForeground: return "Open Marker Post to resume"
        case .noSignal: return "No GPS signal"
        }
    }

    /// The contract's word for the problem, where it has one.
    var reason: String? {
        switch self {
        case .servicesOff: return "location-disabled"
        case .permissionDenied: return "location-denied"
        case .imprecise: return "location-imprecise"
        case .needsForeground, .noSignal: return nil
        }
    }
}

/// Runs the nearest-post scan away from the main thread, and remembers the
/// last heading-confirmed carriageway between fixes.
///
/// An actor does its work on a background thread. That matters here: this is a
/// hybrid app, and work on the main thread while in the background has been
/// seen to delay the delivery of location updates.
private actor PostLookup {
    private let store: PostStore
    private var confirmation = CarriagewayConfirmation()

    init(store: PostStore) {
        self.store = store
    }

    /// Steps 2 to 4 of "on every fix": find the post, decide whether the
    /// carriageway is confirmed, build the snapshot. The rules are the
    /// store's own (`PostStore.liveSnapshot`), including the one for a
    /// position that is a long way from every recorded post.
    func snapshot(lat: Double, lng: Double, heading: Double?, speed: Double?,
                  useHeading: Bool, fixTime: Date) -> PostSnapshot? {
        return store.liveSnapshot(lat: lat, lng: lng, heading: heading, speed: speed,
                                  useHeading: useHeading, fixTime: fixTime, confirmation: &confirmation)
    }

    /// The web app forgets the last confirmation when "prefer my direction of
    /// travel" is switched off. Do the same.
    func forgetConfirmation() {
        confirmation.reset()
    }
}

/// "Live tracking is on", kept across launches.
///
/// iOS can close the app in the background and start it again without anyone
/// touching it. The tracker then has to carry on by itself, so it must know
/// that a session was running and with which setting.
private enum SavedSession {
    private static let sinceKey = "markerpost.tracking.since"
    private static let headingKey = "markerpost.tracking.useHeading"

    static func save(since: Date, useHeading: Bool) {
        let defaults = UserDefaults.standard
        defaults.set(since.timeIntervalSince1970, forKey: sinceKey)
        defaults.set(useHeading, forKey: headingKey)
    }

    static func load() -> (since: Date, useHeading: Bool)? {
        let defaults = UserDefaults.standard
        guard let seconds = defaults.object(forKey: sinceKey) as? Double else { return nil }
        let useHeading = (defaults.object(forKey: headingKey) as? Bool) ?? true
        return (Date(timeIntervalSince1970: seconds), useHeading)
    }

    static func clear() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: sinceKey)
        defaults.removeObject(forKey: headingKey)
    }
}

/// Asks for location permission and reports the answer.
///
/// Only "While Using the App" is ever requested. That is enough to keep
/// receiving positions in the background while a background activity session
/// is held, and it means the app can never track when tracking is switched off.
@MainActor
private final class LocationPermission: NSObject, CLLocationManagerDelegate {
    /// How long to wait for an answer to the system's question before giving
    /// up, so the Start button in the app cannot stay disabled for ever.
    private static let patienceSeconds: UInt64 = 120

    private let manager = CLLocationManager()
    private var waiting: [CheckedContinuation<CLAuthorizationStatus, Never>] = []
    private var requestNumber = 0

    /// True when the user allowed precise positions. Approximate location is
    /// accurate to a few kilometres, which cannot place a marker post.
    var isPrecise: Bool {
        return manager.accuracyAuthorization == .fullAccuracy
    }

    /// The current permission, asking the user first if they have never been asked.
    func whenInUse() async -> CLAuthorizationStatus {
        let current = manager.authorizationStatus
        guard current == .notDetermined else { return current }

        manager.delegate = self
        requestNumber += 1
        let number = requestNumber
        return await withCheckedContinuation { (continuation: CheckedContinuation<CLAuthorizationStatus, Never>) in
            waiting.append(continuation)
            manager.requestWhenInUseAuthorization()
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: LocationPermission.patienceSeconds * 1_000_000_000)
                guard let self = self, self.requestNumber == number else { return }
                self.answer(evenIfUndecided: true)
            }
        }
    }

    // Core Location calls this on the main thread when the user answers (and
    // once when the delegate is set, with the answer still undecided).
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        Task { @MainActor [weak self] in
            self?.answer(evenIfUndecided: false)
        }
    }

    private func answer(evenIfUndecided: Bool) {
        let status = manager.authorizationStatus
        guard evenIfUndecided || status != .notDetermined else { return }
        let continuations = waiting
        waiting.removeAll()
        for continuation in continuations {
            continuation.resume(returning: status)
        }
    }
}

/// The one live-tracking session of the app.
///
/// Everything here runs on the main thread except the nearest-post scan, which
/// `PostLookup` does in the background.
@MainActor
public final class MarkerTracker {
    /// The plugin, the app delegate and the App Intent all use this instance.
    public static let shared = MarkerTracker()

    // MARK: Hooks for the plugin

    /// Called whenever tracking starts or stops while the app is running,
    /// for any reason. Not called at launch, when a session is carried on or
    /// is ended there and then (`resumeAfterLaunch`): the web view does not
    /// exist yet, and it asks for the status when it starts.
    var onTrackingChanged: ((_ active: Bool, _ reason: String?) -> Void)?
    /// Called with the post found for each fix, but only while the app is on
    /// screen: a web view in the background must not be given work to do.
    var onFix: ((_ snapshot: PostSnapshot) -> Void)?

    // MARK: Timings (docs/native-apps.md, sections 4 and 5)

    /// A session older than this is over. Without a limit, a flag left behind
    /// by a forgotten session could switch location back on days later.
    private static let sessionLimit: TimeInterval = 14 * 60 * 60
    /// How often the stale check and the housekeeping run.
    private static let tickSeconds: UInt64 = 5
    /// Widgets are asked to redraw at most this often. iOS rations the requests.
    private static let widgetReloadInterval: TimeInterval = 15
    /// After the app's own attempt to renew the Live Activity is refused, wait
    /// before trying again (see `runRenewal`).
    private static let renewRetryInterval: TimeInterval = 60
    /// If the stream of positions ends while tracking is on, start it again after this.
    private static let streamRetrySeconds: UInt64 = 3
    // How often the surfaces are sent anything is in `ShowRule`, with the
    // other rules that can be tested without a phone.

    // MARK: Session

    private var isActive = false
    /// The start that is under way, if any. It can take a long time: it may
    /// be waiting for the user to answer the permission question.
    private var startTask: Task<TrackingStatus, Never>?
    private var since: Date?
    private var useHeading = true
    private var lastStopReason: String?
    /// Goes up on every start and stop, so work left over from an earlier
    /// session can tell that it is out of date.
    private var sessionToken = 0

    // MARK: Location

    private lazy var permission = LocationPermission()
    /// Lets an app with "While Using" permission keep receiving positions in
    /// the background. It must be kept in a property: letting it go ends it.
    private var backgroundSession: CLBackgroundActivitySession?
    /// States the permission this session relies on.
    private var serviceSession: CLServiceSession?
    /// True when the two sessions above were made at a launch that may have
    /// been in the background. iOS lets a background launch rejoin a session
    /// that is still running but not begin a new one, so they are made again
    /// the next time the app is on screen, where it always counts.
    private var sessionsNeedRefresh = false
    private var updatesTask: Task<Void, Never>?
    private var tickTask: Task<Void, Never>?

    // MARK: Lookup

    private var store: PostStore?
    private var lookup: PostLookup?
    /// After the app was started again mid-session: the reading of the post
    /// list that `lookup` is waiting for. Nil at any other time.
    private var resumeTask: Task<Void, Never>?

    // MARK: What is known, and what is on screen

    /// The post from the newest usable fix, with `stale` kept up to date.
    private var latest: PostSnapshot?
    private var problem: TrackingProblem?
    /// When iOS said that the phone had stopped moving and that it was pausing
    /// its updates. Nil while it has not said so. A pause does not by itself
    /// excuse an old position: see `pauseExplainsSilence`.
    private var stationarySince: Date?
    /// Speed of the newest usable fix in metres per second. Nil when it had none.
    private var lastSpeed: Double?

    /// What the surfaces were last told to show, and when. `paused` in it is
    /// true when iOS has paused its updates and that accounts for the post
    /// not being refreshed (see `pauseExplainsSilence`); the Live Activity is
    /// then given much longer before iOS marks it out of date by itself.
    private var shown = ShowRule.Display.waiting
    private var shownAt = Date.distantPast

    private let liveActivity: LiveActivityController
    /// The renewal of the Live Activity that is under way, if any. Only one
    /// runs at a time.
    private var renewal: Task<Bool, Never>?
    private var nextRenewAttempt = Date.distantPast

    private var lastWidgetReload = Date.distantPast
    private var widgetReloadQueued = false

    private var activeObserver: NSObjectProtocol?

    private init() {
        liveActivity = LiveActivityController()
        // Coming to the front is the one moment an app may start a Live
        // Activity, so it is when an ageing one is renewed.
        activeObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.tick()
            }
        }
    }

    // MARK: - Used by the app delegate and the App Intent

    /// Call from the app delegate on every launch.
    ///
    /// If the system closed the app during a session and has now started it
    /// again (possibly in the background, with no one looking), carry on: the
    /// background session can be rejoined at launch, but not created afresh
    /// later. A session older than 14 hours is treated as over.
    ///
    /// With no session to carry on, any Live Activity still on the phone was
    /// left behind by one that died: the app was closed mid-shift and not
    /// opened again in time, or it was suspended before a stop had finished
    /// removing them. Nothing would ever update it, so it is removed here,
    /// together with a follow-on that is still waiting to start.
    ///
    /// A session is not carried on either if its Live Activity was taken off
    /// the screen while the app was not running. That is the user saying
    /// stop, exactly as it is while the app is running, so location is not
    /// switched back on. (iOS may start the app in the background at the very
    /// moment the Live Activity is removed, which is one way to get here.)
    public func resumeAfterLaunch() {
        guard !isActive, startTask == nil else { return }
        guard let saved = SavedSession.load() else {
            liveActivity.endAll(finalSnapshot: nil)
            return
        }
        let now = Date()
        let age = now.timeIntervalSince(saved.since)
        // A start time in the future means the clock was changed: not trustworthy either.
        guard age >= 0, age < MarkerTracker.sessionLimit else {
            abandonSavedSession(reason: nil)
            return
        }
        // Asked before anything is switched on. Whatever is still on screen
        // is taken over by the same call.
        guard liveActivity.adoptExisting(now: now) else {
            // Gone because Live Activities were switched off in Settings, or
            // because it was swiped away (or the phone was restarted).
            abandonSavedSession(reason: liveActivity.isEnabled ? "stopped-by-user" : "activities-disabled")
            return
        }

        sessionToken += 1
        let token = sessionToken
        isActive = true
        since = saved.since
        useHeading = saved.useHeading
        lastStopReason = nil
        resetFixState()
        attachSessions()
        sessionsNeedRefresh = true
        // The post list is read in the background. Positions are asked for
        // at once all the same, as they must be at a launch; the first one
        // waits for the list (see `readyLookup`).
        resumeTask = Task { [weak self] in
            guard let self = self else { return }
            await self.finishResume(token: token)
        }
        startUpdates()
        startTicking()
    }

    /// Put the Live Activity back on screen, but only if live tracking is
    /// already running. It never starts tracking and never starts location.
    ///
    /// This is what the "Show nearest marker post" shortcut runs. iOS ends a
    /// Live Activity after eight hours and a background app may not start
    /// another; an App Intent run by the system may.
    ///
    /// - Returns: what happened, for the shortcut to say.
    public func restartLiveActivityIfTracking() async -> DisplayRestart {
        guard isActive else { return .trackingOff }
        // The app may be renewing the display itself at this very moment. If
        // that works, the display is back and there is nothing left to do.
        // (A renewal takes itself out of `renewal` before it finishes, so
        // this cannot wait twice on the same one.)
        while let running = renewal {
            if await running.value { return .shown }
        }
        guard isActive else { return .trackingOff }
        let renewed = await beginRenewal(replaceNearlyOver: true).value
        // Tracking may have been stopped while iOS was being asked.
        guard isActive else { return .trackingOff }
        if renewed { return .shown }
        // Refused. If the display that was there is still there, nothing was
        // lost, and the driver must not be sent to the phone for it. Only
        // with nothing on screen is opening the app the thing to do.
        return liveActivity.isDisplayShowing(now: Date()) ? .stillShowing : .refused
    }

    // MARK: - Used by the plugin

    /// Start live tracking. Must be called while the app is on screen. Asks
    /// for location permission once if it has never been asked.
    func start(useHeading wanted: Bool) async -> TrackingStatus {
        if isActive {
            setUseHeading(wanted)
            return status()
        }
        // The button in the app is disabled while a start is in progress, but
        // a second call can arrive anyway. It waits for the first one's
        // answer: a refusal of its own would have the app say that tracking
        // could not start while the first call is still at work.
        if let running = startTask {
            let answer = await running.value
            guard isActive else { return answer }
            setUseHeading(wanted)
            return status()
        }
        let task = Task<TrackingStatus, Never> { [weak self] in
            return await self?.runStart(useHeading: wanted)
                ?? TrackingStatus(active: false, since: nil, reason: nil)
        }
        startTask = task
        return await task.value
    }

    /// The start itself. Only `start` calls it, and only one at a time.
    private func runStart(useHeading wanted: Bool) async -> TrackingStatus {
        // Taken away before the task that runs this finishes, so that a later
        // call never waits on a start that is over.
        defer { startTask = nil }

        // Without a Live Activity there would be nothing to see, so location
        // must not run either.
        guard liveActivity.isSupported else { return refused("unsupported") }
        guard liveActivity.isEnabled else { return refused("activities-disabled") }
        guard let posts = await loadStore() else { return refused("no-data") }
        guard await MarkerTracker.locationServicesEnabled() else { return refused("location-disabled") }

        switch await permission.whenInUse() {
        case .authorizedWhenInUse, .authorizedAlways:
            break
        case .notDetermined, .denied, .restricted:
            return refused("location-denied")
        @unknown default:
            return refused("location-denied")
        }
        guard permission.isPrecise else { return refused("location-imprecise") }
        guard !isActive else { return status() }

        let startedAt = Date()
        switch await liveActivity.startChain(now: startedAt) {
        case .started:
            break
        case .disabled:
            return refused("activities-disabled")
        case .failed:
            // iOS would not start the Live Activity, for a cause that none
            // of the reason words fits. It is usually a passing one: the app
            // was not on screen yet, or the phone already has as many Live
            // Activities as it allows. So no reason is given, and the app
            // says only that live tracking could not start. "unsupported"
            // would have it say that this phone can never do it.
            return refused(nil)
        }

        sessionToken += 1
        isActive = true
        since = startedAt
        useHeading = wanted
        lastStopReason = nil
        resetFixState()
        // The Live Activity has just gone up, saying that it is waiting for
        // GPS and when it started. That is the first thing the surfaces were
        // sent, so the pace of what follows is counted from it (see `flush`).
        shownAt = startedAt
        // Made now, while the app is on screen: iOS does not let an app begin
        // a background location session from the background.
        attachSessions()
        sessionsNeedRefresh = false
        lookup = PostLookup(store: posts)
        SavedSession.save(since: startedAt, useHeading: wanted)
        startUpdates()
        startTicking()
        onTrackingChanged?(true, nil)
        return status()
    }

    /// Stop live tracking: location off, a final snapshot that says tracking
    /// has ended, the Live Activity removed, and the web app told.
    ///
    /// Nothing here waits on the system, so the Stop button always answers.
    @discardableResult
    func stop(reason: String?) -> TrackingStatus {
        guard isActive else { return status() }
        sessionToken += 1
        isActive = false
        since = nil
        lastStopReason = reason
        updatesTask?.cancel()
        updatesTask = nil
        tickTask?.cancel()
        tickTask = nil
        detachSessions()
        SavedSession.clear()

        // The widgets keep the last post, marked as no longer tracked.
        var finalSnapshot = latest
        finalSnapshot?.tracking = false
        if let finalSnapshot = finalSnapshot {
            SharedStore.write(finalSnapshot)
        } else {
            // Stopped before this run of the app had found a post.
            MarkerTracker.markStoredPostUntracked()
        }
        requestWidgetReload(force: true)

        lookup = nil
        resetFixState()
        liveActivity.endAll(finalSnapshot: finalSnapshot)
        onTrackingChanged?(false, reason)
        return status()
    }

    func status() -> TrackingStatus {
        if isActive {
            return TrackingStatus(active: true, since: since, reason: problem?.reason)
        }
        return TrackingStatus(active: false, since: nil, reason: lastStopReason)
    }

    /// The "prefer my direction of travel" setting changed in the app.
    func setUseHeading(_ wanted: Bool) {
        guard isActive, wanted != useHeading else { return }
        useHeading = wanted
        if let started = since {
            SavedSession.save(since: started, useHeading: wanted)
        }
        if !wanted, let lookup = lookup {
            Task { await lookup.forgetConfirmation() }
        }
    }

    /// The post the web app is showing, for the widgets' "last known" value.
    /// Ignored while tracking is on: the tracker is then the only source.
    func publishFromWeb(_ snapshot: PostSnapshot) {
        guard !isActive else { return }
        SharedStore.write(snapshot)
        requestWidgetReload(force: false)
    }

    // MARK: - Starting and resuming

    /// The answer to a start that did not happen. `reason` is one of the
    /// contract's words, or nil when none of them fits.
    private func refused(_ reason: String?) -> TrackingStatus {
        lastStopReason = reason
        return TrackingStatus(active: false, since: nil, reason: reason)
    }

    /// At launch, a saved session that is not carried on: forget it, take the
    /// "tracked" mark off the post it left in the shared store, and remove
    /// whatever Live Activity it left behind. Location is never started.
    private func abandonSavedSession(reason: String?) {
        SavedSession.clear()
        MarkerTracker.markStoredPostUntracked()
        liveActivity.endAll(finalSnapshot: nil)
        lastStopReason = reason
    }

    /// A session can end before this run of the app has found a post: it is
    /// stopped straight after the app was started again, or it is not
    /// carried on at all. The shared store may then still hold the post the
    /// same session wrote earlier, marked as tracked. Tracking is over, so
    /// the mark comes off. The post and its time stay exactly as they are.
    private static func markStoredPostUntracked() {
        guard var stored = SharedStore.read(), stored.tracking else { return }
        stored.tracking = false
        SharedStore.write(stored)
    }

    private func finishResume(token: Int) async {
        let loaded = await loadStore()
        resumeTask = nil
        guard isActive, token == sessionToken else { return }
        guard let posts = loaded else {
            stop(reason: "no-data")
            return
        }
        lookup = PostLookup(store: posts)
    }

    /// The lookup, waiting first for the post list if it is still being read
    /// after a relaunch. Nil if tracking stopped meanwhile.
    ///
    /// A position that arrives in that gap must not be thrown away. If the
    /// vehicle is standing still it may be the only one iOS sends before it
    /// pauses its updates, and the display would then stay on "Waiting for
    /// GPS" until the vehicle moved.
    private func readyLookup(token: Int) async -> PostLookup? {
        if lookup == nil, let reading = resumeTask {
            await reading.value
        }
        guard isActive, token == sessionToken else { return nil }
        return lookup
    }

    private func loadStore() async -> PostStore? {
        if let cached = store { return cached }
        // Reading and checking five thousand lines is kept off the main thread.
        let loaded = await Task.detached(priority: .userInitiated) {
            return try? PostStore.loadBundled()
        }.value
        if let loaded = loaded {
            store = loaded
        }
        return loaded
    }

    /// Asked off the main thread: Core Location warns that this call can block.
    private static func locationServicesEnabled() async -> Bool {
        return await Task.detached {
            return CLLocationManager.locationServicesEnabled()
        }.value
    }

    private func attachSessions() {
        if backgroundSession == nil {
            backgroundSession = CLBackgroundActivitySession()
        }
        if serviceSession == nil {
            serviceSession = CLServiceSession(authorization: .whenInUse)
        }
    }

    private func detachSessions() {
        backgroundSession?.invalidate()
        backgroundSession = nil
        serviceSession?.invalidate()
        serviceSession = nil
    }

    private func resetFixState() {
        latest = nil
        problem = nil
        stationarySince = nil
        lastSpeed = nil
        shown = ShowRule.Display.waiting
        shownAt = Date.distantPast
        nextRenewAttempt = Date.distantPast
    }

    // MARK: - Positions

    private func startUpdates() {
        updatesTask?.cancel()
        let token = sessionToken
        updatesTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    // "Other navigation" suits a vehicle without snapping the
                    // position to a road: a patrol vehicle on the hard shoulder
                    // or in an emergency area must stay where it really is.
                    for try await update in CLLocationUpdate.liveUpdates(.otherNavigation) {
                        if Task.isCancelled { return }
                        guard let self = self else { return }
                        guard self.isActive, self.sessionToken == token else { return }
                        await self.handle(update, token: token)
                    }
                } catch {
                    // Nothing to do here: the stream is started again below,
                    // and meanwhile the stale check dims the display.
                }
                if Task.isCancelled { return }
                try? await Task.sleep(nanoseconds: MarkerTracker.streamRetrySeconds * 1_000_000_000)
            }
        }
    }

    /// One update from Core Location: either a position or a reason there is none.
    private func handle(_ update: CLLocationUpdate, token: Int) async {
        guard isActive, token == sessionToken else { return }
        // Only the moment the pause begins is kept. An update that repeats
        // "stationary" must not move it: what matters afterwards is how old
        // the position on screen was when the pause began.
        if !update.stationary {
            stationarySince = nil
        } else if stationarySince == nil {
            stationarySince = Date()
        }

        // Problems first. With any of these there is no position worth looking up.
        if update.authorizationDeniedGlobally {
            report(.servicesOff)
            return
        }
        if update.authorizationDenied {
            report(.permissionDenied)
            return
        }
        if update.accuracyLimited {
            // Approximate location is only good to a few kilometres. Showing a
            // post from it would be a guess, so the position is not used at all.
            report(.imprecise)
            return
        }
        if update.insufficientlyInUse {
            // iOS no longer counts the app as in use (for example it was
            // restarted in the background and could not rejoin its session).
            // Only opening the app puts that right.
            sessionsNeedRefresh = true
            report(.needsForeground)
            return
        }
        // From here on, every way out without a new post still calls flush():
        // iOS may just have said that it has paused (or resumed) updates, and
        // the Live Activity must be told even when there is nothing else new.
        guard let location = update.location, location.horizontalAccuracy >= 0 else {
            if update.locationUnavailable {
                report(.noSignal)
            } else {
                flush(now: Date())
            }
            return
        }

        // A position that is too rough is not a position. The posts are 100 m
        // apart, and one that may be further out than that cannot tell a post
        // from the next. It is not used at all: it does not move the post,
        // and it does not refresh the "updated" time or put off the moment
        // the last good fix goes stale.
        guard FixRule.accuracyIsUsable(location.horizontalAccuracy) else {
            // It does show that positions are arriving again, so words
            // about why none were (permission, Precise Location) no longer
            // hold. A post they dimmed stays dimmed.
            problem = nil
            flush(now: Date())
            return
        }

        // After a relaunch the post list may still be being read. The
        // position waits for it (see `readyLookup`).
        guard let lookup = await readyLookup(token: token) else {
            flush(now: Date())
            return
        }

        // The time of a fix is the time the position was true: the time the
        // system stamped it with, not the time it arrived, and never later
        // than now. The stale rule counts from it.
        let fixTime = FixRule.fixTime(reported: location.timestamp, now: Date())
        // Never let an older position replace a newer one.
        if let known = latest, fixTime < known.fixTime {
            flush(now: Date())
            return
        }

        // Step 1: course and speed, or "none". Core Location reports -1 for
        // either when it has no value. The compass is never used.
        let speed = Geo.travelSpeed(location.speed)
        let heading = Geo.travelHeading(course: location.course, speed: location.speed)
        let coordinate = location.coordinate

        // Steps 2 to 4, off the main thread.
        let found = await lookup.snapshot(lat: coordinate.latitude, lng: coordinate.longitude,
                                          heading: heading, speed: speed,
                                          useHeading: useHeading, fixTime: fixTime)
        // Tracking may have been stopped while the lookup ran.
        guard isActive, token == sessionToken else { return }
        guard var snapshot = found else {
            flush(now: Date())
            return
        }

        let now = Date()
        // The first position after a start can be one iOS had kept from
        // earlier, and iOS can hand over the same position a second time.
        // Either way it is judged by its age: if it is already too old it must
        // not look current. The one exception is a position that iOS's pause
        // accounts for.
        if !pauseExplainsSilence(fixTime: fixTime, speed: speed),
           StaleRule.isStale(fixAge: now.timeIntervalSince(fixTime), lastSpeed: speed) {
            snapshot.stale = true
        }
        problem = nil
        lastSpeed = speed
        latest = snapshot

        if UIApplication.shared.applicationState == .active {
            onFix?(snapshot)
        }
        // Step 5.
        flush(now: now)
    }

    private func report(_ newProblem: TrackingProblem) {
        problem = newProblem
        // Whatever post is on screen is now only the last known one.
        if var snapshot = latest, !snapshot.stale {
            snapshot.stale = true
            latest = snapshot
        }
        flush(now: Date())
    }

    /// True when iOS having paused its updates accounts for there being no
    /// position newer than this one, so that the post from it may go on being
    /// shown as current.
    ///
    /// Being paused is not enough by itself. The position must have been taken
    /// where the vehicle came to rest: not at speed, and not long before the
    /// pause began. Otherwise GPS lost at 70 mph, followed by a stop under
    /// cover, would leave a post from somewhere else on screen as if it were
    /// current. The rule itself is `StaleRule.pauseExplainsSilence`.
    private func pauseExplainsSilence(fixTime: Date, speed: Double?) -> Bool {
        return StaleRule.pauseExplainsSilence(pauseBegan: stationarySince, fixTime: fixTime, lastSpeed: speed)
    }

    // MARK: - Showing

    /// The words for the current problem, if the surfaces should show any.
    private var problemText: String? {
        guard let problem = problem else { return nil }
        // A lost signal is shown by dimming the last post ("No GPS since
        // HH:mm"). Words are only needed when there is no post to dim.
        if problem == .noSignal && latest != nil { return nil }
        return problem.text
    }

    /// Step 5 of "on every fix": send the newest state to the surfaces, but
    /// only when `ShowRule` says it is time. In short: a change at most once
    /// a second; the distance to a far post every five seconds; otherwise
    /// the time every 30 seconds; while iOS's pause accounts for there being
    /// nothing new, once every ten minutes all the same; and once after
    /// midnight, so that a time from yesterday is shown with its day.
    private func flush(now: Date) {
        guard isActive else { return }
        // Judged for the post on screen, not taken from iOS's word alone: a
        // pause only counts when it accounts for that post not being refreshed.
        let paused = latest.map { pauseExplainsSilence(fixTime: $0.fixTime, speed: lastSpeed) } ?? false
        let candidate = ShowRule.Display(snapshot: latest, problem: problemText, paused: paused)
        // "Distant past" means this run of the app has sent nothing yet.
        let dayChanged = shownAt != Date.distantPast && ShowRule.dayChanged(since: shownAt, now: now)
        guard ShowRule.isDue(from: shown, to: candidate, sinceShown: now.timeIntervalSince(shownAt),
                             dayChanged: dayChanged) else { return }

        let postChanged = ShowRule.postDiffers(candidate.snapshot, shown.snapshot)
        shown = candidate
        shownAt = now
        liveActivity.show(snapshot: candidate.snapshot, problem: candidate.problem, stationary: candidate.paused)
        if let snapshot = candidate.snapshot {
            SharedStore.write(snapshot)
            if postChanged {
                requestWidgetReload(force: false)
            }
        }
    }

    /// Ask the widgets to redraw, at most once every 15 seconds. A request
    /// that comes too soon is not dropped: it is made when the 15 seconds are up.
    private func requestWidgetReload(force: Bool) {
        let now = Date()
        let elapsed = now.timeIntervalSince(lastWidgetReload)
        if force || elapsed < 0 || elapsed >= MarkerTracker.widgetReloadInterval {
            lastWidgetReload = now
            WidgetCenter.shared.reloadAllTimelines()
            return
        }
        guard !widgetReloadQueued else { return }
        widgetReloadQueued = true
        let wait = MarkerTracker.widgetReloadInterval - elapsed
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard let self = self else { return }
            self.widgetReloadQueued = false
            self.lastWidgetReload = Date()
            WidgetCenter.shared.reloadAllTimelines()
        }
    }

    // MARK: - Every five seconds

    private func startTicking() {
        tickTask?.cancel()
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: MarkerTracker.tickSeconds * 1_000_000_000)
                if Task.isCancelled { return }
                guard let self = self else { return }
                self.tick()
            }
        }
    }

    /// The stale check and the housekeeping. Also run when the app comes to the front.
    private func tick() {
        guard isActive else { return }
        let now = Date()

        // A session that has run for 14 hours is over, exactly as it would be
        // if the app were started again now. A forgotten session must not keep
        // location running for days.
        if let started = since, now.timeIntervalSince(started) >= MarkerTracker.sessionLimit {
            stop(reason: nil)
            return
        }

        // Stale: no fix for 15 s while moving, 30 s when the speed is unknown,
        // 120 s when stopped or crawling. The one exception is a position
        // that iOS's pause accounts for (the phone stopped moving where it
        // was taken, and iOS said so): then silence is expected, the position
        // is still right, and the display shows the fix time.
        if var snapshot = latest, !snapshot.stale,
           !pauseExplainsSilence(fixTime: snapshot.fixTime, speed: lastSpeed),
           StaleRule.isStale(fixAge: now.timeIntervalSince(snapshot.fixTime), lastSpeed: lastSpeed) {
            snapshot.stale = true
            latest = snapshot
        }
        // Also shows a change that was held back by one of the limits, and
        // sends the display again when that is due while iOS has paused.
        flush(now: now)

        switch liveActivity.reconcile(now: now) {
        case .dismissedByUser:
            // Swiping the Live Activity away is the user saying stop. Location
            // must not carry on with nothing on screen to show for it.
            stop(reason: "stopped-by-user")
            return
        case .fine:
            break
        }

        // The rest can only be done while the app is on screen.
        guard UIApplication.shared.applicationState == .active else { return }
        if sessionsNeedRefresh {
            sessionsNeedRefresh = false
            detachSessions()
            attachSessions()
        }
        guard liveActivity.isEnabled else {
            // Live Activities were switched off in Settings during the session.
            stop(reason: "activities-disabled")
            return
        }
        if renewal == nil, now >= nextRenewAttempt, liveActivity.needsRenewal(now: now) {
            beginRenewal(replaceNearlyOver: false)
        }
    }

    /// Start a fresh Live Activity (and, where iOS allows, schedule the one
    /// that follows it). Only works in the foreground or inside an App Intent
    /// that the system runs.
    ///
    /// Only one renewal runs at a time: ask only while `renewal` is nil. The
    /// task's value says whether a fresh Live Activity is on screen.
    ///
    /// - Parameter replaceNearlyOver: true when the shortcut is asking. A
    ///   display that has all but run out may then be ended to get a new one
    ///   (see `LiveActivityController.renewChain`).
    @discardableResult
    private func beginRenewal(replaceNearlyOver: Bool) -> Task<Bool, Never> {
        let task = Task<Bool, Never> { [weak self] in
            return await self?.runRenewal(replaceNearlyOver: replaceNearlyOver) ?? false
        }
        renewal = task
        return task
    }

    private func runRenewal(replaceNearlyOver: Bool) async -> Bool {
        // Taken away before the task that runs this finishes, so that whoever
        // waits for a renewal never finds a finished one still standing here.
        defer { renewal = nil }
        guard isActive else { return false }
        let renewed = await liveActivity.renewChain(now: Date(), replaceNearlyOver: replaceNearlyOver)
        if renewed {
            nextRenewAttempt = Date.distantPast
        } else if !replaceNearlyOver {
            // The app's own attempt was refused: wait before the next one.
            // A refusal of the shortcut's request (the one made with
            // `replaceNearlyOver`) sets no wait. It says nothing about what
            // the app may do once it is on screen, and the shortcut may just
            // have told the driver to open the app: that must then renew the
            // display at once.
            nextRenewAttempt = Date().addingTimeInterval(MarkerTracker.renewRetryInterval)
        }
        return renewed
    }
}
