import SwiftUI
import WidgetKit

// The "last known post" widget for the Home Screen, the Lock Screen, StandBy
// and CarPlay.
//
// A widget is NOT a live surface: iOS redraws it when it chooses to, perhaps a
// few dozen times a day. So it only ever shows the last post the app saved,
// with the time of the fix it came from, and it never says or implies "live".
// The live surface is the Live Activity (MarkerPostLiveActivity.swift).

// MARK: - Timeline

struct LastPostEntry: TimelineEntry {
    let date: Date
    /// Nil until the app has saved a post.
    let snapshot: PostSnapshot?
    /// True when the fix is not from the day this entry is shown on, so the
    /// time line must carry the day as well as the clock time.
    let showsDay: Bool
}

struct LastPostProvider: TimelineProvider {
    /// Sample content. iOS shows the placeholder greyed out, and the snapshot
    /// in the widget gallery, so the sample is never mistaken for a real post.
    private static var sampleEntry: LastPostEntry {
        LastPostEntry(date: Date(), snapshot: PostSnapshot.sample, showsDay: false)
    }

    /// What the app last saved, as it should be shown at `date`.
    private static func storedEntry(at date: Date) -> LastPostEntry {
        let snapshot = SharedStore.read()
        var showsDay = false
        if let snapshot {
            showsDay = !Calendar.current.isDate(snapshot.fixTime, inSameDayAs: date)
        }
        return LastPostEntry(date: date, snapshot: snapshot, showsDay: showsDay)
    }

    func placeholder(in context: Context) -> LastPostEntry {
        LastPostProvider.sampleEntry
    }

    func getSnapshot(in context: Context, completion: @escaping (LastPostEntry) -> Void) {
        // iOS also asks for a "snapshot" when it needs something to show for a
        // moment on a real Home Screen. An invented post must never appear
        // there, so the sample is used only for the gallery.
        if context.isPreview {
            completion(LastPostProvider.sampleEntry)
        } else {
            completion(LastPostProvider.storedEntry(at: Date()))
        }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LastPostEntry>) -> Void) {
        let now = Date()
        let current = LastPostProvider.storedEntry(at: now)
        var entries = [current]

        // The app reloads the widget whenever it saves a post, so the timeline
        // never asks for a refresh of its own (policy .never). The one thing
        // that changes without the app is the calendar day: at midnight the
        // same post is shown again with its day added, so that yesterday's
        // "Last updated 14:32" cannot be read as this afternoon's.
        if let snapshot = current.snapshot, !current.showsDay {
            let calendar = Calendar.current
            if let midnight = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)) {
                // WidgetKit wants entries at least about five minutes apart.
                let boundary = max(midnight, now.addingTimeInterval(300))
                entries.append(LastPostEntry(date: boundary, snapshot: snapshot, showsDay: true))
            }
        }
        completion(Timeline(entries: entries, policy: .never))
    }
}

// MARK: - Widget

struct LastPostWidget: Widget {
    /// The app reloads the widget by this name (WidgetCenter.reloadTimelines(ofKind:)).
    let kind: String = "MarkerPostLastPost"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LastPostProvider()) { entry in
            // No widgetURL and no controls: a tap just opens the app, and
            // nothing here needs touching while driving.
            LastPostWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Nearest marker post")
        .description("The last marker post the app recorded, with the time it was updated.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline, .accessoryCircular])
    }
}

// MARK: - Views

struct LastPostWidgetView: View {
    @Environment(\.widgetFamily) private var family
    @Environment(\.widgetRenderingMode) private var renderingMode
    @Environment(\.colorScheme) private var colorScheme

    let entry: LastPostEntry

    /// StandBy, CarPlay and tinted or clear Home Screens take the background
    /// away or recolour everything, so the colours come from the system and
    /// the rendering mode, never from an assumption about what is behind.
    private var style: PostStyle {
        PostStyle.widget(dark: colorScheme == .dark, fullColour: renderingMode == .fullColor)
    }

    var body: some View {
        switch family {
        case .accessoryInline:
            LastPostInline(entry: entry)
        case .accessoryCircular:
            LastPostCircular(entry: entry, style: style)
        case .accessoryRectangular:
            LastPostRectangular(entry: entry, style: style)
        case .systemMedium:
            LastPostMedium(entry: entry, style: style)
        default:
            // systemSmall, which is also what StandBy and CarPlay show.
            LastPostSmall(entry: entry, style: style)
        }
    }
}

/// The context line under a post ("J4 – J5"). Hidden when the records do not say.
private struct LastPostContext: View {
    let snapshot: PostSnapshot
    let size: CGFloat
    let style: PostStyle

    var body: some View {
        if !snapshot.context.isEmpty {
            Text(verbatim: snapshot.context)
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(snapshot.stale ? style.secondary : style.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
    }
}

/// "Last updated 14:32", or "No GPS since 14:32" (made to stand out) when stale.
private struct LastPostTime: View {
    let entry: LastPostEntry
    let snapshot: PostSnapshot
    let size: CGFloat
    let style: PostStyle

    private var colour: Color { snapshot.stale ? style.primary : style.secondary }

    var body: some View {
        PostTimeLine(text: PostTime.widget(snapshot, showsDay: entry.showsDay),
                     size: size, colour: colour, emphasised: snapshot.stale)
    }
}

/// Shown until the app has saved its first post.
private struct LastPostEmpty: View {
    let style: PostStyle
    let titleSize: CGFloat
    let hintSize: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text("No post yet")
                .font(.system(size: titleSize, weight: .bold))
                .foregroundStyle(style.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text("Open Marker Post")
                .font(.system(size: hintSize, weight: .medium))
                .foregroundStyle(style.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

/// Home Screen small. StandBy and CarPlay show this one too.
private struct LastPostSmall: View {
    let entry: LastPostEntry
    let style: PostStyle

    var body: some View {
        if let snapshot = entry.snapshot {
            // Road at the top, time at the bottom, the post in the middle of
            // whatever height is left. Sizes chosen so the four lines fit the
            // smallest phone's widget (116 pt of height inside the margins).
            VStack(alignment: .leading, spacing: 2) {
                RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 15,
                          style: style, dimmed: snapshot.stale)
                VStack(alignment: .leading, spacing: 0) {
                    FittedPostNumber(snapshot: snapshot, large: 40, medium: 34, small: 28,
                                     style: style, dimmed: snapshot.stale, accentable: true)
                    LastPostContext(snapshot: snapshot, size: 14, style: style)
                }
                .frame(maxHeight: .infinity, alignment: .leading)
                LastPostTime(entry: entry, snapshot: snapshot, size: 12, style: style)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        } else {
            LastPostEmpty(style: style, titleSize: 20, hintSize: 14)
        }
    }
}

/// Home Screen medium: the post on the left, and room on the right to say
/// plainly that a widget is not live.
private struct LastPostMedium: View {
    let entry: LastPostEntry
    let style: PostStyle

    var body: some View {
        if let snapshot = entry.snapshot {
            HStack(alignment: .top, spacing: 12) {
                // Left: road at the top, the post at the bottom.
                VStack(alignment: .leading, spacing: 2) {
                    RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 17,
                              style: style, dimmed: snapshot.stale)
                    VStack(alignment: .leading, spacing: 0) {
                        FittedPostNumber(snapshot: snapshot, large: 46, medium: 38, small: 30,
                                         style: style, dimmed: snapshot.stale, accentable: true)
                        LastPostContext(snapshot: snapshot, size: 16, style: style)
                    }
                    .frame(maxHeight: .infinity, alignment: .bottomLeading)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

                // Right: when it was updated, and that it is not live.
                VStack(alignment: .leading, spacing: 6) {
                    LastPostTime(entry: entry, snapshot: snapshot, size: 13, style: style)
                    Text("Not live. Widgets refresh occasionally. Start live tracking in the app for a live post.")
                        .font(.system(size: 11))
                        .foregroundStyle(style.secondary)
                        .lineLimit(6)
                        .minimumScaleFactor(0.8)
                }
                .frame(width: 128, alignment: .leading)
                .frame(maxHeight: .infinity, alignment: .top)
            }
        } else {
            LastPostEmpty(style: style, titleSize: 22, hintSize: 15)
        }
    }
}

/// Lock Screen rectangle. The system draws it in one tint, so the style is
/// "flat": see-through fills and solid lettering.
private struct LastPostRectangular: View {
    let entry: LastPostEntry
    let style: PostStyle

    var body: some View {
        if let snapshot = entry.snapshot {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center, spacing: 6) {
                    RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 12,
                              style: style, dimmed: snapshot.stale)
                    FittedPostNumber(snapshot: snapshot, large: 26, medium: 22, small: 18,
                                     style: style, dimmed: snapshot.stale, accentable: true)
                }
                LastPostContext(snapshot: snapshot, size: 12, style: style)
                LastPostTime(entry: entry, snapshot: snapshot, size: 11, style: style)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            LastPostEmpty(style: style, titleSize: 15, hintSize: 12)
        }
    }
}

/// Lock Screen circle: road, post and the time of the fix (or its day, when
/// the fix is not from today). There is no room for more words.
private struct LastPostCircular: View {
    let entry: LastPostEntry
    let style: PostStyle

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            if let snapshot = entry.snapshot {
                VStack(spacing: 0) {
                    Text(verbatim: snapshot.road)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(snapshot.stale ? style.secondary : style.primary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.5)
                    FittedPostNumber(snapshot: snapshot, large: 19, medium: 16, small: 13,
                                     style: style, dimmed: snapshot.stale, accentable: true)
                    if entry.showsDay {
                        Text(verbatim: PostTime.day(snapshot.fixTime))
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(style.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                    } else {
                        Text(snapshot.fixTime, style: .time)
                            .font(.system(size: 10, weight: .medium))
                            .foregroundStyle(style.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                    }
                }
                .padding(.horizontal, 5)
            } else {
                Text("No post yet")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(style.primary)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .minimumScaleFactor(0.6)
                    .padding(6)
            }
        }
    }
}

/// The single line of text beside the date on the Lock Screen. Text only, so
/// the post is the snapshot's own one-line form followed by the time of the fix.
private struct LastPostInline: View {
    let entry: LastPostEntry

    var body: some View {
        if let snapshot = entry.snapshot {
            if entry.showsDay {
                Text("\(snapshot.oneLine) on \(PostTime.day(snapshot.fixTime)), \(snapshot.fixTime, style: .time)")
            } else {
                Text("\(snapshot.oneLine) at \(snapshot.fixTime, style: .time)")
            }
        } else {
            Text("No post yet")
        }
    }
}
