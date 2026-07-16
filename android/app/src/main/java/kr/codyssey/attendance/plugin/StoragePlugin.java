package kr.codyssey.attendance.plugin;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "StoragePlugin")
public class StoragePlugin extends Plugin {

    private static final String PREFS_NAME = "codyssey_prefs";

    private SharedPreferences getPrefs() {
        return getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("Key is required");
            return;
        }

        String value = getPrefs().getString(key, null);
        JSObject result = new JSObject();
        result.put("value", value);
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = call.getString("key");
        String value = call.getString("value");
        if (key == null || value == null) {
            call.reject("Key and value are required");
            return;
        }

        getPrefs().edit().putString(key, value).apply();
        call.resolve();
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = call.getString("key");
        if (key == null) {
            call.reject("Key is required");
            return;
        }

        getPrefs().edit().remove(key).apply();
        call.resolve();
    }

    @PluginMethod
    public void clear(PluginCall call) {
        getPrefs().edit().clear().apply();
        call.resolve();
    }

    @PluginMethod
    public void getAll(PluginCall call) {
        JSObject result = new JSObject();
        for (String key : getPrefs().getAll().keySet()) {
            result.put(key, getPrefs().getString(key, ""));
        }
        call.resolve(result);
    }
}