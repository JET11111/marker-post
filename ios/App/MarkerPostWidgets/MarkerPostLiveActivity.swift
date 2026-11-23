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
//
// Three rules shape every layout below:
//   * The time is never the part that gets cut. It has a line to itself, the
//     full width of the surface, and shrinks to fit.
//   * The line under the post can be long ("Link M27B/M3B · survey date
//     unknown"). It also gets a full-width line, shrinks a little to fit, and
//     if it still cannot fit it is cut at the end. It is never reworded.
//   * A post that is no longer current says so in words, or with a symbol
//     where there is no room for words. Never by brightness alone.

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
    /// When these views were drawn. iOS draws them again each time the app
    /// sends an update and when the post goes out of date, not in between.
    let now: Date

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
        now = Date()
    }

    /// "Updated 14:32", "No GPS since 14:32", or "Started 14:02" before the
    /// first fix. Always 24-hour. A time that is not from the day the views
    /// were drawn on carries its day: "No GPS since 21 Nov, 14:32".
    var timeText: String {
        if let snapshot {
            let words = SurfaceText.liveWords(stale: stale)
            return "\(words) \(SurfaceText.time(snapshot.fixTime, now: now))"
        }
        return "Started \(SurfaceText.time(startedAt, now: now))"
    }
}

// MARK: - Configuration

struct MarkerPostLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: MarkerPostActivityAttributes.self) { context in
            // Lock Screen and banner; also CarPlay and Apple Watch, which ask
            // for the "small" family declared at the bottom.
            LiveActivityContent(post: LivePost(context))
                .activityBackgroundTint(PostPalette.nightSurface)
                .activitySystemActionForegroundColor(PostPalette.nightText)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    IslandLeading(post: LivePost(context))
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

    private var colour: Color { post.stale ? PostPalette.warning : PostPalette.nightSecondary }

    var body: some View {
        PostTimeLine(text: post.timeText, size: size, colour: colour, emphasised: post.stale)
    }
}

/// The line under the post: the problem, in the warning colour, when there is
/// one; otherwise the context line ("J4 – J5"); otherwise nothing.
///
/// It is always given a line of its own, the full width of the surface. The
/// context is shown word for word on one line: it shrinks a little to fit,
/// and if it still cannot fit it is cut at the end.
private struct LiveContext: View {
    let post: LivePost
    let snapshot: PostSnapshot
    let contextSize: CGFloat
    let problemSize: CGFloat
    /// A problem is a short sentence, so where there is height for it, it may
    /// wrap onto a second line instead of shrinking.
    let problemLines: Int
    /// How a problem that wraps is lined up: centred in the Dynamic Island,
    /// where everything under the post is centred.
    var alignment: TextAlignment = .leading

    private var contextColour: Color { post.stale ? PostPalette.nightSecondary : PostPalette.nightText }

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
    /// Lines the problem may take: two where there is height for them.
    let detailLines: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("Waiting for GPS…")
                .font(.system(size: titleSize, weight: .bold))
                .foregroundStyle(PostPalette.nightText)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            if let problem = post.problem {
                Text(verbatim: problem)
                    .font(.system(size: detailSize, weight: .semibold))
                    .foregroundStyle(PostPalette.warning)
                    .multilineTextAlignment(.leading)
                    .lineLimit(detailLines)
                    .minimumScaleFactor(0.6)
            }
        }
    }
}

/// A symbol for the narrow Dynamic Island slots, where there is no room for
/// words: a warning triangle for a problem, a struck-out location arrow for a
/// post that is no longer current, and a plain location arrow while waiting
/// for the first fix.
private struct IslandGlyph: View {
    let post: LivePost

    var body: some View {
        if let problem = post.problem {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(PostPalette.warning)
                .accessibilityLabel(Text(verbatim: problem))
        } else if post.stale {
            Image(systemName: "location.slash.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(PostPalette.warning)
                .accessibilityLabel(Text("No GPS"))
        } else {
            Image(systemName: "location")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(PostPalette.nightSecondary)
                .accessibilityLabel(Text("Waiting for GPS"))
        }
    }
}

/// The chainage alone, in amber, scaled to fit the narrowest slots. It has no
/// carriageway letter: where there is no room for the chip, which shows
/// whether the letter is confirmed, the letter is left out altogether.
private struct IslandChainage: View {
    let snapshot: PostSnapshot
    /// Stale: the number loses its amber.
    let dimmed: Bool

    var body: some View {
        Text(verbatim: snapshot.km.isEmpty ? snapshot.ref : snapshot.km)
            .font(.system(size: 13, weight: .heavy).monospacedDigit())
            .foregroundStyle(dimmed ? PostPalette.nightSecondary : PostPalette.amberOnDark)
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            // The narrowest slot is a circle 28 pt across. Kept a little
            // clear of its edge, so the first and last digits are never
            // clipped by the curve.
            .padding(.horizontal, 2)
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

/// Lock Screen and banner. Three lines, each the full width of the card: the
/// road and the post, the line under them, and the time. About 136 pt tall,
/// and about 153 at most (a problem long enough to need two lines); iOS may
/// cut off anything over 160.
private struct LiveActivityLockScreen: View {
    let post: LivePost

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let snapshot = post.snapshot {
                HStack(alignment: .center, spacing: 10) {
                    RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 19,
                              style: PostStyle.night, dimmed: post.stale)
                    // The number is given its room first. A long interchange
                    // name wraps inside its badge before the number steps
                    // down a size.
                    FittedPostNumber(snapshot: snapshot, large: 54, medium: 44, small: 34,
                                     style: PostStyle.night, dimmed: post.stale)
                        .layoutPriority(1)
                }
                LiveContext(post: post, snapshot: snapshot, contextSize: 16, problemSize: 15,
                            problemLines: 2)
            } else {
                Text("Marker Post")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(PostPalette.nightSecondary)
                    .lineLimit(1)
                LiveWaiting(post: post, titleSize: 26, detailSize: 15, detailLines: 2)
            }
            LiveTime(post: post, size: 14)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
    }
}

/// CarPlay Dashboard and Apple Watch Smart Stack. Apple's sizes for this
/// family are 240 x 78, 240 x 100 and 170 x 78 pt in CarPlay, and from
/// 152 x 69.5 pt (40 mm) to 198 x 81.5 pt (49 mm) on Apple Watch. There are
/// two layouts, and the first that fits at full size is used.
private struct LiveActivitySmall: View {
    let post: LivePost

    var body: some View {
        Group {
            if let snapshot = post.snapshot {
                ViewThatFits(in: .horizontal) {
                    LiveSmallWide(post: post, snapshot: snapshot)
                    LiveSmallStacked(post: post, snapshot: snapshot)
                }
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    LiveWaiting(post: post, titleSize: 17, detailSize: 12, detailLines: 1)
                    LiveTime(post: post, size: 10)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The lettering here is light whatever the car's or the watch's
        // appearance, so this layout brings its own navy card rather than
        // trusting what the system puts behind it.
        .background(PostPalette.nightSurface)
    }
}

/// 240 pt wide and everything short: road, context and time on the left, the
/// post on the right. It is only used where all of it fits at full size
/// (about 53 pt tall), so nothing in it is ever cut.
private struct LiveSmallWide: View {
    let post: LivePost
    let snapshot: PostSnapshot

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 14,
                          style: PostStyle.night, dimmed: post.stale)
                LiveContext(post: post, snapshot: snapshot, contextSize: 13, problemSize: 12,
                            problemLines: 1)
                LiveTime(post: post, size: 10)
            }
            // The post takes the rest of the width and sits against the
            // right-hand edge.
            PostNumber(snapshot: snapshot, size: 38, style: PostStyle.night, dimmed: post.stale)
                .frame(maxWidth: .infinity, alignment: .trailing)
        }
    }
}

/// Everywhere else in this family (170 pt wide, a watch, a long context, a
/// problem, a time with its day): road and post on one line, then the line
/// under them, then the time, each the full width.
///
/// Three lines need about 65 pt with the post at its larger size. CarPlay
/// (68 pt inside the margins) and the larger watches have that; the smaller
/// watches (59.5 pt on the 40 mm) get the post a size down, so that nothing is
/// squeezed.
private struct LiveSmallStacked: View {
    let post: LivePost
    let snapshot: PostSnapshot

    var body: some View {
        ViewThatFits(in: .vertical) {
            rows(large: 32, medium: 26, small: 22)
            rows(large: 24, medium: 20, small: 17)
        }
    }

    private func rows(large: CGFloat, medium: CGFloat, small: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .center, spacing: 6) {
                RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 14,
                          style: PostStyle.night, dimmed: post.stale)
                FittedPostNumber(snapshot: snapshot, large: large, medium: medium, small: small,
                                 style: PostStyle.night, dimmed: post.stale)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            LiveContext(post: post, snapshot: snapshot, contextSize: 11, problemSize: 11,
                        problemLines: 1)
            LiveTime(post: post, size: 10)
        }
    }
}

// MARK: - Dynamic Island, expanded

/// The road, beside the camera. Before the first fix, a symbol.
private struct IslandLeading: View {
    let post: LivePost

    var body: some View {
        if let snapshot = post.snapshot {
            RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 16,
                      style: PostStyle.night, dimmed: post.stale)
        } else {
            IslandGlyph(post: post)
        }
    }
}

private struct IslandCentre: View {
    let post: LivePost

    var body: some View {
        if let snapshot = post.snapshot {
            FittedPostNumber(snapshot: snapshot, large: 40, medium: 32, small: 26,
                             style: PostStyle.night, dimmed: post.stale)
        } else {
            Text("Waiting for GPS…")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(PostPalette.nightText)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
    }
}

/// Under the post, the full width of the island: the line under the post (or
/// a problem), then the time. Before the first fix: any problem, and when the
/// Live Activity started.
///
/// One line each while there is a post above them: iOS may cut off an island
/// taller than 160 pt, and the time is the bottom line.
private struct IslandBottom: View {
    let post: LivePost

    var body: some View {
        VStack(spacing: 2) {
            if let snapshot = post.snapshot {
                LiveContext(post: post, snapshot: snapshot, contextSize: 15, problemSize: 13,
                            problemLines: 1, alignment: .center)
            } else if let problem = post.problem {
                Text(verbatim: problem)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(PostPalette.warning)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.6)
            }
            LiveTime(post: post, size: 13)
        }
        .frame(maxWidth: .infinity)
    }
}

// MARK: - Dynamic Island, compact and minimal

/// The road, small. A problem takes its place, and so does the symbol for a
/// post that is no longer current: neither is ever hidden in the compact form,
/// and a stale post never differs from a current one in brightness alone.
private struct IslandCompactLeading: View {
    let post: LivePost

    var body: some View {
        if let snapshot = post.snapshot, post.problem == nil, !post.stale {
            if RoadBadge.hasLongName(roadClass: snapshot.roadClass) {
                // An interchange name wraps and shrinks inside its own badge,
                // and must not push the post off the other side.
                RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 12,
                          style: PostStyle.night)
                    .frame(maxWidth: 62, alignment: .leading)
            } else {
                // A smaller badge for when iOS gives this slot very little
                // width, so that "A3(M)" is not cut short there.
                ViewThatFits(in: .horizontal) {
                    RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 12,
                              style: PostStyle.night)
                    RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 9,
                              style: PostStyle.night)
                }
            }
        } else {
            IslandGlyph(post: post)
        }
    }
}

/// The chainage and the carriageway chip (filled when confirmed, outlined
/// when chosen by position only), or "GPS…" before the first fix.
///
/// iOS sometimes gives this slot very little width (the phone on its side, or
/// a second Live Activity sharing the island). So the post is offered at two
/// sizes, and last of all as the chainage alone, which fits a 28 pt slot. A
/// chainage must never be cut off part of the way through.
///
/// ViewThatFits only takes a choice whose full width fits: it makes no
/// allowance for the number shrinking. So each size is offered twice. First
/// as it is. Then counted as narrower than it is (its `idealWidth`), so that
/// it is taken in any slot of that width or more and drawn across the whole
/// slot with its number shrunk to fit. Without the second of each, a post a
/// point too wide for the slot would drop a size, or lose its carriageway
/// letter altogether, in the ordinary island. With them, every slot of 40 pt
/// or more shows the letter.
///
/// The plain choice stays first. Asked how wide it would like to be, with no
/// width on offer, ViewThatFits answers for its first choice, and that
/// answer has to be the real width of the post.
private struct IslandCompactTrailing: View {
    let post: LivePost

    var body: some View {
        if let snapshot = post.snapshot {
            ViewThatFits(in: .horizontal) {
                number(snapshot, size: 15, chip: 16)
                // From 46 pt. In the usual 52 pt slot a chainage of 100.0 or
                // more comes out at about four fifths of its size.
                number(snapshot, size: 15, chip: 16)
                    .frame(idealWidth: 46)
                number(snapshot, size: 12, chip: 14)
                // From 40 pt. In less than that the number would be too
                // small to read beside its chip.
                number(snapshot, size: 12, chip: 14)
                    .frame(idealWidth: 40)
                IslandChainage(snapshot: snapshot, dimmed: post.stale)
            }
        } else {
            Text("GPS…")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(PostPalette.nightSecondary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
    }

    /// The post with its chip at one size, in the island's colours.
    private func number(_ snapshot: PostSnapshot, size: CGFloat, chip: CGFloat) -> PostNumber {
        PostNumber(snapshot: snapshot, size: size, style: PostStyle.night,
                   dimmed: post.stale, chipHeight: chip)
    }
}

/// The smallest form: the chainage alone, in amber. There is no room for a
/// time or for words here, so a post that is no longer current is not shown
/// at all: the struck-out location symbol takes its place.
private struct IslandMinimal: View {
    let post: LivePost

    var body: some View {
        if let snapshot = post.snapshot, !post.stale {
            IslandChainage(snapshot: snapshot, dimmed: false)
        } else {
            IslandGlyph(post: post)
        }
    }
}
