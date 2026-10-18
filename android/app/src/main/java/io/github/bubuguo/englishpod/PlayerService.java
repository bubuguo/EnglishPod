package io.github.bubuguo.englishpod;

import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.cache.CacheDataSource;
import androidx.media3.datasource.cache.CacheWriter;
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor;
import androidx.media3.datasource.cache.SimpleCache;
import androidx.media3.database.DatabaseProvider;
import androidx.media3.database.StandaloneDatabaseProvider;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;

/**
 * Foreground service hosting the ExoPlayer instance. Runs independently of
 * the WebView, so playback, track switching and the sleep timer keep working
 * while the screen is locked. MediaSession gives lock-screen/notification
 * controls; audio focus and "unplug headphones -> pause" are handled by
 * ExoPlayer (handleAudioFocus / handleAudioBecomingNoisy).
 */
public class PlayerService extends MediaSessionService {

    /** Bridge back to the Capacitor plugin (same process). */
    public interface EventsListener {
        void onProgress(long positionMs, long durationMs);
        void onStateChanged(boolean playing);
        void onEnded();
        void onError(String message);
        void onSleepFired();
    }

    public static PlayerService instance;
    public static EventsListener events;

    /** App-lifetime audio cache (LRU eviction, 500 MB). Created once per
     *  process — SimpleCache must never be instantiated twice for the same
     *  directory, hence the static singleton. */
    public static SimpleCache cache;

    public ExoPlayer player;
    private MediaSession session;
    private DataSource.Factory cachedFactory;
    private final ExecutorService precacheExecutor = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable sleepRunnable;

    // 1 Hz progress ticks while playing; drives the JS timeupdate path.
    private final Runnable progressRunnable = new Runnable() {
        @Override
        public void run() {
            if (player != null && events != null) {
                events.onProgress(player.getCurrentPosition(), player.getDuration());
                if (player.isPlaying()) handler.postDelayed(this, 1000);
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        // Read-through media cache: every byte ExoPlayer downloads is written
        // into SimpleCache; LeastRecentlyUsedCacheEvictor enforces the 500 MB
        // quota by deleting the least-recently-used spans first. Cached
        // lessons then play fully offline.
        if (cache == null) {
            DatabaseProvider dbProvider = new StandaloneDatabaseProvider(this);
            cache = new SimpleCache(
                    new File(getFilesDir(), "media_cache"),
                    new LeastRecentlyUsedCacheEvictor(500L * 1024 * 1024),
                    dbProvider);
        }
        DataSource.Factory upstream = new DefaultDataSource.Factory(this,
                new DefaultHttpDataSource.Factory()
                        .setAllowCrossProtocolRedirects(true)
                        .setUserAgent("EnglishPodPlayer/1.0"));
        DataSource.Factory cached = new CacheDataSource.Factory()
                .setCache(cache)
                .setUpstreamDataSourceFactory(upstream)
                .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR);
        cachedFactory = cached;
        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(cached))
                .setAudioAttributes(
                        new AudioAttributes.Builder()
                                .setUsage(C.USAGE_MEDIA)
                                .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                                .build(),
                        true /* handle audio focus */)
                .setHandleAudioBecomingNoisy(true)
                .build();
        // Hold a partial wake lock while playing so audio — and the sleep
        // timer's Handler — keep running with the screen off (uses the
        // WAKE_LOCK permission already declared in the manifest).
        player.setWakeMode(C.WAKE_MODE_LOCAL);
        player.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                if (events != null) events.onStateChanged(isPlaying);
                if (isPlaying) handler.postDelayed(progressRunnable, 1000);
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED && events != null) events.onEnded();
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                if (events != null) {
                    events.onError(error.getMessage() != null ? error.getMessage() : "playback error");
                }
            }
        });
        session = new MediaSession.Builder(this, player).build();
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    public void load(String url, String title, String artist, int startPositionMs, boolean autoplay) {
        MediaMetadata meta = new MediaMetadata.Builder()
                .setTitle(title)
                .setArtist(artist)
                .build();
        MediaItem item = new MediaItem.Builder()
                .setUri(url)
                .setMediaMetadata(meta)
                .build();
        player.setMediaItem(item, startPositionMs);
        player.prepare();
        if (autoplay) player.play();
        precacheInBackground(url);
    }

    /** Download the whole file into the cache in the background, so the
     *  lesson is fully available offline after one play (matching the PWA's
     *  service-worker behavior — playback alone would only cache the spans
     *  ExoPlayer actually reads). CacheWriter skips already-cached spans and
     *  is a no-op when the file is complete or the device is offline. */
    private void precacheInBackground(String url) {
        precacheExecutor.execute(() -> {
            try {
                CacheDataSource ds = (CacheDataSource) cachedFactory.createDataSource();
                new CacheWriter(ds, new DataSpec(Uri.parse(url)), null, null).cache();
            } catch (Exception e) {
                /* offline or failed — playback itself still streams/caches */
            }
        });
    }

    /** Native sleep timer: fires exactly on time even when the screen is
     *  locked. Self-correcting against SystemClock.elapsedRealtime() (which,
     *  unlike the uptimeMillis that postDelayed schedules on, includes
     *  deep-sleep time): if the wakeup is delayed (doze batching), the
     *  remaining time is re-posted instead of firing late. Combined with
     *  ExoPlayer's wake lock (setWakeMode) while playing, this is exact. */
    public void setSleepTimer(int minutes) {
        clearSleepTimer();
        final long fireAt = SystemClock.elapsedRealtime() + minutes * 60_000L;
        sleepRunnable = new Runnable() {
            @Override
            public void run() {
                long left = fireAt - SystemClock.elapsedRealtime();
                if (left > 0) {
                    handler.postDelayed(this, Math.min(left, 60_000L));
                    return;
                }
                sleepRunnable = null;
                if (player != null) player.pause();
                if (events != null) events.onSleepFired();
            }
        };
        handler.postDelayed(sleepRunnable, minutes * 60_000L);
    }

    public void clearSleepTimer() {
        if (sleepRunnable != null) {
            handler.removeCallbacks(sleepRunnable);
            sleepRunnable = null;
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Player p = player;
        if (p == null || !p.getPlayWhenReady() || p.getPlaybackState() == Player.STATE_IDLE) {
            stopSelf();
        }
        // else: keep playing — the foreground service survives swipe-away.
    }

    @Override
    public void onDestroy() {
        clearSleepTimer();
        precacheExecutor.shutdownNow();
        if (session != null) {
            session.release();
            session = null;
        }
        if (player != null) {
            player.release();
            player = null;
        }
        instance = null;
        super.onDestroy();
    }
}
