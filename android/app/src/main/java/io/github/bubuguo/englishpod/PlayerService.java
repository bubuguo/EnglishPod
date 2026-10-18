package io.github.bubuguo.englishpod;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;

import androidx.core.content.ContextCompat;

import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.ForwardingPlayer;
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
    private PowerManager powerManager;
    private DataSource.Factory cachedFactory;
    private final ExecutorService precacheExecutor = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable sleepRunnable;
    private BroadcastReceiver screenReceiver;

    /** > 0 while MainActivity is resumed (reported via setActivityResumed). */
    private static int resumedActivities = 0;

    // 1 Hz progress ticks while playing AND the UI is visible; drives the JS
    // timeupdate path. The chain only exists while the UI can show it: it is
    // stopped when the screen turns off or the app is hidden, and restarted
    // with an immediate position push when either returns (see the SCREEN_ON/
    // OFF receiver and setActivityResumed).
    private final Runnable progressRunnable = new Runnable() {
        @Override
        public void run() {
            if (player != null && events != null && player.isPlaying()) {
                events.onProgress(player.getCurrentPosition(), player.getDuration());
                handler.postDelayed(this, 1000);
            }
        }
    };

    /** True when the UI can actually be seen: screen on AND app foregrounded. */
    private boolean uiVisible() {
        return powerManager.isInteractive() && resumedActivities > 0;
    }

    private void startProgressTicks() {
        handler.removeCallbacks(progressRunnable); // de-dupe rapid pause->play
        if (player != null && player.isPlaying()) {
            handler.postDelayed(progressRunnable, 1000);
        }
    }

    private void stopProgressTicks() {
        handler.removeCallbacks(progressRunnable);
    }

    /** Called from MainActivity.onResume/onPause. The service may be created
     *  after the activity already resumed, so visibility is tracked here
     *  rather than via lifecycle callbacks registered in onCreate. */
    public static void setActivityResumed(boolean resumed) {
        resumedActivities = Math.max(0, resumedActivities + (resumed ? 1 : -1));
        PlayerService svc = instance;
        if (svc == null) return;
        if (resumed) {
            // Back in the foreground: push a fresh position immediately, then
            // resume the 1 Hz ticks.
            if (svc.player != null && events != null && svc.player.isPlaying()) {
                events.onProgress(svc.player.getCurrentPosition(), svc.player.getDuration());
            }
            svc.startProgressTicks();
        } else {
            svc.stopProgressTicks();
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        // Screen on/off while foregrounded: no lifecycle event fires when the
        // display turns off, so listen explicitly. On SCREEN_OFF the tick
        // chain stops entirely; on SCREEN_ON a fresh position is pushed
        // immediately and ticks resume.
        screenReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (Intent.ACTION_SCREEN_ON.equals(intent.getAction())) {
                    if (player != null && events != null && player.isPlaying() && uiVisible()) {
                        events.onProgress(player.getCurrentPosition(), player.getDuration());
                    }
                    startProgressTicks();
                } else if (Intent.ACTION_SCREEN_OFF.equals(intent.getAction())) {
                    stopProgressTicks();
                }
            }
        };
        ContextCompat.registerReceiver(this, screenReceiver,
                new IntentFilter(Intent.ACTION_SCREEN_ON) {{
                    addAction(Intent.ACTION_SCREEN_OFF);
                }}, ContextCompat.RECEIVER_NOT_EXPORTED);
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
                if (isPlaying) {
                    // Start ticks only when the UI is visible; playback that
                    // (re)starts hidden or screen-off gets its ticks when
                    // visibility returns.
                    if (uiVisible()) startProgressTicks();
                    else stopProgressTicks();
                }
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) {
                    // Pause at end-of-track: with playWhenReady still true,
                    // STATE_ENDED would hold the wake lock (and the foreground
                    // service) indefinitely — a classic battery drain. Repeat
                    // and auto-next are unaffected: JS re-engages playback via
                    // seek(0)+play() or load().
                    if (player != null) player.pause();
                    if (events != null) events.onEnded();
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                if (events != null) {
                    events.onError(error.getMessage() != null ? error.getMessage() : "playback error");
                }
            }
        });
        // Wrap the player so every play() path (lock-screen notification,
        // media controllers) restarts from the beginning at end-of-track —
        // ExoPlayer alone would stay STATE_ENDED on play().
        Player sessionPlayer = new ForwardingPlayer(player) {
            @Override
            public void play() {
                if (player.getPlaybackState() == Player.STATE_ENDED) player.seekTo(0);
                super.play();
            }
        };
        session = new MediaSession.Builder(this, sessionPlayer).build();
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return session;
    }

    /** play() that restarts from the beginning at end-of-track. ExoPlayer
     *  alone would stay STATE_ENDED on play() (unlike HTML5 audio, which
     *  restarts); users expect play-at-end to replay. Covers the JS bridge
     *  path; the lock-screen play button is handled by the MediaSession
     *  callback below. */
    public void play() {
        if (player.getPlaybackState() == Player.STATE_ENDED) player.seekTo(0);
        player.play();
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
        stopProgressTicks();
        precacheExecutor.shutdownNow();
        if (screenReceiver != null) {
            unregisterReceiver(screenReceiver);
            screenReceiver = null;
        }
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
