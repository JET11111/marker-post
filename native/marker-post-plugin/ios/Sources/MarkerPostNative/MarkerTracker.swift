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
struct TrackingStatus {
    let active: Bool
    /// When the running session started. Nil when not tracking.
    let since: Date?
    /// One of the reason words in docs/native-apps.md section 1, or nil.
    let reason: String?
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
    /// carriageway is confirmed, build the snapshot.
    func snapshot(lat: Double, lng: Double, heading: Double?, speed: Double?,
                  useHeading: Bool, fixTime: Date) -> PostSnapshot? {
        guard let nearest = store.findNearest(lat: lat, lng: lng, heading: heading,
                                              speed: speed, useHeading: useHeading) else { return nil }
        let post = store.posts[nearest.index]
        let confirmed = confirmation.confirmed(post: post, headingUsed: nearest.headingUsed, lat: lat, lng: lng)
        return post.snapshot(confirmed: confirmed, fixTime: fixTime, stale: false, tracking: true)
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

    /// Called whenever tracking starts or stops, for any reason.
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
    /// A change is shown at most this often.
    private static let minimumShowInterval: TimeInterval = 1
    /// While the post is unchanged, the "updated" time is refreshed this often.
    private static let heartbeatInterval: TimeInterval = 30
    /// Widgets are asked to redraw at most this often. iOS rations the requests.
    private static let widgetReloadInterval: TimeInterval = 15
    /// After a failed attempt to renew the Live Activity, wait before trying again.
    private static let renewRetryInterval: TimeInterval = 60
    /// If the stream of positions ends while tracking is on, start it again after this.
    private static let streamRetrySeconds: UInt64 = 3

    // MARK: Session

    private var isActive = false
    private var isStarting = false
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

    // MARK: What is known, and what is on screen

    /// The post from the newest fix, with `stale` kept up to date.
    private var latest: PostSnapshot?
    private var problem: TrackingProblem?
    /// True when iOS has said the phone is not moving and has paused updates.
    private var systemSaysStationary = false
    /// Speed of the newest fix in metres per second. Nil when it had none.
    private var lastSpeed: Double?

    /// What the surfaces were last told to show.
    private struct Shown {
        var snapshot: PostSnapshot?
        var problem: String?
        var stationary: Bool

        static let waiting = Shown(snapshot: nil, problem: nil, stationary: false)
    }

    private var shown = Shown.waiting
    private var shownAt = Date.distantPast

    private let liveActivity: LiveActivityController
    private var isRenewing = false
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
    public func resumeAfterLaunch() {
        guard !isActive, !isStarting else { return }
        guard let saved = SavedSession.load() else { return }
        let age = Date().timeIntervalSince(saved.since)
        // A start time in the future means the clock was changed: not trustworthy either.
        guard age >= 0, age < MarkerTracker.sessionLimit else {
            SavedSession.clear()
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
        liveActivity.adoptExisting()
        startUpdates()
        startTicking()
        Task { [weak self] in
            await self?.finishResume(token: token)
        }
    }

    /// Put the Live Activity back on screen, but only if live tracking is
    /// already running. It never starts tracking and never starts location.
    ///
    /// This is what the "Show nearest marker post" shortcut runs. iOS ends a
    /// Live Activity after eight hours and a background app may not start
    /// another; an App Intent run by the system may.
    ///
    /// - Returns: true if a Live Activity was started.
    @discardableResult
    public func restartLiveActivityIfTracking() async -> Bool {
        guard isActive else { return false }
        return await renewChain()
    }

    // MARK: - Used by the plugin

    /// Start live tracking. Must be called while the app is on screen. Asks
    /// for location permission once if it has never been asked.
    func start(useHeading wanted: Bool) async -> TrackingStatus {
        if isActive {
            setUseHeading(wanted)
            return status()
        }
        // The button in the app is disabled while a start is in progress; this
        // covers a second call arriving anyway.
        guard !isStarting else { return TrackingStatus(active: false, since: nil, reason: nil) }
        isStarting = true
        defer { isStarting = false }

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
            return refused("unsupported")
        }

        sessionToken += 1
        isActive = true
        since = startedAt
        useHeading = wanted
        lastStopReason = nil
        resetFixState()
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

    private func refused(_ reason: String) -> TrackingStatus {
        lastStopReason = reason
        return TrackingStatus(active: false, since: nil, reason: reason)
    }

    private func finishResume(token: Int) async {
        let loaded = await loadStore()
        guard isActive, token == sessionToken else { return }
        guard let posts = loaded else {
            stop(reason: "no-data")
            return
        }
        lookup = PostLookup(store: posts)
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
        systemSaysStationary = false
        lastSpeed = nil
        shown = Shown.waiting
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
        systemSaysStationary = update.stationary

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

        // After a relaunch the post list may still be loading. The next fix is a second away.
        guard let lookup = lookup else {
            flush(now: Date())
            return
        }
        // Never let an older position replace a newer one.
        if let known = latest, location.timestamp < known.fixTime {
            flush(now: Date())
            return
        }

        // Step 1: course and speed, or "none". Core Location reports -1 for
        // either when it has no value. The compass is never used.
        let speed = Geo.travelSpeed(location.speed)
        let heading = Geo.travelHeading(course: location.course, speed: location.speed)
        let fixTime = location.timestamp
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
        // earlier. If it is already too old it must not look current.
        if !systemSaysStationary && StaleRule.isStale(fixAge: now.timeIntervalSince(fixTime), lastSpeed: speed) {
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

    // MARK: - Showing

    /// The words for the current problem, if the surfaces should show any.
    private var problemText: String? {
        guard let problem = problem else { return nil }
        // A lost signal is shown by dimming the last post ("No GPS since
        // HH:mm"). Words are only needed when there is no post to dim.
        if problem == .noSignal && latest != nil { return nil }
        return problem.text
    }

    private static func differ(_ a: PostSnapshot?, _ b: PostSnapshot?) -> Bool {
        switch (a, b) {
        case (nil, nil):
            return false
        case let (first?, second?):
            return !first.showsSameAs(second)
        default:
            return true
        }
    }

    /// Step 5 of "on every fix": show the newest state only if something
    /// visible changed, and not more than once a second; otherwise refresh the
    /// time every 30 seconds.
    private func flush(now: Date) {
        guard isActive else { return }
        let candidate = Shown(snapshot: latest, problem: problemText, stationary: systemSaysStationary)
        let postChanged = MarkerTracker.differ(candidate.snapshot, shown.snapshot)
        // A change between moving and stationary shows nothing new, but the
        // Live Activity needs it at once: it decides whether the system may
        // mark the activity as out of date by itself.
        let changed = postChanged || candidate.problem != shown.problem || candidate.stationary != shown.stationary
        let elapsed = now.timeIntervalSince(shownAt)
        // A negative time means the clock was put back: do not wait for it to catch up.
        let waited = { (interval: TimeInterval) -> Bool in elapsed < 0 || elapsed >= interval }

        if changed {
            // The one thing that does not wait its second: iOS saying it has
            // paused updates because the phone stopped moving. The app may get
            // no more time to run after that, and if the Live Activity were
            // not told now it would go out of date by itself while parked.
            let justStopped = candidate.stationary && !shown.stationary
            guard justStopped || waited(MarkerTracker.minimumShowInterval) else { return }
        } else {
            let timeMoved = candidate.snapshot?.fixTime != shown.snapshot?.fixTime
            guard timeMoved, waited(MarkerTracker.heartbeatInterval) else { return }
        }

        shown = candidate
        shownAt = now
        liveActivity.show(snapshot: candidate.snapshot, problem: candidate.problem, stationary: candidate.stationary)
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
        // 120 s when stopped or crawling. Not while iOS itself has paused the
        // updates because the phone is not moving: then silence is expected,
        // the position is still right, and the display shows the fix time.
        if var snapshot = latest, !snapshot.stale, !systemSaysStationary,
           StaleRule.isStale(fixAge: now.timeIntervalSince(snapshot.fixTime), lastSpeed: lastSpeed) {
            snapshot.stale = true
            latest = snapshot
        }
        // Also shows a change that was held back by the once-a-second limit.
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
        if !isRenewing, now >= nextRenewAttempt, liveActivity.needsRenewal(now: now) {
            Task { [weak self] in
                await self?.renewChain()
            }
        }
    }

    /// Start a fresh Live Activity (and, where iOS allows, schedule the one
    /// that follows it). Only works in the foreground or inside an App Intent
    /// that the system runs.
    @discardableResult
    private func renewChain() async -> Bool {
        guard isActive, !isRenewing else { return false }
        isRenewing = true
        let renewed = await liveActivity.renewChain(now: Date())
        isRenewing = false
        nextRenewAttempt = renewed ? Date.distantPast : Date().addingTimeInterval(MarkerTracker.renewRetryInterval)
        return renewed
    }
}
