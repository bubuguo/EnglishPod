package io.github.bubuguo.englishpod;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must run BEFORE super.onCreate(): the bridge initializes (and
        // instantiates all registered plugins) inside the super call.
        registerPlugin(AudioPlugin.class);
        super.onCreate(savedInstanceState);
    }

    // Report visibility to PlayerService so progress ticks only run while the
    // UI can show them (and resume with an immediate position push).
    @Override
    public void onResume() {
        super.onResume();
        PlayerService.setActivityResumed(true);
    }

    @Override
    public void onPause() {
        super.onPause();
        PlayerService.setActivityResumed(false);
    }
}

