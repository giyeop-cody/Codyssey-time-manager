package kr.codyssey.attendance.plugin;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;

import kr.codyssey.attendance.util.DiagLog;
import kr.codyssey.attendance.util.PhyGeofence;
import kr.codyssey.attendance.util.PhysicalCheck;

/**
 * 31차(C안): 물리 탐지 설정/상태/내보내기 JS 브릿지.
 *
 * 권한 흐름 (설정 토글이 즉시 적용되는 설계):
 *  - 활성화 요청 시 FINE/COARSE (+33부터 NEARBY_WIFI_DEVICES) 런타임 요청을 띄운다.
 *  - 지오펜스는 별도 토글: BACKGROUND '항상 허용'은 앱이 직접 물을 수 없어(API 30+)
 *    필요 신호{needBackground:true}만 JS에 주고, 사용자가 openPhySettings로 열리는
 *    앱 설정 화면에서 직접 바꾸도록 안내한다.
 */
@CapacitorPlugin(name = "PhyPlugin")
public class PhyPlugin extends Plugin {

    private static final String PREFS_NAME = "codyssey_prefs";
    // 32차 N31-9: MainActivity.onRequestPermissionsResult가 같은 코드로 결과를 잡아
    // 팝업에 즉시 알릴 수 있도록 public 공개
    public static final int REQ_PHY_PERMS = 9021;

    @PluginMethod
    public void setPhyEnabled(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        Context ctx = getContext();
        prefs(ctx).edit().putBoolean("phy_enabled", enabled).apply();
        if (enabled) {
            ensureRuntimePermissions();
            DiagLog.add(ctx, "PHY", "물리 탐지 켜짐 — SSID/셀 학습·판정 시작" + (isFineGranted()
                    ? "" : " (위치 권한 요청 중 — 허용해야 동작)"));
        } else {
            PhyGeofence.stop(ctx);
            DiagLog.add(ctx, "PHY", "물리 탐지 꺼짐 (학습 데이터는 보존)");
        }
        JSObject out = new JSObject();
        out.put("enabled", enabled);
        out.put("fine", isFineGranted());
        call.resolve(out);
    }

    @PluginMethod
    public void setPhyGeofence(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        Context ctx = getContext();
        PhyGeofence.setGeofenceEnabled(ctx, enabled);
        JSObject out = new JSObject();
        out.put("geofence", enabled);
        out.put("needBackground", enabled && Build.VERSION.SDK_INT >= 29
                && !PhyGeofence.hasBackgroundLocation(ctx));
        call.resolve(out);
    }

    @PluginMethod
    public void getPhyStatus(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(PhysicalCheck.statusSummary(getContext())));
        } catch (Exception e) { // JSONException 등 — 상태 조회 실패는 치명 아님
            call.reject("getPhyStatus failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void learnNow(PluginCall call) {
        String result = PhysicalCheck.learnNow(getContext());
        JSObject out = new JSObject();
        out.put("result", result);
        call.resolve(out);
    }

    // '항상 허용'은 API 30+에서 앱이 직접 요청할 수 없음 → 앱 설정 화면으로 안내
    @PluginMethod
    public void openPhySettings(PluginCall call) {
        try {
            Context ctx = getContext();
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + ctx.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(intent);
        } catch (Exception ignored) { }
        call.resolve(new JSObject());
    }

    private void ensureRuntimePermissions() {
        if (getActivity() == null) return;
        List<String> wanted = new ArrayList<>();
        if (!isFineGranted()) {
            wanted.add(Manifest.permission.ACCESS_FINE_LOCATION);
            wanted.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }
        if (Build.VERSION.SDK_INT >= 33
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.NEARBY_WIFI_DEVICES)
                    != PackageManager.PERMISSION_GRANTED) {
            wanted.add(Manifest.permission.NEARBY_WIFI_DEVICES);
        }
        if (Build.VERSION.SDK_INT >= 29
                && ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACTIVITY_RECOGNITION)
                    != PackageManager.PERMISSION_GRANTED) {
            wanted.add(Manifest.permission.ACTIVITY_RECOGNITION);
        }
        if (!wanted.isEmpty()) {
            try {
                ActivityCompat.requestPermissions(getActivity(),
                        wanted.toArray(new String[0]), REQ_PHY_PERMS);
            } catch (Exception ignored) { }
        }
    }

    private boolean isFineGranted() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    private SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }
}
