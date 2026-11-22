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

struct StartLiveTrackingIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Show nearest marker post"
    static let description = IntentDescription(
        "Puts the nearest marker post back on the Lock Screen and in CarPlay while live tracking is running. Does nothing if live tracking is off.")

    func perform() async throws -> some IntentResult {
        await MarkerTracker.shared.restartLiveActivityIfTracking()
        return .result()
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
