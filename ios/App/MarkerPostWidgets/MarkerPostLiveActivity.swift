import ActivityKit
import SwiftUI
import WidgetKit

// The Live Activity: the live surface. It shows the nearest marker post on the
// Lock Screen, in the Dynamic Island, and (through the "small" family) on the
// CarPlay Dashboard and the Apple Watch Smart Stack.
//
// These views cannot read location or the network. They draw exactly what the
// app last sent, so the time of the fix is always on screen and a stale post
// is dimmed and labelled. Nothing here is a button: it is seen while driving,
// and CarPlay ignores controls anyway.

// MARK: - What to show

/// Everything the views need from one update, worked out once.
struct LivePost {
    /// Nil while waiting for the first GPS fix.
    let snapshot: PostSnapshot?
    /// A short problem from the app ("Precise Location is off"), or nil.
    let problem: String?
    /// True when the post must not be read as current: either the app said so,
    /// or iOS did because no update arrived by the date the app promised one.
    /// The second catches the app being stopped without the chance to say so.
    let stale: Bool
    /// When this Live Activity started; shown while there is no fix to time.
    let startedAt: Date

    init(_ context: ActivityViewContext<MarkerPostActivityAttributes>) {
        let state = context.state
        snapshot = state.snapshot
        if let text = state.problem, !text.isEmpty {
            problem = text
        } else {
            problem = nil
        }
        if let current = state.snapshot {
            stale = current.stale || context.isStale
        } else {
            stale = false
        }
        startedAt = context.attributes.startedAt
    }

    /// "Updated 14:32", "No GPS since 14:32", or "Started 14:02" before the first fix.
    var timeText: Text {
        if let snapshot {
            return PostTime.live(snapshot, stale: stale)
        }
        return Text("Started \(startedAt, style: .time)")
    }
}

// MARK: - Configuration

struct MarkerPostLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MarkerPostActivityAttributes.self) { context in
            // Lock Screen and banner; also CarPlay and Apple Watch, which ask
            // for the "small" family declared at the bottom.
            LiveActivityContent(post: LivePost(context))
                .activityBackgroundTint(PostPalette.card)
                .activitySystemActionForegroundColor(Color.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    IslandLeading(post: LivePost(context))
                }
                DynamicIslandExpandedRegion(.trailing) {
                    IslandTrailing(post: LivePost(context))
                }
                DynamicIslandExpandedRegion(.center) {
                    IslandCentre(post: LivePost(context))
                }
                DynamicIslandExpandedRegion(.bottom) {
                    IslandBottom(post: LivePost(context))
                }
            } compactLeading: {
                IslandCompactLeading(post: LivePost(context))
            } compactTrailing: {
                IslandCompactTrailing(post: LivePost(context))
            } minimal: {
                IslandMinimal(post: LivePost(context))
            }
            .keylineTint(PostPalette.amberOnDark)
        }
        .supplementalActivityFamilies([.small])
    }
}

// MARK: - Shared pieces

/// The time line, in the warning colour when the post is stale.
private struct LiveTime: View {
    let post: LivePost
    let size: CGFloat

    private var colour: Color { post.stale ? PostPalette.warning : PostPalette.secondaryOnCard }

    var body: some View {
        PostTimeLine(text: post.timeText, size: size, colour: colour, emphasised: post.stale)
    }
}

/// What sits beside the post: the problem, in the warning colour, when there
/// is one; otherwise the context line; otherwise nothing.
private struct LiveSideText: View {
    let post: LivePost
    let snapshot: PostSnapshot
    let contextSize: CGFloat
    let problemSize: CGFloat
    /// A problem is a short sentence, so where there is height for it, it may
    /// wrap onto a second line instead of shrinking.
    let problemLines: Int
    let alignment: TextAlignment

    private var contextColour: Color { post.stale ? PostPalette.secondaryOnCard : Color.white }

    var body: some View {
        if let problem = post.problem {
            Text(verbatim: problem)
                .font(.system(size: problemSize, weight: .semibold))
                .foregroundStyle(PostPalette.warning)
                .multilineTextAlignment(alignment)
                .lineLimit(problemLines)
                .minimumScaleFactor(0.6)
        } else if !snapshot.context.isEmpty {
            Text(verbatim: snapshot.context)
                .font(.system(size: contextSize, weight: .semibold))
                .foregroundStyle(contextColour)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
    }
}

/// Before the first fix: say so, with any problem underneath.
private struct LiveWaiting: View {
    let post: LivePost
    let titleSize: CGFloat
    let detailSize: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Waiting for GPS…")
                .font(.system(size: titleSize, weight: .bold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            if let problem = post.problem {
                Text(verbatim: problem)
                    .font(.system(size: detailSize, weight: .semibold))
                    .foregroundStyle(PostPalette.warning)
                    .lineLimit(2)
                    .minimumScaleFactor(0.6)
            }
        }
    }
}

/// A glyph for the narrow Dynamic Island slots when there is no post to show:
/// a warning triangle for a problem, otherwise a plain location arrow.
private struct IslandGlyph: View {
    let post: LivePost

    var body: some View {
        if post.problem != nil {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(PostPalette.warning)
        } else {
            Image(systemName: "location")
                .foregroundStyle(PostPalette.secondaryOnCard)
        }
    }
}

// MARK: - Lock Screen, CarPlay and Apple Watch

/// Chooses the layout for where the Live Activity is being shown.
struct LiveActivityContent: View {
    @Environment(\.activityFamily) private var activityFamily

    let post: LivePost

    var body: some View {
        switch activityFamily {
        case .small:
            LiveActivitySmall(post: post)
        default:
            LiveActivityLockScreen(post: post)
        }
    }
}

/// Lock Screen and banner. About 130 pt tall; iOS may cut off anything over 160.
private struct LiveActivityLockScreen: View {
    let post: LivePost

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                if let snapshot = post.snapshot {
                    RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 19,
                              style: PostStyle.darkCard, dimmed: post.stale)
                } else {
                    Text("Marker Post")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(PostPalette.secondaryOnCard)
                        .lineLimit(1)
                }
                // The time takes the room the road leaves and sits against
                // the right-hand edge.
                LiveTime(post: post, size: 14)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            if let snapshot = post.snapshot {
                HStack(alignment: .center, spacing: 10) {
                    // The number is offered the room first; the text beside it
                    // shrinks before the number steps down a size.
                    FittedPostNumber(snapshot: snapshot, large: 54, medium: 44, small: 34,
                                     style: PostStyle.darkCard, dimmed: post.stale)
                        .layoutPriority(1)
                    LiveSideText(post: post, snapshot: snapshot, contextSize: 20, problemSize: 16,
                                 problemLines: 2, alignment: .trailing)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            } else {
                LiveWaiting(post: post, titleSize: 26, detailSize: 15)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

/// CarPlay Dashboard and Apple Watch Smart Stack. Apple's sizes for this
/// family are 240 x 78, 240 x 100 and 170 x 78 pt, so there are two layouts
/// and the first that fits at full size is used.
private struct LiveActivitySmall: View {
    let post: LivePost

    var body: some View {
        Group {
            if let snapshot = post.snapshot {
                ViewThatFits(in: .horizontal) {
                    LiveSmallWide(post: post, snapshot: snapshot)
                    LiveSmallNarrow(post: post, snapshot: snapshot)
                }
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    LiveWaiting(post: post, titleSize: 17, detailSize: 12)
                    LiveTime(post: post, size: 10)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The lettering here is white whatever the car's or the watch's
        // appearance, so this layout brings its own dark card rather than
        // trusting what the system puts behind it.
        .background(PostPalette.card)
    }
}

/// 240 pt wide: road, context and time on the left, the post on the right.
/// It is only used where all of it fits at full size (about 53 pt tall).
private struct LiveSmallWide: View {
    let post: LivePost
    let snapshot: PostSnapshot

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 14,
                          style: PostStyle.darkCard, dimmed: post.stale)
                LiveSideText(post: post, snapshot: snapshot, contextSize: 13, problemSize: 12,
                             problemLines: 1, alignment: .leading)
                LiveTime(post: post, size: 10)
            }
            // The post takes the rest of the width and sits against the
            // right-hand edge.
            PostNumber(snapshot: snapshot, size: 38, style: PostStyle.darkCard, dimmed: post.stale)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
}

/// 170 pt wide, or a long context: road and post on one line so the post
/// stays large, with the context and the time on a line beneath (about 53 pt
/// tall in all).
private struct LiveSmallNarrow: View {
    let post: LivePost
    let snapshot: PostSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .center, spacing: 6) {
                RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 14,
                          style: PostStyle.darkCard, dimmed: post.stale)
                FittedPostNumber(snapshot: snapshot, large: 32, medium: 26, small: 22,
                                 style: PostStyle.darkCard, dimmed: post.stale)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            HStack(alignment: .center, spacing: 6) {
                LiveSideText(post: post, snapshot: snapshot, contextSize: 11, problemSize: 11,
                             problemLines: 1, alignment: .leading)
                LiveTime(post: post, size: 10)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
    }
}

// MARK: - Dynamic Island, expanded

private struct IslandLeading: View {
    let post: LivePost

    var body: some View {
        if let snapshot = post.snapshot {
            RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 16,
                      style: PostStyle.darkCard, dimmed: post.stale)
        } else {
            IslandGlyph(post: post)
        }
    }
}

private struct IslandTrailing: View {
    let post: LivePost

    var body: some View {
        if let snapshot = post.snapshot {
            LiveSideText(post: post, snapshot: snapshot, contextSize: 15, problemSize: 12,
                         problemLines: 2, alignment: .trailing)
        }
    }
}

private struct IslandCentre: View {
    let post: LivePost

    var body: some View {
        if let snapshot = post.snapshot {
            FittedPostNumber(snapshot: snapshot, large: 40, medium: 32, small: 26,
                             style: PostStyle.darkCard, dimmed: post.stale)
        } else {
            Text("Waiting for GPS…")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Color.white)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
    }
}

/// "Post P17/4A · updated 14:32", or "No GPS since 14:32" when stale. Before
/// the first fix: any problem, and when the Live Activity started.
private struct IslandBottom: View {
    let post: LivePost

    private var line: Text {
        guard let snapshot = post.snapshot else {
            return Text("Started \(post.startedAt, style: .time)")
        }
        if post.stale {
            return Text("No GPS since \(snapshot.fixTime, style: .time)")
        }
        return Text("Post \(snapshot.ref) · updated \(snapshot.fixTime, style: .time)")
    }

    private var lineColour: Color { post.stale ? PostPalette.warning : PostPalette.secondaryOnCard }

    var body: some View {
        VStack(spacing: 2) {
            // With a post on screen the problem is already beside it (trailing).
            if post.snapshot == nil, let problem = post.problem {
                Text(verbatim: problem)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PostPalette.warning)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.6)
            }
            line
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(lineColour)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Dynamic Island, compact and minimal

/// The road, small. A problem takes its place, so it is never hidden in the
/// compact form.
private struct IslandCompactLeading: View {
    let post: LivePost

    var body: some View {
        if let snapshot = post.snapshot, post.problem == nil {
            RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 12,
                      style: PostStyle.darkCard, dimmed: post.stale)
                // Long interchange names must not push the post off the other side.
                .frame(maxWidth: 62, alignment: .leading)
        } else {
            IslandGlyph(post: post)
        }
    }
}

/// The chainage and the carriageway chip (filled when confirmed, outlined
/// when chosen by position only), or "GPS…" before the first fix.
private struct IslandCompactTrailing: View {
    let post: LivePost

    var body: some View {
        if let snapshot = post.snapshot {
            PostNumber(snapshot: snapshot, size: 15, style: PostStyle.darkCard,
                       dimmed: post.stale, chipHeight: 16)
        } else {
            Text("GPS…")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PostPalette.secondaryOnCard)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
    }
}

/// The chainage alone, in amber, scaled to fit the smallest form. There is no
/// room for a time here, so a stale post loses its amber instead.
private struct IslandMinimal: View {
    let post: LivePost

    private var colour: Color { post.stale ? PostPalette.secondaryOnCard : PostPalette.amberOnDark }

    var body: some View {
        if let snapshot = post.snapshot {
            Text(verbatim: snapshot.km.isEmpty ? snapshot.ref : snapshot.km)
                .font(.system(size: 13, weight: .heavy).monospacedDigit())
                .foregroundStyle(colour)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
        } else {
            IslandGlyph(post: post)
        }
    }
}
