package io.github.bubuguo.englishpod;

import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
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

    public ExoPlayer player;
    private MediaSession session;
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
        player = new ExoPlayer.Builder(this)
                .setAudioAttributes(
                        new AudioAttributes.Builder()
                                .setUsage(C.USAGE_MEDIA)
                                .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
                                .build(),
                        true /* handle audio focus */)
                .setHandleAudioBecomingNoisy(true)
                .build();
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
        android.util.Log.d("PlayerService", "load: " + url + " autoplay=" + autoplay);
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
        android.util.Log.d("PlayerService", "load done: state=" + player.getPlaybackState() + " playWhenReady=" + player.getPlayWhenReady());
    }

    /** Native sleep timer: fires exactly on time even when the screen is locked. */
    public void setSleepTimer(int minutes) {
        clearSleepTimer();
        sleepRunnable = () -> {
            sleepRunnable = null;
            if (player != null) player.pause();
            if (events != null) events.onSleepFired();
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
