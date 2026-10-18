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
}

