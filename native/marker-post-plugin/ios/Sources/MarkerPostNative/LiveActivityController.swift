import Foundation
import MarkerPostCore

// Everything that touches ActivityKit: the Live Activity on the Lock Screen,
// in the Dynamic Island and on the CarPlay Dashboard.
//
// The tracker decides WHAT to show and WHEN (docs/native-apps.md section 4).
// This file only delivers it, and looks after the eight-hour limit (section 5).

/// How an attempt to start the Live Activity ended.
enum LiveActivityStart {
    case started
    /// Live Activities are switched off for the app in Settings.
    case disabled
    /// The system refused for another reason.
    case failed
}

/// What the regular check found.
enum LiveActivityCheck {
    case fine
    /// The user swiped the Live Activity away.
    case dismissedByUser
}

#if canImport(ActivityKit) && os(iOS)
import ActivityKit

@MainActor
final class LiveActivityController {
    private typealias PostActivity = Activity<MarkerPostActivityAttributes>
    private typealias ContentState = MarkerPostActivityAttributes.ContentState

    // MARK: Timings (docs/native-apps.md section 5)

    /// iOS ends a Live Activity this long after it starts, whatever the app does.
    private static let systemLimit: TimeInterval = 8 * 60 * 60
    /// The follow-on activity is scheduled to start this long after the first,
    /// a quarter of an hour before the limit.
    private static let successorStartsAfter: TimeInterval = 7 * 60 * 60 + 45 * 60
    /// With no follow-on, the driver is warned once at this age.
    private static let warnAfter: TimeInterval = 7 * 60 * 60 + 30 * 60
    /// An activity older than this is replaced when the app is on screen, which resets the eight hours.
    private static let renewAfter: TimeInterval = 2 * 60 * 60
    /// While moving, the system itself marks the activity out of date this
    /// long after the last update, in case the app can no longer speak.
    private static let staleAfter: TimeInterval = 90
    /// How long the warning words stay on the activity before the ordinary
    /// display returns. They take the place of the line beside the post (the
    /// junction section), so they are not left up for the whole half hour.
    private static let noticeSeconds: UInt64 = 60
    /// Remembers which activity has been warned about, so the warning is given once.
    private static let warnedKey = "markerpost.activity.warned"

    /// A fixed 24-hour "14:05", whatever the phone's region or 12/24-hour setting.
    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    /// What the tracker last asked to be shown.
    private struct Screen {
        var snapshot: PostSnapshot?
        var problem: String?
        var stationary: Bool

        /// Nothing to show yet: waiting for the first GPS fix.
        static let waiting = Screen(snapshot: nil, problem: nil, stationary: false)
    }

    /// Words shown for a short while on one activity (the "display is ending" warning).
    private struct Notice {
        let activityID: String
        let text: String
        let until: Date
    }

    let isSupported = true

    /// False when the user has switched Live Activities off for the app.
    var isEnabled: Bool {
        return ActivityAuthorizationInfo().areActivitiesEnabled
    }

    /// The activity on screen, if any.
    private var current: PostActivity?
    /// The follow-on that iOS will start by itself before `current` reaches eight hours (iOS 26 and later).
    private var successor: PostActivity?

    private var screen = Screen.waiting
    /// The newest display not yet sent to `current`, and whether a send is under way.
    private var unsent: Screen?
    private var isSending = false
    /// The same for `successor`, which is updated separately (see `send`).
    private var unsentForSuccessor: Screen?
    private var isSendingToSuccessor = false
    private var notice: Notice?
    private var highestGeneration = 0
    /// Goes up whenever a chain is started, renewed or ended, so an older
    /// request that is still waiting on the system can tell it was overtaken.
    private var epoch = 0

    // MARK: - Starting, renewing and ending

    /// Start the first Live Activity of a tracking session. Foreground only.
    func startChain(now: Date) async -> LiveActivityStart {
        guard isEnabled else { return .disabled }
        epoch += 1
        let mine = epoch
        current = nil
        successor = nil
        screen = Screen.waiting
        unsent = nil
        unsentForSuccessor = nil
        notice = nil
        highestGeneration = 0
        UserDefaults.standard.removeObject(forKey: LiveActivityController.warnedKey)

        // Nothing from an earlier session may linger beside the new activity.
        await end(PostActivity.activities)
        guard mine == epoch else { return .failed }

        if await requestChain(now: now, epoch: mine) { return .started }
        return isEnabled ? .failed : .disabled
    }

    /// Replace the activity on screen with a fresh one, which resets the eight
    /// hours. Works in the foreground, and inside an App Intent the system runs.
    func renewChain(now: Date) async -> Bool {
        guard isEnabled else { return false }
        epoch += 1
        return await requestChain(now: now, epoch: epoch)
    }

    /// After the app was restarted: find the activities that are still there.
    func adoptExisting() {
        let all = PostActivity.activities
        let byGeneration: (PostActivity, PostActivity) -> Bool = { $0.attributes.generation < $1.attributes.generation }
        let showing = all.filter { isShowing($0) }.sorted(by: byGeneration)
        let scheduled = all.filter { !isShowing($0) && !isOver($0) }.sorted(by: byGeneration)
        current = showing.last
        successor = scheduled.last
        highestGeneration = all.map { $0.attributes.generation }.max() ?? 0

        // The newest of each kind is kept. Anything older, and any ended copy
        // still frozen on the Lock Screen, is cleared away.
        let frozen = all.filter { $0.activityState == .ended }
        let unwanted = Array(showing.dropLast()) + Array(scheduled.dropLast()) + frozen
        if !unwanted.isEmpty {
            Task { await self.end(unwanted) }
        }
    }

    /// Tracking has stopped: show the last post one final time and remove
    /// every activity, including one that was only scheduled.
    ///
    /// Returns at once. Which activities go is decided here and now, so a new
    /// session started a moment later is not touched; the removal itself is
    /// finished in the background, so stopping never waits on the system.
    func endAll(finalSnapshot: PostSnapshot?) {
        epoch += 1
        // Worked out before the two references are let go: see `withHeld`.
        let ending = showingFirst(withHeld(PostActivity.activities))
        current = nil
        successor = nil
        screen = Screen.waiting
        unsent = nil
        unsentForSuccessor = nil
        notice = nil

        let state = ContentState(snapshot: finalSnapshot, problem: nil)
        Task {
            for activity in ending {
                let lastContent = ActivityContent(state: state, staleDate: nil,
                                                  relevanceScore: Double(activity.attributes.generation))
                // Removed at once: an ended copy left on the Lock Screen would
                // show a post that nothing is keeping up to date.
                await activity.end(lastContent, dismissalPolicy: .immediate)
            }
        }
    }

    /// Ask for a fresh activity, end the ones it replaces, and where the
    /// system allows (iOS 26 and later) schedule the one that follows it.
    private func requestChain(now: Date, epoch mine: Int) async -> Bool {
        // Everything the new chain replaces, including a follow-on that is
        // only held here (see `withHeld`).
        let before = withHeld(PostActivity.activities)
        let known = before.filter { !isOver($0) }.map { $0.attributes.generation }.max() ?? 0
        // Each new activity gets a higher number, which is also its relevance
        // score: with equal scores iOS keeps showing the OLDER activity.
        let generation = max(known, highestGeneration) + 1

        var fresh: PostActivity?
        do {
            fresh = try request(generation: generation, startedAt: now)
        } catch {
            // The request is tried first, so that a refusal leaves the old
            // display alone. Nothing is ended for a second try unless the
            // refusal is one that ending is sure to cure: there are already
            // as many Live Activities as iOS allows.
            //
            // Every other refusal keeps what is on screen. The usual one is
            // that the app is not on screen, and that would only be given
            // again. Siri is reported to give the same answer while another
            // activity from the app is showing; ending the display on the
            // chance that this is why would leave nothing on screen if it
            // was not, and nothing to carry the 7 h 30 min warning.
            guard LiveActivityController.endingOthersCures(error), !before.isEmpty else { return false }
            // Forgotten before they are ended, so that the regular check does
            // not mistake this for the user swiping the activity away.
            current = nil
            successor = nil
            await end(before)
            guard mine == epoch else { return false }
            fresh = try? request(generation: generation, startedAt: now)
        }
        guard let started = fresh else { return false }

        current = started
        successor = nil
        highestGeneration = generation

        // "The newest active activity receives updates; older ones are ended."
        // That includes a follow-on scheduled by the chain being replaced.
        await end(before)
        guard mine == epoch else {
            // Tracking was stopped, or a newer request made, while the old
            // activities were ending. This one is no longer wanted.
            await abandon(started)
            return false
        }

        if let next = await scheduleSuccessor(generation: generation + 1, after: now) {
            guard mine == epoch else {
                await abandon(next)
                await abandon(started)
                return false
            }
            successor = next
            highestGeneration = generation + 1
        }
        return true
    }

    private func request(generation: Int, startedAt: Date) throws -> PostActivity {
        let attributes = MarkerPostActivityAttributes(startedAt: startedAt, generation: generation)
        // pushType nil: every update comes from this app, never from a server.
        return try PostActivity.request(
            attributes: attributes,
            content: content(screen, generation: generation, activityID: nil, now: startedAt),
            pushType: nil)
    }

    /// iOS 26 and later can start a Live Activity at a set time even if the
    /// app is in the background then. That is how the display outlives the
    /// eight-hour limit without anyone touching the phone. Earlier systems
    /// return nil here and rely on the warning and the App Shortcut instead.
    private func scheduleSuccessor(generation: Int, after now: Date) async -> PostActivity? {
        guard #available(iOS 26.0, *) else { return nil }
        let start = now.addingTimeInterval(LiveActivityController.successorStartsAfter)
        let attributes = MarkerPostActivityAttributes(startedAt: start, generation: generation)
        // It starts with the neutral "waiting" display. If the vehicle is
        // parked when it starts, the app may not be running to fill it in, and
        // a post from hours earlier must not be what it opens with. Updates
        // are sent to it while it waits (see send), so normally it is current.
        let waiting = ActivityContent(state: ContentState(snapshot: nil, problem: nil),
                                      staleDate: nil,
                                      relevanceScore: Double(generation))
        // iOS insists on an alert for a scheduled start.
        let alert = AlertConfiguration(title: "Marker Post",
                                       body: "Live tracking display renewed.",
                                       sound: .default)
        do {
            // "await" is harmless if this call turns out not to be asynchronous.
            return try await PostActivity.request(attributes: attributes,
                                                  content: waiting,
                                                  pushType: nil,
                                                  style: .standard,
                                                  alertConfiguration: alert,
                                                  start: start)
        } catch {
            // No follow-on: the 7 h 30 min warning covers this case.
            return nil
        }
    }

    /// True for the two refusals that go away once this app's older
    /// activities have ended: the app, or the phone as a whole, already has
    /// as many Live Activities as iOS allows.
    private static func endingOthersCures(_ error: Error) -> Bool {
        guard let reason = error as? ActivityAuthorizationError else { return false }
        switch reason {
        case .targetMaximumExceeded, .globalMaximumExceeded:
            return true
        default:
            return false
        }
    }

    private func end(_ activities: [PostActivity]) async {
        for activity in showingFirst(activities) {
            await activity.end(nil, dismissalPolicy: .immediate)
        }
    }

    /// The activities the system lists, together with the two held here if
    /// the list leaves either out.
    ///
    /// Apple does not say whether an activity that is scheduled but has not
    /// started yet is listed. If it is not, the reference kept in `successor`
    /// is the only way to cancel it: dropped without being ended, a stopped
    /// session's follow-on would still start hours later with its alert, and
    /// each renewal would leave another one waiting.
    private func withHeld(_ listed: [PostActivity]) -> [PostActivity] {
        var all = listed
        for held in [current, successor] {
            if let held = held, !all.contains(where: { $0.id == held.id }) {
                all.append(held)
            }
        }
        return all
    }

    /// The activities that are on screen first, then the rest. The visible
    /// ones are the ones that matter, so they are never left waiting behind a
    /// scheduled or already finished one.
    private func showingFirst(_ activities: [PostActivity]) -> [PostActivity] {
        return activities.filter { isShowing($0) } + activities.filter { !isShowing($0) }
    }

    private func abandon(_ activity: PostActivity) async {
        if current === activity { current = nil }
        if successor === activity { successor = nil }
        await activity.end(nil, dismissalPolicy: .immediate)
    }

    // MARK: - Updating

    /// Show this on the Live Activity. Updates are sent one at a time and in
    /// order; if the system is slow, only the newest one waiting is sent.
    ///
    /// `stationary` is the tracker's judgement, not iOS's word alone: true only
    /// when iOS has paused its updates and that accounts for this post not
    /// being refreshed. It switches off the stale date (see `content`).
    func show(snapshot: PostSnapshot?, problem: String?, stationary: Bool) {
        screen = Screen(snapshot: snapshot, problem: problem, stationary: stationary)
        send(screen)
    }

    private func send(_ next: Screen) {
        unsent = next
        if !isSending {
            isSending = true
            Task {
                while let waiting = self.unsent {
                    self.unsent = nil
                    if let activity = self.current {
                        await activity.update(self.content(waiting, generation: activity.attributes.generation,
                                                           activityID: activity.id, now: Date()))
                    }
                }
                self.isSending = false
            }
        }

        // The scheduled follow-on is kept up to date too, so that it opens
        // with the right post. It has its own queue: how iOS treats an update
        // to an activity that has not started yet is not documented, and a
        // slow or ignored one must never hold up the activity on screen. If
        // such updates are ignored nothing is lost, because the follow-on is
        // updated again the moment it starts.
        guard successor != nil else {
            unsentForSuccessor = nil
            return
        }
        unsentForSuccessor = next
        if !isSendingToSuccessor {
            isSendingToSuccessor = true
            Task {
                while let waiting = self.unsentForSuccessor {
                    self.unsentForSuccessor = nil
                    if let activity = self.successor {
                        await activity.update(self.content(waiting, generation: activity.attributes.generation,
                                                           activityID: activity.id, now: Date()))
                    }
                }
                self.isSendingToSuccessor = false
            }
        }
    }

    private func content(_ screen: Screen, generation: Int, activityID: String?, now: Date) -> ActivityContent<ContentState> {
        var problem = screen.problem
        if problem == nil, let notice = notice, notice.activityID == activityID, now < notice.until {
            problem = notice.text
        }
        let state = ContentState(snapshot: screen.snapshot, problem: problem)

        // The stale date is the system's own backstop. If the app is closed or
        // loses GPS while the vehicle is moving, iOS marks the activity out of
        // date by itself once this time passes. A post that is current goes
        // without a date in one case only: the tracker says that iOS's pause
        // accounts for the silence (the vehicle is standing where this post
        // was found). Silence is then expected, and the display would
        // otherwise go out of date while parked.
        var staleDate: Date?
        if let snapshot = screen.snapshot, !snapshot.stale, screen.problem == nil, !screen.stationary {
            staleDate = now.addingTimeInterval(LiveActivityController.staleAfter)
        }
        return ActivityContent(state: state, staleDate: staleDate, relevanceScore: Double(generation))
    }

    // MARK: - The regular check

    /// True when a fresh activity should be requested the next time the app is
    /// on screen: nothing is showing, or what is showing is over two hours old.
    func needsRenewal(now: Date) -> Bool {
        guard let activity = current else { return true }
        return now.timeIntervalSince(activity.attributes.startedAt) >= LiveActivityController.renewAfter
    }

    /// Called every few seconds while tracking: hand over to a follow-on that
    /// has started, notice an activity that has gone, and give the one warning.
    func reconcile(now: Date) -> LiveActivityCheck {
        // 1. The follow-on has started: it takes over and the old one is ended.
        if let next = successor {
            if isShowing(next) {
                let old = current
                current = next
                successor = nil
                if let old = old {
                    Task { await old.end(nil, dismissalPolicy: .immediate) }
                }
                // In case updates sent while it waited were ignored.
                send(screen)
            } else if isOver(next) {
                successor = nil
            }
        }

        // 2. What became of the activity on screen?
        if let activity = current {
            let state = activity.activityState
            let age = now.timeIntervalSince(activity.attributes.startedAt)
            if state == .dismissed {
                current = nil
                // Removed well before the eight-hour limit: the user swiped it
                // away. After the limit it is the system tidying up. And if the
                // follow-on is due to start, the system may be making room for
                // it, which must not be mistaken for the user saying stop.
                let handoverDue = successor.map { now >= $0.attributes.startedAt.addingTimeInterval(-60) } ?? false
                if age < LiveActivityController.systemLimit - 300 && !handoverDue {
                    return .dismissedByUser
                }
            } else if state == .ended {
                // Ended by the system at the limit. iOS can leave a frozen
                // copy on the Lock Screen for hours; clear it, because nothing
                // can update it any more.
                current = nil
                Task { await activity.end(nil, dismissalPolicy: .immediate) }
            }
        }

        // 3. Half an hour before the limit, with no follow-on: say so, once.
        if let activity = current, successor == nil {
            let age = now.timeIntervalSince(activity.attributes.startedAt)
            if age >= LiveActivityController.warnAfter, age < LiveActivityController.systemLimit {
                // Remembered on disk, so a restart of the app in that half hour does not repeat it.
                let warned = UserDefaults.standard.string(forKey: LiveActivityController.warnedKey) == activity.id
                if !warned {
                    UserDefaults.standard.set(activity.id, forKey: LiveActivityController.warnedKey)
                    warnOfEnding(activity, now: now)
                }
            }
        }
        return .fine
    }

    /// One alerting update: the display ends at HH:mm, open Marker Post.
    ///
    /// An alerting update is the only reminder that reaches the CarPlay screen
    /// (an ordinary notification does not). The alert's own title and body are
    /// shown on Apple Watch only, so the same words are also put on the
    /// activity itself for a short while.
    private func warnOfEnding(_ activity: PostActivity, now: Date) {
        let ends = activity.attributes.startedAt.addingTimeInterval(LiveActivityController.systemLimit)
        let time = LiveActivityController.clock.string(from: ends)
        let seconds = LiveActivityController.noticeSeconds
        let words = Notice(activityID: activity.id,
                           text: "Ends \(time). Open Marker Post.",
                           until: now.addingTimeInterval(TimeInterval(seconds)))
        notice = words

        let alert = AlertConfiguration(title: "Marker Post display ends at \(time)",
                                       body: "Open Marker Post on your iPhone to keep it on screen.",
                                       sound: .default)
        let update = content(screen, generation: activity.attributes.generation, activityID: activity.id, now: now)
        Task {
            await activity.update(update, alertConfiguration: alert)
            // Then put the ordinary display back.
            try? await Task.sleep(nanoseconds: (seconds + 1) * 1_000_000_000)
            if self.notice?.until == words.until {
                self.notice = nil
            }
            self.send(self.screen)
        }
    }

    // MARK: - States

    /// On screen now. ("stale" is still on screen: only its content is out of date.)
    private func isShowing(_ activity: PostActivity) -> Bool {
        let state = activity.activityState
        return state == .active || state == .stale
    }

    /// Finished, whether still visible or not.
    private func isOver(_ activity: PostActivity) -> Bool {
        let state = activity.activityState
        return state == .ended || state == .dismissed
    }
}

#else

// No ActivityKit on this platform: live tracking reports "unsupported".
@MainActor
final class LiveActivityController {
    let isSupported = false
    var isEnabled: Bool { return false }

    func startChain(now: Date) async -> LiveActivityStart { return .failed }
    func renewChain(now: Date) async -> Bool { return false }
    func adoptExisting() {}
    func endAll(finalSnapshot: PostSnapshot?) {}
    func show(snapshot: PostSnapshot?, problem: String?, stationary: Bool) {}
    func needsRenewal(now: Date) -> Bool { return false }
    func reconcile(now: Date) -> LiveActivityCheck { return .fine }
}

#endif
