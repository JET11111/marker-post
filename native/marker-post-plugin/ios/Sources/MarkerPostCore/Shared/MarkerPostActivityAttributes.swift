// Compiled into both the app (through MarkerPostCore) and the widget extension.
// ActivityKit only exists on iOS, so the whole file drops out elsewhere (for
// example when the lookup tests are run with "swift test" on a Mac).
#if canImport(ActivityKit) && os(iOS)
import ActivityKit
import Foundation

/// The Live Activity that shows the nearest marker post on the Lock Screen,
/// in the Dynamic Island and on the CarPlay Dashboard.
public struct MarkerPostActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// The post to show. Nil while waiting for the first GPS fix.
        public var snapshot: PostSnapshot?
        /// A short problem to show instead of pretending all is well, e.g.
        /// "Precise Location is off" or "Location permission needed". Nil when fine.
        public var problem: String?

        public init(snapshot: PostSnapshot?, problem: String? = nil) {
            self.snapshot = snapshot
            self.problem = problem
        }
    }

    /// When this Live Activity started. iOS ends a Live Activity after eight
    /// hours, so the views can show when it is due to end.
    public var startedAt: Date
    /// 1 for the first activity of a tracking session, 2 for the follow-on that
    /// takes over before the eight-hour limit, and so on. Also used as the
    /// relevance score so the newest activity takes the Dynamic Island.
    public var generation: Int

    public init(startedAt: Date, generation: Int) {
        self.startedAt = startedAt
        self.generation = generation
    }
}
#endif
