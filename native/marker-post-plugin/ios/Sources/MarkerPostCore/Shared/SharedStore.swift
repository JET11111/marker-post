import Foundation

// Compiled into both the app (through MarkerPostCore) and the widget extension.

/// The last known post, shared between the app and its widgets through the
/// App Group container. The app writes; the widgets read.
public enum SharedStore {
    /// Must match the App Group in both entitlements files
    /// (ios/App/App/App.entitlements and ios/App/MarkerPostWidgets/MarkerPostWidgets.entitlements)
    /// and the group registered for both App IDs on the Apple Developer website.
    public static let appGroup = "group.io.github.jet11111.markerpost"

    private static let snapshotKey = "markerpost.snapshot.v1"

    /// Not nil when the App Group is missing from the entitlements (an
    /// unsigned build, such as the device build on GitHub): the app and the
    /// widgets then each read and write a private copy, so nothing is shared
    /// and nothing fails. A widget stuck on "No post yet" while the app is
    /// showing a post usually means exactly that.
    private static var defaults: UserDefaults? { UserDefaults(suiteName: appGroup) }

    /// Save the last known post. Pass nil to clear it.
    public static func write(_ snapshot: PostSnapshot?) {
        guard let defaults else { return }
        guard let snapshot else {
            defaults.removeObject(forKey: snapshotKey)
            return
        }
        if let data = try? JSONEncoder().encode(snapshot) {
            defaults.set(data, forKey: snapshotKey)
        }
    }

    /// The last known post, or nil if none has been saved yet.
    public static func read() -> PostSnapshot? {
        guard let data = defaults?.data(forKey: snapshotKey) else { return nil }
        return try? JSONDecoder().decode(PostSnapshot.self, from: data)
    }
}
