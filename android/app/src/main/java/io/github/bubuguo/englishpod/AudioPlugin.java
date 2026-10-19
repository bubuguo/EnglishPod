package io.github.bubuguo.englishpod;

import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.media3.datasource.cache.SimpleCache;

/**
 * JS <-> native bridge for playback. All player state lives in
 * PlayerService (foreground); this plugin forwards calls to it and pushes
 * native events back to JS: progress (1 Hz while the UI is visible),
 * stateChanged, ended, error, sleepFired.
 *
 * Threading: plugin methods run on Capacitor worker threads, but ExoPlayer
 * must only be touched from the thread that created it (main) — every call
 * is dispatched through the main handler. The service is started with a
 * plain startService() (the app is foreground whenever the user initiates
 * playback); Media3 promotes it to a foreground service itself when playback
 * begins. startForegroundService() is deliberately avoided: it imposes a
 * hard startForeground() deadline that is only met once playback actually
 * starts, so an offline/slow start would ANR the app.
 */
@CapacitorPlugin(name = "AudioPlayer")
public class AudioPlugin extends Plugin implements PlayerService.EventsListener {

    private interface WithService {
        void run(PlayerService svc, PluginCall call);
    }

    private final Handler main = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        PlayerService.events = this;
    }

    /** Ensure the service process is started (idempotent). */
    private void ensureServiceStarted() {
        try {
            getContext().startService(new Intent(getContext(), PlayerService.class));
        } catch (IllegalStateException e) {
            android.util.Log.w("AudioPlayer", "startService failed: " + e);
        }
    }

    /** Run action against the service on the main thread, waiting (max ~5 s)
     *  for the service to be created if this is the first call. */
    private void withService(final PluginCall call, final WithService action) {
        if (PlayerService.instance != null) {
            main.post(() -> action.run(PlayerService.instance, call));
            return;
        }
        ensureServiceStarted();
        final int[] tries = {0};
        main.post(new Runnable() {
            @Override
            public void run() {
                PlayerService s = PlayerService.instance;
                if (s != null) {
                    action.run(s, call);
                    return;
                }
                tries[0]++;
                // Retry the start periodically: the first attempt may have been
                // rejected (BackgroundServiceStartNotAllowedException) while
                // the app was briefly backgrounded; once it is foregrounded
                // again the retry succeeds and the pending call recovers.
                if (tries[0] % 20 == 0) ensureServiceStarted();
                if (tries[0] < 100) { // 100 x 50 ms = 5 s
                    main.postDelayed(this, 50);
                } else {
                    call.reject("player service unavailable");
                }
            }
        });
    }

    // ---- JS API ----

    @PluginMethod
    public void loadTrack(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        withService(call, (svc, c) -> svc.load(
                url,
                c.getString("title", ""),
                c.getString("artist", ""),
                c.getInt("startPositionMs", 0),
                c.getBoolean("autoplay", true)));
        call.resolve();
    }

    @PluginMethod
    public void play(final PluginCall call) {
        withService(call, (svc, c) -> svc.play());
        call.resolve();
    }

    @PluginMethod
    public void pause(final PluginCall call) {
        withService(call, (svc, c) -> svc.player.pause());
        call.resolve();
    }

    @PluginMethod
    public void seek(final PluginCall call) {
        final Integer ms = call.getInt("ms");
        if (ms == null) {
            call.reject("ms is required");
            return;
        }
        withService(call, (svc, c) -> svc.player.seekTo(ms));
        call.resolve();
    }

    @PluginMethod
    public void setSleepTimer(final PluginCall call) {
        final Integer minutes = call.getInt("minutes");
        if (minutes == null || minutes <= 0) {
            call.reject("minutes must be positive");
            return;
        }
        withService(call, (svc, c) -> svc.setSleepTimer(minutes));
        call.resolve();
    }

    @PluginMethod
    public void clearSleepTimer(final PluginCall call) {
        withService(call, (svc, c) -> svc.clearSleepTimer());
        call.resolve();
    }

    /** Native audio cache usage: bytes on disk, cached file count, quota.
     *  Backs the header's "Cache: X MB" display in native mode (the service
     *  worker only sees transcripts there). */
    @PluginMethod
    public void cacheStats(final PluginCall call) {
        main.post(() -> {
            SimpleCache c = PlayerService.cache;
            JSObject data = new JSObject();
            data.put("bytes", c != null ? c.getCacheSpace() : 0L);
            data.put("count", c != null ? c.getKeys().size() : 0);
            data.put("quota", 500L * 1024 * 1024);
            call.resolve(data);
        });
    }

    /** Delete everything from the native audio cache. */
    @PluginMethod
    public void clearCache(final PluginCall call) {
        main.post(() -> {
            SimpleCache c = PlayerService.cache;
            if (c != null) {
                for (String key : c.getKeys()) {
                    try {
                        c.removeResource(key);
                    } catch (Exception e) {
                        /* keep clearing the rest */
                    }
                }
            }
            call.resolve();
        });
    }

    // ---- native -> JS events ----

    @Override
    public void onProgress(long positionMs, long durationMs) {
        JSObject data = new JSObject();
        data.put("position", positionMs / 1000.0);
        data.put("duration", durationMs <= 0 ? 0 : durationMs / 1000.0);
        notifyListeners("progress", data);
    }

    @Override
    public void onStateChanged(boolean playing) {
        JSObject data = new JSObject();
        data.put("playing", playing);
        notifyListeners("stateChanged", data);
    }

    @Override
    public void onEnded() {
        notifyListeners("ended", new JSObject());
    }

    @Override
    public void onError(String message) {
        JSObject data = new JSObject();
        data.put("message", message);
        notifyListeners("error", data);
    }

    @Override
    public void onSleepFired() {
        notifyListeners("sleepFired", new JSObject());
    }
}
