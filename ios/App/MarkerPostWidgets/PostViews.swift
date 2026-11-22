import SwiftUI
import UIKit
import WidgetKit

// The small building blocks every glanceable surface is made of: the road
// badge, the carriageway chip, the post number and the time line. The Live
// Activity and the "last known post" widget both use these, so a post looks
// the same on the Lock Screen, in the Dynamic Island, on CarPlay and on the
// Home Screen as it does in the app (styles.css is the reference).
//
// Every string shown here comes straight from the snapshot. Nothing about a
// post is reworded or rebuilt in Swift.

// MARK: - Colours

/// The app's fixed colours. Road colours are used only on road badges; amber
/// is the one accent.
enum PostPalette {
    /// Motorway badge.
    static let motorway = rgb(0x0B, 0x62, 0xB8)
    /// A-road badge and its yellow lettering.
    static let aRoad = rgb(0x00, 0x69, 0x3A)
    static let aRoadText = rgb(0xFF, 0xD1, 0x00)
    /// Amber on dark surfaces, and the slightly deeper amber used on light ones.
    static let amberOnDark = rgb(0xFF, 0xC2, 0x3D)
    static let amberOnLight = rgb(0xFF, 0xB8, 0x1C)
    /// Amber lettering needs to be darker than the chip amber to be readable on a light surface.
    static let amberTextOnLight = rgb(0x8F, 0x56, 0x00)
    /// The letter inside a filled amber chip.
    static let chipLetter = rgb(0x1A, 0x12, 0x00)
    /// Warning text on dark surfaces.
    static let warning = rgb(0xFF, 0xD9, 0x8A)
    /// The dark card the Live Activity is drawn on, and its secondary text.
    static let card = rgb(0x1C, 0x1C, 0x1E)
    static let secondaryOnCard = rgb(0xA1, 0xA1, 0xAA)

    private static func rgb(_ red: Int, _ green: Int, _ blue: Int) -> Color {
        Color(red: Double(red) / 255.0, green: Double(green) / 255.0, blue: Double(blue) / 255.0)
    }
}

/// The colours one surface draws with.
///
/// The Live Activity always sits on its own dark card, so it uses fixed
/// colours. Widgets sit on whatever the system gives them (light, dark, a
/// tinted or clear Home Screen, the Lock Screen), so they use the system's
/// own text colours and never depend on the background for contrast.
struct PostStyle {
    var primary: Color
    var secondary: Color
    /// Fill of a confirmed carriageway chip and outline of an unconfirmed one.
    var amber: Color
    /// The letter inside an unconfirmed (outlined) chip.
    var outlineLetter: Color
    /// Badge fill for roads that are neither motorways nor A-roads.
    var neutralFill: Color
    /// True where the system recolours the whole widget in one tint (tinted or
    /// clear Home Screen, Lock Screen, StandBy at night). A solid badge with
    /// lettering on top would become one flat block there, so fills are drawn
    /// see-through and lettering solid: the difference survives any tint.
    var flat: Bool

    /// The Live Activity's dark card and the Dynamic Island.
    static let darkCard = PostStyle(
        primary: Color.white,
        secondary: PostPalette.secondaryOnCard,
        amber: PostPalette.amberOnDark,
        outlineLetter: PostPalette.amberOnDark,
        neutralFill: Color.white.opacity(0.16),
        flat: false)

    /// A widget, drawn on the system's own background.
    static func widget(dark: Bool, fullColour: Bool) -> PostStyle {
        PostStyle(
            primary: Color.primary,
            secondary: Color.secondary,
            amber: dark ? PostPalette.amberOnDark : PostPalette.amberOnLight,
            outlineLetter: dark ? PostPalette.amberOnDark : PostPalette.amberTextOnLight,
            neutralFill: Color(uiColor: UIColor.secondarySystemFill),
            flat: !fullColour)
    }
}

// MARK: - Road badge

/// The road name in a rounded rectangle: blue for a motorway, green with
/// yellow lettering for an A-road, neutral for anything else.
struct RoadBadge: View {
    let road: String
    /// "M", "A" or "O" (PostSnapshot.roadClass). Chooses the colours only.
    let roadClass: String
    /// Size of the lettering for a motorway or A-road. The badge is about one
    /// and a half times as tall.
    let fontSize: CGFloat
    let style: PostStyle
    /// Stale: the badge is shown at 55% so it cannot be read as current.
    var dimmed: Bool = false

    /// Interchange names are long ("Chilworth · M3 / M27"), so they are set
    /// smaller and a little lighter inside the same height of badge.
    private var isOther: Bool { roadClass != "M" && roadClass != "A" }
    private var textSize: CGFloat { isOther ? fontSize * 0.62 : fontSize }
    private var textWeight: Font.Weight { isOther ? .bold : .heavy }

    private var fillColour: Color {
        if style.flat { return style.primary.opacity(0.22) }
        if roadClass == "M" { return PostPalette.motorway }
        if roadClass == "A" { return PostPalette.aRoad }
        return style.neutralFill
    }

    private var textColour: Color {
        if style.flat { return style.primary }
        if roadClass == "M" { return Color.white }
        if roadClass == "A" { return PostPalette.aRoadText }
        return style.primary
    }

    var body: some View {
        // No road name: draw nothing rather than an empty coloured block.
        if !road.isEmpty {
            Text(verbatim: road)
                .font(.system(size: textSize, weight: textWeight))
                .foregroundStyle(textColour)
                .lineLimit(1)
                .minimumScaleFactor(0.5)
                .padding(.horizontal, fontSize * 0.42)
                .frame(minHeight: fontSize * 1.5)
                .background(fillColour, in: RoundedRectangle(cornerRadius: fontSize * 0.32, style: .continuous))
                .opacity(dimmed ? 0.55 : 1)
        }
    }
}

// MARK: - Carriageway chip

/// The carriageway letter (A, B, …) in an amber chip.
///
/// Filled means the direction of travel chose the carriageway. Outlined with
/// no fill means the post was chosen by position only and the carriageway
/// should be checked. The letter is always the recorded letter, never a
/// compass direction.
struct CarriagewayChip: View {
    let letter: String
    let confirmed: Bool
    /// Height of the chip. Everything else is in proportion to it.
    let height: CGFloat
    let style: PostStyle
    /// Stale: the chip is shown at 55%.
    var dimmed: Bool = false

    private var shape: RoundedRectangle {
        RoundedRectangle(cornerRadius: height * 0.2, style: .continuous)
    }

    private var fillColour: Color {
        if !confirmed { return Color.clear }
        return style.flat ? style.primary.opacity(0.28) : style.amber
    }

    private var outlineColour: Color {
        if confirmed { return Color.clear }
        return style.flat ? style.primary : style.amber
    }

    private var letterColour: Color {
        if style.flat { return style.primary }
        return confirmed ? PostPalette.chipLetter : style.outlineLetter
    }

    var body: some View {
        Text(verbatim: letter)
            .font(.system(size: height * 0.72, weight: .heavy))
            .foregroundStyle(letterColour)
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .frame(width: height * 0.92, height: height)
            .background(fillColour, in: shape)
            .overlay {
                // Never thinner than a point and a half, or the outline that
                // says "not confirmed" would vanish at Dynamic Island sizes.
                shape.strokeBorder(outlineColour, lineWidth: max(1.5, height * 0.045))
            }
            .opacity(dimmed ? 0.55 : 1)
    }
}

// MARK: - Post number

/// The post itself: the chainage in the heaviest weight with the carriageway
/// chip beside it, or the recorded reference word for word when it is not in
/// the usual form (the snapshot then has an empty `km`).
struct PostNumber: View {
    let snapshot: PostSnapshot
    /// Font size of the chainage. 64 for a hero, 13 for a compact slot.
    let size: CGFloat
    let style: PostStyle
    /// Stale: the number goes to the secondary colour and the chip to 55%.
    var dimmed: Bool = false
    /// Widgets mark the number as accent content, so a tinted Home Screen
    /// colours the post rather than the furniture around it.
    var accentable: Bool = false
    /// Height of the chip. Left out, it is in the app's proportion to the
    /// number. The Dynamic Island's compact slot passes a taller one, because
    /// at 15 pt the proportional chip would be too small to read.
    var chipHeight: CGFloat? = nil

    private var numberColour: Color { dimmed ? style.secondary : style.primary }
    private var resolvedChipHeight: CGFloat { chipHeight ?? size * 0.72 }
    /// A little smaller than a chainage because a reference is longer, but
    /// never below 13 pt (or the slot's own size, if that is smaller still).
    private var verbatimSize: CGFloat { max(size * 0.62, min(size, 13)) }

    var body: some View {
        if snapshot.km.isEmpty {
            // An unusual reference is shown exactly as recorded.
            Text(verbatim: snapshot.ref)
                .font(.system(size: verbatimSize, weight: .black).monospacedDigit())
                .tracking(-verbatimSize * 0.02)
                .foregroundStyle(numberColour)
                .lineLimit(1)
                .minimumScaleFactor(0.4)
                .widgetAccentable(accentable)
        } else {
            HStack(alignment: .center, spacing: size * 0.12) {
                Text(verbatim: snapshot.km)
                    .font(.system(size: size, weight: .black).monospacedDigit())
                    .tracking(-size * 0.035)
                    .foregroundStyle(numberColour)
                    .lineLimit(1)
                    .minimumScaleFactor(0.4)
                    .widgetAccentable(accentable)
                if !snapshot.letter.isEmpty {
                    CarriagewayChip(letter: snapshot.letter, confirmed: snapshot.confirmed,
                                    height: resolvedChipHeight, style: style, dimmed: dimmed)
                }
            }
        }
    }
}

/// The post number at the largest of three sizes that fits the width it is
/// given, so the number and its chip shrink together as one unit. If even the
/// smallest is too wide, its text scales down further rather than truncating.
struct FittedPostNumber: View {
    let snapshot: PostSnapshot
    let large: CGFloat
    let medium: CGFloat
    let small: CGFloat
    let style: PostStyle
    var dimmed: Bool = false
    var accentable: Bool = false

    var body: some View {
        ViewThatFits(in: .horizontal) {
            PostNumber(snapshot: snapshot, size: large, style: style, dimmed: dimmed, accentable: accentable)
            PostNumber(snapshot: snapshot, size: medium, style: style, dimmed: dimmed, accentable: accentable)
            PostNumber(snapshot: snapshot, size: small, style: style, dimmed: dimmed, accentable: accentable)
        }
    }
}

// MARK: - Time line

/// The time every surface must carry. All of these show the time of the GPS
/// fix the post came from, as a clock time, so an old post reads as old
/// however long the surface has been left on screen.
enum PostTime {
    /// Live surfaces: "Updated 14:32", or "No GPS since 14:32" when stale.
    static func live(_ snapshot: PostSnapshot, stale: Bool) -> Text {
        if stale {
            return Text("No GPS since \(snapshot.fixTime, style: .time)")
        }
        return Text("Updated \(snapshot.fixTime, style: .time)")
    }

    /// Widgets: "Last updated 14:32", or "No GPS since 14:32" when stale.
    /// Widgets never say "updated" on its own, which could read as live.
    ///
    /// `showsDay` adds the day ("Last updated 21 Nov, 14:32") for a fix that
    /// is not from today: a bare clock time from yesterday afternoon would
    /// look a few minutes old this afternoon.
    static func widget(_ snapshot: PostSnapshot, showsDay: Bool) -> Text {
        if showsDay {
            let day = PostTime.day(snapshot.fixTime)
            if snapshot.stale {
                return Text("No GPS since \(day), \(snapshot.fixTime, style: .time)")
            }
            return Text("Last updated \(day), \(snapshot.fixTime, style: .time)")
        }
        if snapshot.stale {
            return Text("No GPS since \(snapshot.fixTime, style: .time)")
        }
        return Text("Last updated \(snapshot.fixTime, style: .time)")
    }

    /// The day of a fix, in the phone's own format: "21 Nov".
    static func day(_ date: Date) -> String {
        date.formatted(Date.FormatStyle().day().month(.abbreviated))
    }
}

/// The time line as it is drawn: one line that shrinks rather than truncates.
struct PostTimeLine: View {
    /// From `PostTime`, or any other line that carries a time.
    let text: Text
    let size: CGFloat
    let colour: Color
    /// True when the line is the stale warning rather than a routine time, so
    /// it is set a little heavier.
    var emphasised: Bool = false

    private var weight: Font.Weight { emphasised ? .semibold : .medium }

    var body: some View {
        text
            .font(.system(size: size, weight: weight))
            .foregroundStyle(colour)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
    }
}
