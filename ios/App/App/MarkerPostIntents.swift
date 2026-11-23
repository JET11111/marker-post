import AppIntents
import MarkerPostNative

// Why this exists: iOS ends a Live Activity eight hours after it starts, and an
// app in the background is not allowed to start another. The one exception is
// an App Intent that the SYSTEM runs for the user (Siri, the Shortcuts app, a
// Shortcuts automation such as "When CarPlay connects" or "Time of Day", the
// Action button). So this intent is the way to get the display back during a
// long shift without unlocking the phone and opening the app.
//
// It must never switch tracking on. It only puts the display back for a
// session that is already running; if live tracking is off it does nothing,
// and it never starts location.
//
// It always says what happened. Asked for by voice, a plain "done" with
// nothing on screen would be worse than no answer: the driver would believe
// the display was back.

struct StartLiveTrackingIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Show nearest marker post"
    static let description = IntentDescription(
        "Puts the nearest marker post back on the Lock Screen and in CarPlay while live tracking is running. Does nothing if live tracking is off.")

    func perform() async throws -> some IntentResult & ProvidesDialog {
        switch await MarkerTracker.shared.restartLiveActivityIfTracking() {
        case .shown:
            return .result(dialog: "The marker post display has been renewed.")
        case .trackingOff:
            return .result(dialog: "Live tracking is off. Open Marker Post to start it.")
        case .stillShowing:
            // iOS would not start a new display, but the old one is still on
            // screen. Siri is reported to refuse a new one while another is
            // showing, so this may be the usual answer by voice. Nothing was
            // lost, so nobody is sent to the phone for it.
            return .result(dialog: "The marker post display is still on. It could not be renewed.")
        case .refused:
            // Nothing is on screen. Opening the app puts the display back.
            return .result(dialog: "The marker post display could not be renewed. Open Marker Post.")
        }
    }
}

struct MarkerPostShortcuts: AppShortcutsProvider {
    // Every phrase must contain the app's name: that is how Siri knows whose
    // shortcut is meant.
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartLiveTrackingIntent(),
            phrases: [
                "Show \(.applicationName)",
                "Show nearest marker post with \(.applicationName)",
                "Restart \(.applicationName) display"
            ],
            shortTitle: "Show nearest marker post",
            systemImageName: "signpost.right")
    }
}
