import SwiftUI
import WidgetKit

// The "last known post" widget for the Home Screen, the Lock Screen, StandBy
// and CarPlay.
//
// A widget is NOT a live surface: iOS redraws it when it chooses to, perhaps a
// few dozen times a day. So it only ever shows the last post the app saved,
// with the time of the fix it came from, and it never says or implies "live",
// whether or not live tracking is running. The live surface is the Live
// Activity (MarkerPostLiveActivity.swift).

// MARK: - Timeline

struct LastPostEntry: TimelineEntry {
    /// When this entry starts being shown. The time of the post is read
    /// against it: a fix from an earlier day is written with its day.
    let date: Date
    /// Nil until the app has saved a post.
    let snapshot: PostSnapshot?

    /// True when the fix is not from the day this entry is shown on, so its
    /// time carries the day as well as the clock time ("21 Nov, 14:32").
    var showsDay: Bool {
        guard let snapshot else { return false }
        return SurfaceText.isAnotherDay(snapshot.fixTime, now: date)
    }
}

struct LastPostProvider: TimelineProvider {
    /// Sample content. iOS shows the placeholder greyed out, and the snapshot
    /// in the widget gallery, so the sample is never mistaken for a real post.
    /// Its fix is put at 14:32 today, so the gallery shows a plain
    /// "Last updated 14:32" (as the Android widget's preview does).
    private static var sampleEntry: LastPostEntry {
        let now = Date()
        var sample = PostSnapshot.sample
        sample.fixTime = Calendar.current.date(bySettingHour: 14, minute: 32, second: 0, of: now) ?? now
        return LastPostEntry(date: now, snapshot: sample)
    }

    /// What the app last saved, as it should be shown at `date`.
    private static func storedEntry(at date: Date) -> LastPostEntry {
        LastPostEntry(date: date, snapshot: SharedStore.read())
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
        // that changes without the app is the calendar: at midnight the same
        // post is shown again with its day added, so that yesterday's
        // "Last updated 14:32" cannot be read as this afternoon's; and at the
        // new year with its year added. Those are the two entries booked here.
        if let snapshot = current.snapshot {
            var last = now
            for _ in 0..<2 {
                guard let change = SurfaceText.nextChange(snapshot.fixTime, now: last) else { break }
                // WidgetKit wants entries at least about five minutes apart.
                last = max(change, last.addingTimeInterval(300))
                entries.append(LastPostEntry(date: last, snapshot: snapshot))
            }
        }
        completion(Timeline(entries: entries, policy: .never))
    }
}

// MARK: - Widget

struct LastPostWidget: Widget {
    /// The widget's permanent name. It must not change: iOS knows the widgets
    /// people have already placed by it. (The app reloads all of its widgets
    /// together when it saves a post, so nothing else has to match it.)
    let kind: String = "MarkerPostLastPost"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: LastPostProvider()) { entry in
            // No widgetURL and no controls: a tap just opens the app, and
            // nothing here needs touching while driving.
            LastPostWidgetView(entry: entry)
        }
        .configurationDisplayName("Last known marker post")
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

    /// The colours follow the way iOS is drawing the widget. Where it
    /// recolours everything (a tinted or clear Home Screen, the Lock Screen,
    /// StandBy at night) they are the system's own. In full colour in Dark
    /// Mode they are the app's night colours: light on dark, so they still
    /// read in StandBy and CarPlay, where iOS takes away the navy background
    /// they were chosen for. In full colour by day they are the system's
    /// text colour, with the app's own grey and amber.
    private var style: PostStyle {
        PostStyle.widget(dark: colorScheme == .dark, fullColour: renderingMode == .fullColor)
    }

    var body: some View {
        // The widget's own background, which iOS shows on the Home Screen in
        // full colour and removes everywhere else: the app's navy when the
        // phone is dark, and the system's light fill by day.
        if colorScheme == .dark && renderingMode == .fullColor {
            families.containerBackground(PostPalette.nightSurface, for: .widget)
        } else {
            families.containerBackground(.fill.tertiary, for: .widget)
        }
    }

    @ViewBuilder private var families: some View {
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

/// The line under a post ("J4 – J5", "A303 jct · 1.24 km from post"). Hidden
/// when the records do not say.
///
/// It is shown word for word. Where there is height it may take two lines;
/// it shrinks a little to fit; and if it still cannot fit it is cut at the
/// end. It is never shortened here.
private struct LastPostContext: View {
    let snapshot: PostSnapshot
    let size: CGFloat
    let style: PostStyle
    var lines: Int = 1

    var body: some View {
        if !snapshot.context.isEmpty {
            Text(verbatim: snapshot.context)
                .font(.system(size: size, weight: .semibold))
                .foregroundStyle(snapshot.stale ? style.secondary : style.primary)
                .multilineTextAlignment(.leading)
                .lineLimit(lines)
                .minimumScaleFactor(lines > 1 ? 0.75 : 0.6)
        }
    }
}

/// "Last updated 14:32", or "No GPS since 14:32" (made to stand out) when
/// stale. Never "Live": a widget is redrawn when iOS chooses to.
///
/// The line always has the full width of its place and shrinks to fit, so
/// the time is never cut. With its day in front ("Last updated 21 Nov,
/// 14:32") it is too long for one readable line of a Home Screen widget, so
/// there the words go on a line of their own above the time.
private struct LastPostTime: View {
    let entry: LastPostEntry
    let snapshot: PostSnapshot
    let size: CGFloat
    let style: PostStyle
    /// True on the Home Screen widgets, which have the height for two lines.
    var wraps: Bool = false

    private var colour: Color { snapshot.stale ? style.primary : style.secondary }
    private var onTwoLines: Bool { wraps && entry.showsDay }

    private var text: String {
        let words = SurfaceText.widgetWords(stale: snapshot.stale)
        let time = SurfaceText.time(snapshot.fixTime, now: entry.date)
        return onTwoLines ? "\(words)\n\(time)" : "\(words) \(time)"
    }

    var body: some View {
        PostTimeLine(text: text, size: size, colour: colour, emphasised: snapshot.stale,
                     lines: onTwoLines ? 2 : 1)
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
            // whatever height is left. The smallest phone's widget has 116 pt
            // of height inside its margins and these need about 111: the road
            // (21), the post (43) and three lines of 12 pt text. Those three
            // are two for the context and one for the time; or, when the time
            // carries its day and takes two, one for the context.
            VStack(alignment: .leading, spacing: 2) {
                RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 14,
                          style: style, dimmed: snapshot.stale)
                VStack(alignment: .leading, spacing: 0) {
                    FittedPostNumber(snapshot: snapshot, large: 36, medium: 30, small: 26,
                                     style: style, dimmed: snapshot.stale, accentable: true)
                    LastPostContext(snapshot: snapshot, size: 12, style: style,
                                    lines: entry.showsDay ? 1 : 2)
                }
                .frame(maxHeight: .infinity, alignment: .leading)
                LastPostTime(entry: entry, snapshot: snapshot, size: 12, style: style, wraps: true)
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
                // Left: road at the top, the post at the bottom with up to two
                // lines of context under it (about 111 pt of the 116 there are).
                VStack(alignment: .leading, spacing: 2) {
                    RoadBadge(road: snapshot.road, roadClass: snapshot.roadClass, fontSize: 17,
                              style: style, dimmed: snapshot.stale)
                    VStack(alignment: .leading, spacing: 0) {
                        FittedPostNumber(snapshot: snapshot, large: 42, medium: 36, small: 30,
                                         style: style, dimmed: snapshot.stale, accentable: true)
                        LastPostContext(snapshot: snapshot, size: 14, style: style, lines: 2)
                    }
                    .frame(maxHeight: .infinity, alignment: .bottomLeading)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)

                // Right: when it was updated, and that it is not live.
                VStack(alignment: .leading, spacing: 6) {
                    LastPostTime(entry: entry, snapshot: snapshot, size: 13, style: style, wraps: true)
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
                // One line each: there is no height here for more.
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
/// the fix is not from today). There is no room for more words, so a post that
/// is no longer current gives up its road line to say "No GPS": on the Lock
/// Screen everything is one tint, and dimming alone would not show.
private struct LastPostCircular: View {
    let entry: LastPostEntry
    let style: PostStyle

    /// "14:32", or "21 Nov" for a fix that is not from today.
    private func when(_ snapshot: PostSnapshot) -> String {
        if entry.showsDay {
            return SurfaceText.day(snapshot.fixTime, now: entry.date)
        }
        return SurfaceText.clock(snapshot.fixTime)
    }

    /// How far the first and last lines are kept in from the sides, on top of
    /// the 5 pt that all three lines have. The circle is narrower where they
    /// sit than it is across the middle, so a line of the full width would
    /// run over its edge and lose its ends. Kept in, a long line shrinks to
    /// fit instead: the first line of an interchange name, or a day with its
    /// year ("31 Dec 2026"). The usual ones ("M27", "No GPS", "14:32",
    /// "21 Nov") are short enough to stay at their full size.
    private var edgeInset: CGFloat { 7 }

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            if let snapshot = entry.snapshot {
                VStack(spacing: 0) {
                    if snapshot.stale {
                        Text("No GPS")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(style.primary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                            .padding(.horizontal, edgeInset)
                    } else {
                        Text(verbatim: snapshot.road)
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(style.primary)
                            .multilineTextAlignment(.center)
                            .lineLimit(2)
                            .minimumScaleFactor(0.5)
                            .padding(.horizontal, edgeInset)
                    }
                    FittedPostNumber(snapshot: snapshot, large: 19, medium: 16, small: 13,
                                     style: style, dimmed: snapshot.stale, accentable: true)
                    // Brighter and a little heavier when it is the "since" of
                    // a post that is no longer current.
                    PostTimeLine(text: when(snapshot), size: 10,
                                 colour: snapshot.stale ? style.primary : style.secondary,
                                 emphasised: snapshot.stale)
                        .padding(.horizontal, edgeInset)
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

/// The single line of text beside the date on the Lock Screen. It can print
/// text and nothing else, and iOS cuts off the end of a line that is too long.
///
/// So the time comes first and the post after it ("14:32 · M27 17.4 A"), a
/// post that is no longer current starts with "No GPS", and a carriageway
/// letter that is not confirmed is left out, because this line cannot draw the
/// outlined letter. The wordings are SurfaceText's, fullest first, and the
/// first that fits is shown.
private struct LastPostInline: View {
    let entry: LastPostEntry

    var body: some View {
        if let snapshot = entry.snapshot {
            LastPostInlineLines(lines: SurfaceText.oneLiners(snapshot, now: entry.date))
        } else {
            Text("No post yet")
        }
    }
}

private struct LastPostInlineLines: View {
    /// Fullest first. SurfaceText gives at most five.
    let lines: [String]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            Text(verbatim: line(0))
            Text(verbatim: line(1))
            Text(verbatim: line(2))
            Text(verbatim: line(3))
            Text(verbatim: line(4))
        }
    }

    /// The line at this place in the list; past its end, the last one again.
    private func line(_ index: Int) -> String {
        if index < lines.count {
            return lines[index]
        }
        return lines.last ?? ""
    }
}
