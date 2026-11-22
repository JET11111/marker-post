# Design rules

The look is meant to be a quiet instrument: calm, spacious, obvious. Think of the system apps on the phone, not of a dashboard. This page is the short version of the style guide, for anyone changing the interface later. The values live in one place, the top of `styles.css`; the map's colours are in `map-style.js`.

## Principles

1. **The post is the hero.** Road, post number, carriageway letter and junction section must be readable at arm's length in one glance. Nothing competes with them.
2. **One accent.** Amber marks the thing you act on or the answer you came for: the carriageway letter, the primary button, the selected tab. Nothing else is amber.
3. **Road colours only on road badges.** Motorway blue and A-road green with yellow text appear on the badge and on the map's network, where they mean what they mean on a road sign. They are never decoration.
4. **Depth is restrained.** Flat surfaces, one soft shadow for things that float over the map, no gradients, no frosted glass, no ornament.
5. **Motion is quick and quiet.** Sheets and tab changes take about a fifth of a second and ease out. Nothing bounces, pulses or loops. With "reduce motion" on, they do not animate at all.
6. **Honest before tidy.** Unknown, unverified, straight-line and stale are always said in words. A caveat is never removed to make a screen look cleaner. See the README.
7. **Night is the main case.** Dark mode is true black behind near-black cards, with slightly softened white text. Nothing flashes white: the launch screen, the page and the map all start in the right theme.

## Colour

Light and dark follow the phone. The user can force either in Settings and about.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` | `#F2F2F7` | `#000000` | the page |
| `--surface` | `#FFFFFF` | `#1C1C1E` | cards, sheets, the tab bar |
| `--fill` | `#E9E9EE` | `#2C2C2E` | secondary buttons, fields, chips |
| `--text` | `#0A0A0C` | `#EBEBF0` | main text, the post number |
| `--text-2` | `#5A5A62` | `#A1A1AA` | labels, secondary text |
| `--text-3` | `#6A6A72` | `#9A9AA2` | times, footnotes |
| `--sep` | `#DCDCE1` | `#38383A` | hairlines |
| `--accent` | `#FFB81C` | `#FFC23D` | carriageway block, primary button |
| `--on-accent` | `#1A1200` | `#1A1200` | text on amber |
| `--accent-text` | `#8F5600` | `#FFC23D` | amber as text (selected tab, links) |
| `--good` | `#1A7F45` | `#30D158` | a live GPS fix, a switch that is on |
| `--warn-bg` / `--warn-text` | `#FFF4D6` / `#6B4A00` | `#2E2408` / `#FFD98A` | cautions |
| `--bad` | `#C4281C` | `#FF6961` | errors, no GPS |
| `--mway` | `#0B62B8` | `#0B62B8` | motorway badge and network |
| `--aroad` / `--aroad-text` | `#00693A` / `#FFD100` | the same | A-road badge and network |
| `--you` | `#0A6CFF` | `#0A84FF` | your position on the map |

Every text and background pair meets WCAG AA (4.5 to 1) in both themes. Amber is never used as text on white: that is what `--accent-text` is for.

The app icon is the marker post from the original icon, redrawn: an amber post with a pale cap on `#101114`. It is drawn once, in `scripts/make-icons.mjs`, which writes every size for the web app, iOS and Android.

## Type

The system font everywhere (San Francisco on iPhone, Roboto on Android), so the app feels native on each and loads nothing. Sign messages use the system monospaced font.

| Role | Size / line | Weight |
|---|---|---|
| Post number (hero) | up to 140 px, scaled by the app so the number and letter always fit the width | 800 |
| Carriageway letter | about half the height of the number, in the amber block | 800 |
| Junction section | 34 / 40 | 700 |
| Screen title | 30 / 36 | 800 |
| Road badge | 28 | 800 |
| Row value | 17 | 600 |
| Body, buttons | 16–17 | 400–700 |
| Row label, secondary | 15 / 20 | 400 |
| Caption, time, note | 13 / 18 | 400–600 |

Nothing that carries information is smaller than 13 px. Numbers that change in place use tabular figures so they do not jiggle.

## Space and shape

- Side margins 16 px. Content keeps clear of the notch, Dynamic Island, home indicator and rounded corners through the `--safe-*` values.
- Corner radius: 9 (badges), 12 (fields), 14 (rows and buttons), 16 (cards), 24 (sheets).
- **Tap targets are at least 48 px high**; the primary button is 56. Controls you need while moving are in the lower two thirds of the screen, within reach of a thumb.

## Components

- **Road badge**: a rounded block in the road's sign colour. A long interchange name uses the neutral fill and a smaller size.
- **Carriageway block**: amber and filled when your direction of travel confirms the carriageway; **outlined** when it does not. The outline is the caveat, so it must never be styled away.
- **Rows**: a label on the left and a value on the right inside one card, separated by hairlines.
- **Callout**: a tinted strip with words, for a caution or a stale state. Never colour alone.
- **Buttons**: primary (amber, one per screen at most), secondary (neutral fill), text. No icon-only button without a spoken label.
- **Sheets**: slide up from the bottom over a dimmed page, with a grab handle and a Done button; on Android the Back button closes them.
- **Tab bar**: at the bottom in portrait, a rail down the left in landscape, with icon and label always together.

## The map

The base map is deliberately muted (soft greys and greens, thin roads, small labels) so that the network, the marker dots and your position are what you see. Its dark style is a real dark map, not an inverted light one.

- Network: motorways blue, A roads green, slip roads lighter, with a thin casing. A selected stretch gets an amber halo.
- Marker dots: amber, appearing from zoom 11, growing as you zoom in.
- Road numbers on the network are small road-sign shields drawn above the dots. Other roads keep the base map's plain grey shields.
- Emergency areas, lay-bys and junctions have their own small symbols; older emergency-area records are drawn differently because they are unverified.
- Buildings rise very slightly when zoomed right in. That is the only 3D.
- "© OpenStreetMap · National Highways (OGL)" is always visible.

## Lock Screen, CarPlay, notification and widgets

They use the same pieces at smaller sizes: road badge, post number, carriageway block (filled or outlined), section, and always a time. They have no buttons, because they are seen while driving. A widget says "Last updated"; only the Live Activity and the Android notification say or imply "now". The full rules are in [native-apps.md](native-apps.md), section 7.
