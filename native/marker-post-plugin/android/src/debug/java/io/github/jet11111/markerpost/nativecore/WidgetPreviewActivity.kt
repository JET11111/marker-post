package io.github.jet11111.markerpost.nativecore

import android.app.Activity
import android.content.res.Configuration
import android.graphics.Color
import android.os.Bundle
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * DEBUG BUILDS ONLY: the home screen widget in each of its states on one
 * screen, so that the automated check can take a picture of it. Nothing can
 * place a real widget on a home screen from the command line, so without
 * this the widget is never seen before it reaches a phone.
 *
 * Every tile is made by the widget's own code
 * (MarkerPostWidgetProvider.buildViews, with the number of lines
 * WidgetRules.contextLines allows a widget of the tile's height) and drawn
 * with RemoteViews.apply(), the call a launcher makes, at the size of a real
 * widget, in the day or night colours and at the text size the phone is set
 * to. The posts are samples made here. They are never stored, so a real
 * widget on the home screen is not touched.
 *
 * A launcher cuts off whatever does not fit and gives no sign of it. So once
 * the page has been laid out each tile is measured, and one whose post
 * number, carriageway letter, time or line under the post is not shown whole
 * gets a red caption that says which (checkTiles).
 *
 * The notification cannot be drawn on a screen of the app's own, so what it
 * would say for each sample post (its title, its text and the status bar
 * chip) is written to the log under the tag MarkerPostPreview, with what was
 * measured.
 *
 * This file is in src/debug, so the release build does not contain it, and
 * it has no entry in the app list. Open it with:
 *
 *   adb shell am start -W -n io.github.jet11111.markerpost/io.github.jet11111.markerpost.nativecore.WidgetPreviewActivity
 */
class WidgetPreviewActivity : Activity() {

    /** One widget on the page: what it is called, the caption above it, and the box it is drawn in. */
    private class Tile(val title: String, val caption: TextView, val frame: FrameLayout)

    private val tiles = ArrayList<Tile>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val now = System.currentTimeMillis()
        // 26 hours ago is another day at whatever time the picture is taken,
        // so these tiles show the time with its date.
        val earlier = now - 26L * 60L * 60L * 1000L
        // The dash and the dot are written as codes so this file reads the
        // same in any editor: "J4 – J5", "A2030 jct · 1.07 km from post".
        val section = "J4 \u2013 J5"

        val page = LinearLayout(this)
        page.orientation = LinearLayout.VERTICAL
        page.setPadding(dp(2), dp(2), dp(2), dp(2))

        val night = (resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        // The first line of every run in the log, so one run can be told from the next.
        val heading = "Marker Post widget, debug preview: " + (if (night) "night" else "day") +
            " colours, text size " + resources.configuration.fontScale
        Log.i(TAG, heading)
        page.addView(caption(heading))

        // A widget of two cells by two on a current phone.
        page.addView(
            row(
                tile(
                    "Letter confirmed", TYPICAL_WIDTH, TYPICAL_HEIGHT,
                    sample("M27", "M", "17.4", "A", section, true, now, false)
                ),
                tile(
                    "Letter not confirmed", TYPICAL_WIDTH, TYPICAL_HEIGHT,
                    sample("M27", "M", "17.4", "A", section, false, now, false)
                )
            )
        )
        page.addView(
            row(
                tile(
                    "No GPS (stale)", TYPICAL_WIDTH, TYPICAL_HEIGHT,
                    sample("M27", "M", "17.4", "A", section, true, now, true)
                ),
                tile(
                    "Long line", TYPICAL_WIDTH, TYPICAL_HEIGHT,
                    sample("A27", "A", "47.2", "B", "A2030 jct \u00B7 1.07 km from post", true, now, false)
                )
            )
        )
        // The smallest a widget of two cells by two is likely to be, with the
        // contents that need the most room.
        page.addView(
            row(
                tile("No post yet", SMALL, SMALL, null),
                tile(
                    "Link, earlier day", SMALL, SMALL,
                    sample(
                        "M27 / M275 interchange", "O", "44.5", "G",
                        "Link M275J/M27B \u00B7 survey date unknown", false, earlier, false
                    )
                )
            )
        )
        page.addView(
            row(
                tile(
                    "Far from a post", SMALL, SMALL,
                    sample("M3", "M", "117.4", "B", TrackingRules.farContext(1240.0), false, now, false)
                ),
                tile(
                    "No GPS, earlier day", SMALL, SMALL,
                    sample("M27", "M", "17.4", "A", section, true, earlier, true)
                )
            )
        )

        val scroll = ScrollView(this)
        // A plain mid grey stands in for the wallpaper, so the widget's own
        // background and corners show in both the day and the night colours.
        scroll.setBackgroundColor(Color.rgb(0x56, 0x61, 0x6F))
        // Keeps the tiles clear of the status bar and the navigation bar.
        scroll.fitsSystemWindows = true
        scroll.addView(page)
        setContentView(scroll)

        // Runs once the page has been measured and laid out.
        scroll.post {
            try {
                checkTiles()
            } catch (e: Exception) {
                // The picture is still worth having without the check.
                Log.e(TAG, "the tiles could not be checked", e)
            }
        }
    }

    /** A sample post. The reference is made from the chainage and letter, as the records write it: "P17/4A". */
    private fun sample(
        road: String,
        roadClass: String,
        km: String,
        letter: String,
        context: String,
        confirmed: Boolean,
        fixTime: Long,
        stale: Boolean
    ): Snapshot {
        val ref = "P" + km.replace('.', '/') + letter
        return Snapshot(road, roadClass, km, letter, ref, context, confirmed, fixTime, stale, false)
    }

    private fun row(first: View, second: View): View {
        val pair = LinearLayout(this)
        pair.orientation = LinearLayout.HORIZONTAL
        pair.addView(first)
        pair.addView(second)
        return pair
    }

    /** One widget at a stated size in dp, under a line that says what it is. */
    private fun tile(title: String, widthDp: Int, heightDp: Int, snapshot: Snapshot?): View {
        val holder = LinearLayout(this)
        holder.orientation = LinearLayout.VERTICAL
        holder.setPadding(dp(2), dp(2), dp(2), dp(2))
        val label = caption(title + " \u00B7 " + widthDp + " \u00D7 " + heightDp + " dp")
        holder.addView(label, LinearLayout.LayoutParams(dp(widthDp), LinearLayout.LayoutParams.WRAP_CONTENT))

        val frame = FrameLayout(this)
        try {
            // As many lines under the post as the widget itself allows at
            // this height and at the phone's text size.
            val allowed = WidgetRules.contextLines(heightDp, resources.configuration.fontScale)
            // Made with the app's context, as the widget provider makes it, and
            // drawn with this screen's, as a launcher draws it with its own.
            val views = MarkerPostWidgetProvider.buildViews(applicationContext, snapshot, allowed)
            frame.addView(views.apply(this, frame))
        } catch (e: Exception) {
            // A layout that a launcher could not draw either: say so in the
            // picture, where it cannot be missed.
            frame.addView(problem(e))
        }
        holder.addView(frame, LinearLayout.LayoutParams(dp(widthDp), dp(heightDp)))
        tiles.add(Tile(title, label, frame))

        if (snapshot != null) {
            // The notification cannot be drawn here. Its words for the same
            // sample post go to the log instead, which the automated check keeps.
            Log.i(
                TAG,
                title + ": title [" + SurfaceText.notificationTitle(this, snapshot) + "] text [" +
                    SurfaceText.notificationText(this, snapshot) + "] chip [" + (snapshot.chipText() ?: "") + "]"
            )
        }
        return holder
    }

    /**
     * Looks at every tile once it has been laid out. The post number, the
     * carriageway letter, the time and the line under the post must each be
     * shown whole (a line that ends in "…" counts as whole: its cut is
     * marked). A tile where one is not gets a red caption naming it, and
     * what was measured goes to the log for every tile, with a count at the
     * end.
     */
    private fun checkTiles() {
        var checked = 0
        var withACut = 0
        for (drawn in tiles) {
            val number: TextView? = drawn.frame.findViewById(R.id.markerpost_km)
            val time: TextView? = drawn.frame.findViewById(R.id.markerpost_time)
            val line: TextView? = drawn.frame.findViewById(R.id.markerpost_context)
            // "No post yet" has none of these, and neither has a tile that could not be drawn.
            if (number == null || time == null || line == null) continue
            val letter = letterBlock(drawn.frame)
            checked++

            val cut = ArrayList<String>()
            if (!shownWhole(number)) cut.add("NUMBER")
            if (letter != null && !letterShown(letter)) cut.add("LETTER")
            if (!shownWhole(time)) cut.add("TIME")
            if (!shownWhole(line)) cut.add("LINE UNDER THE POST")

            Log.i(
                TAG,
                drawn.title + ": number [" + inDp(number.textSize) + " dp text in a " +
                    inDp(number.height.toFloat()) + " dp row] letter [" + blockHeights(letter) +
                    "] time [" + lines(time.lineCount) + "] line [" + underThePost(line) +
                    "] cut [" + (if (cut.isEmpty()) "nothing" else cut.joinToString(", ")) + "]"
            )
            if (cut.isNotEmpty()) {
                withACut++
                drawn.caption.text = "CUT: " + cut.joinToString(", ") + " \u00B7 " + drawn.title
                drawn.caption.setBackgroundColor(ALARM)
            }
        }
        Log.i(TAG, "checked " + checked + " tiles, " + withACut + " with something cut")
    }

    /**
     * False when part of a text is cut off with nothing to show for it: the
     * text is taller than the room its view was given, or the view runs past
     * the bottom of the layout that holds it. A view that is not on show has
     * nothing to cut.
     */
    private fun shownWhole(view: TextView): Boolean {
        if (view.visibility != View.VISIBLE) return true
        val text = view.layout ?: return false
        if (text.height > view.height - view.paddingTop - view.paddingBottom) return false
        val holder = view.parent as? View ?: return true
        return view.bottom <= holder.height - holder.paddingBottom
    }

    /** The block the carriageway letter is drawn in, whichever of the two is on show. Null when the post has none. */
    private fun letterBlock(widget: View): TextView? {
        for (id in intArrayOf(R.id.markerpost_chip_filled, R.id.markerpost_chip_outline)) {
            val block: TextView? = widget.findViewById(id)
            if (block != null && block.visibility == View.VISIBLE) return block
        }
        return null
    }

    /**
     * False when the carriageway letter itself is cut into. Its block may be
     * squeezed on a short widget and still show the letter: a capital stands
     * on the line of its text with nothing below, so what counts is the room
     * down to that line.
     */
    private fun letterShown(block: TextView): Boolean {
        val text = block.layout ?: return false
        return block.paddingTop + text.getLineBaseline(0) <= block.height - block.paddingBottom
    }

    /** "31 of 36 dp": the height the letter's block was given, then the height it asks for. "none" when the post has no block. */
    private fun blockHeights(block: TextView?): String {
        if (block == null) return "none"
        val text = block.layout ?: return "not laid out"
        val asked = maxOf(text.height + block.paddingTop + block.paddingBottom, block.minHeight)
        return inDp(block.height.toFloat()).toString() + " of " + inDp(asked.toFloat()) + " dp"
    }

    /** How the line under the post came out: "none", "1 line", or "2 lines, ending in an ellipsis" when its end was cut and marked. */
    private fun underThePost(line: TextView): String {
        if (line.visibility != View.VISIBLE) return "none"
        val text = line.layout ?: return "not laid out"
        val last = text.lineCount - 1
        val marked = last >= 0 && text.getEllipsisCount(last) > 0
        return lines(text.lineCount) + (if (marked) ", ending in an ellipsis" else "")
    }

    private fun lines(count: Int): String = if (count == 1) "1 line" else count.toString() + " lines"

    private fun caption(text: String): TextView {
        val label = TextView(this)
        label.text = text
        label.setTextColor(Color.WHITE)
        // In dp, not sp: the page must fit one screen whatever the text size
        // setting. The widgets themselves follow that setting, as on a home screen.
        label.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 11f)
        label.maxLines = 1
        label.ellipsize = TextUtils.TruncateAt.END
        return label
    }

    private fun problem(e: Exception): TextView {
        val message = TextView(this)
        message.text = "THIS WIDGET COULD NOT BE DRAWN: " + e
        message.setTextColor(Color.WHITE)
        message.setBackgroundColor(ALARM)
        message.setTextSize(TypedValue.COMPLEX_UNIT_DIP, 11f)
        message.setPadding(dp(6), dp(6), dp(6), dp(6))
        return message
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density + 0.5f).toInt()

    /** Pixels as whole dp, for the log. */
    private fun inDp(pixels: Float): Int = (pixels / resources.displayMetrics.density + 0.5f).toInt()

    private companion object {
        const val TAG = "MarkerPostPreview"

        // Sizes in dp. Two cells by two on a current phone is about this...
        const val TYPICAL_WIDTH = 172
        const val TYPICAL_HEIGHT = 184
        // ...and this is about the least it can be (a small screen, or a
        // launcher with five columns).
        const val SMALL = 146

        /** The red of a caption that reports a problem. */
        val ALARM = Color.rgb(0xC4, 0x28, 0x1C)
    }
}
