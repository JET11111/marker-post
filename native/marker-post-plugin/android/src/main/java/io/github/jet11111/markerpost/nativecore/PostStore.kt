package io.github.jet11111.markerpost.nativecore

import android.content.Context
import java.io.InputStreamReader

/**
 * The bundled marker posts (assets/markerpost/posts.tsv, written by
 * scripts/build-native-data.mjs), read once and kept for the life of the
 * process. The tracking service needs its own copy of the data because the
 * web view is asleep while the phone is locked.
 */
object PostStore {
    private const val ASSET = "markerpost/posts.tsv"

    @Volatile
    private var cached: List<Post>? = null

    /**
     * The posts, or null when the file is missing, damaged or empty. Callers
     * turn null into the "no-data" reason: tracking must not start over data
     * that could not be read in full.
     *
     * The first call reads about 5,000 lines, so make it off the main thread
     * where that is easy (the plugin does). Later calls return at once.
     */
    fun get(context: Context): List<Post>? {
        val ready = cached
        if (ready != null) return ready
        synchronized(this) {
            val alreadyRead = cached
            if (alreadyRead != null) return alreadyRead
            val posts = read(context)
            if (posts != null) cached = posts
            return posts
        }
    }

    private fun read(context: Context): List<Post>? {
        return try {
            val posts = context.applicationContext.assets.open(ASSET).use { stream ->
                PostLookup.parse(InputStreamReader(stream, Charsets.UTF_8))
            }
            if (posts.isEmpty()) null else posts
        } catch (e: Exception) {
            // Missing file (IOException) or a damaged one (PostLookup.parse refuses it).
            null
        }
    }
}
