package kr.codyssey.attendance.util;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.Manifest;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.google.android.gms.location.ActivityRecognition;
import com.google.android.gms.location.ActivityRecognitionClient;
import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingClient;
import com.google.android.gms.location.GeofencingRequest;
import com.google.android.gms.location.LocationServices;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

import kr.codyssey.attendance.receiver.ActivityReceiver;
import kr.codyssey.attendance.receiver.GeofenceReceiver;

/**
 * 31차(C안) ⑤⑥: 지오펜스 등록/해제 + 활동 인식 업데이트 등록/해제.
 *
 * - 지오펜스 중심 좌표는 하드코딩하지 않는다. PhysicalCheck.learnNow가
 *   사용자가 학원에서 누를 때 기기의 최근 위치를 kind:"geo"로 학습하고,
 *   그 엔트리를 시드로 사용한다 (베타 수집으로 개발자가 사전에 넣기 전까지의 자립 경로).
 * - 백그라운드 이벤트 수신엔 "항상 허용"(ACCESS_BACKGROUND_LOCATION)이 필요.
 *   없으면 등록하지 않고 진단 로그로 안내한다.
 * - 모든 GMS 호출은 try/catch — Play services 없는 기기/권한 부재가 앱을 죽이지 않도록.
 */
public final class PhyGeofence {

    private static final String PREFS_NAME = "codyssey_prefs";
    public static final String CAMPUS_GEOFENCE_ID = "campus";
    private static final int REQ_GEOFENCE = 9101;
    private static final int REQ_ACTIVITY = 9102;

    private PhyGeofence() {}

    // 44차: 지오펜스는 별도 토글 없이 물리 탐지(phy_enabled)에 종속 — 단일 게이트
    public static boolean isGeofenceEnabled(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean("phy_enabled", false);
    }

    // 44차: 더 이상 UI에서 호출하지 않음 (호환 유지). 등록 자체는 phy_enabled 경로에서 관리.
    public static void setGeofenceEnabled(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putBoolean("phy_geofence", enabled).apply();
        if (enabled) startIfEnabled(context, true);
        else stop(context);
    }

    // phy_locations 안의 kind:"geo" 엔트리 (value = "lat,lng")
    public static double[] geofenceSeed(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray arr = new JSONArray(prefs.getString("phy_locations", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject loc = arr.optJSONObject(i);
                if (loc == null || !"geo".equals(loc.optString("kind"))) continue;
                String[] parts = loc.optString("value", "").split(",");
                if (parts.length == 2) {
                    return new double[] { Double.parseDouble(parts[0]), Double.parseDouble(parts[1]) };
                }
            }
        } catch (Exception ignored) { }
        return null;
    }

    public static boolean hasBackgroundLocation(Context context) {
        if (Build.VERSION.SDK_INT < 29) return true;
        return ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
    }

    @SuppressLint("MissingPermission")
    public static void startIfEnabled(Context context) {
        startIfEnabled(context, false);
    }

    @SuppressLint("MissingPermission")
    public static void startIfEnabled(Context context, boolean force) {
        try {
            if (!isGeofenceEnabled(context)) return;
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            long now = System.currentTimeMillis();
            // 32차 N31-8: 앱 열 때마다 재등록 호출은 낭비 — 등록 성공 상태가 6시간 유효하면 간극 둠.
            // 실패/만료 시엔 다음 호출에서 재시도. 재부팅 복구처럼 OS가 등록을 잃었을 때는
            // 호출측이 force=true로 강제한다 (reg_ok는 단말 저장값이라 부팅 후에도 남기 때문).
            if (!force && prefs.getBoolean("phy_geo_reg_ok", false)
                    && now - prefs.getLong("phy_geo_reg_at", 0) < 6L * 60 * 60 * 1000) {
                return;
            }
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION)
                    != PackageManager.PERMISSION_GRANTED) {
                DiagLog.addOnChange(context, "PHY", "geonofine", "⚠️ 지오펜스: 위치 권한 없음 — 등록 보류");
                return;
            }
            if (!hasBackgroundLocation(context)) {
                DiagLog.addOnChange(context, "PHY", "geonobg",
                        "⚠️ 지오펜스: '항상 허용' 위치가 아니라 백그라운드 진입/이탈이 오지 않을 수 있음");
            }
            double[] seed = geofenceSeed(context);
            if (seed == null) {
                DiagLog.addOnChange(context, "PHY", "geonoseed",
                        "⚠️ 지오펜스: 학원 좌표가 아직 학습되지 않음 — 설정에서 '지금 위치를 학원으로 학습'");
                return;
            }

            GeofencingClient client = LocationServices.getGeofencingClient(context);
            List<Geofence> fences = new ArrayList<>();
            fences.add(new Geofence.Builder()
                    .setRequestId(CAMPUS_GEOFENCE_ID)
                    .setCircularRegion(seed[0], seed[1], 150f)
                    .setExpirationDuration(Geofence.NEVER_EXPIRE)
                    .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_ENTER
                            | Geofence.GEOFENCE_TRANSITION_EXIT)
                    .build());
            GeofencingRequest request = new GeofencingRequest.Builder()
                    .setInitialTrigger(GeofencingRequest.INITIAL_TRIGGER_ENTER
                            | GeofencingRequest.INITIAL_TRIGGER_EXIT)
                    .addGeofences(fences)
                    .build();

            client.addGeofences(request, geofencePendingIntent(context))
                    .addOnSuccessListener(v -> {
                        prefs.edit()
                                .putBoolean("phy_geo_reg_ok", true)
                                .putLong("phy_geo_reg_at", System.currentTimeMillis())
                                .apply();
                        DiagLog.add(context, "PHY", "지오펜스 등록 완료 (학원 좌표 반경 150m)");
                    })
                    // 32차 N31-8: 실패는 호출마다 반복되므로 상태 변화 시에만 기록
                    .addOnFailureListener(e -> {
                        prefs.edit().putBoolean("phy_geo_reg_ok", false).apply();
                        DiagLog.addOnChange(context, "PHY", "geofail",
                                "⚠️ 지오펜스 등록 실패: " + e.getMessage());
                    });
            startActivityUpdates(context);
        } catch (SecurityException se) {
            DiagLog.addOnChange(context, "PHY", "geodeny", "⚠️ 지오펜스 등록 거부 (권한)");
        } catch (Exception e) {
            DiagLog.addOnChange(context, "PHY", "geoerr", "⚠️ 지오펜스 초기화 오류: " + e.getMessage());
        }
    }

    public static void stop(Context context) {
        try {
            LocationServices.getGeofencingClient(context)
                    .removeGeofences(geofencePendingIntent(context));
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .putInt("phy_geo_hint", 0)
                    .putBoolean("phy_geo_reg_ok", false) // 32차: 해제 상태를 등록 캐시에도 반영
                    .apply();
            DiagLog.add(context, "PHY", "지오펜스 해제");
        } catch (Exception ignored) { }
        stopActivityUpdates(context);
    }

    static PendingIntent geofencePendingIntent(Context context) {
        Intent i = new Intent(context, GeofenceReceiver.class);
        return PendingIntent.getBroadcast(context, REQ_GEOFENCE, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
    }

    // ===== ⑥ 활동 인식 (보조 신호 — 귀가 이동 vs 근처 정지 구분에 사용) =====
    public static void startActivityUpdates(Context context) {
        try {
            if (!isGeofenceEnabled(context)) return;
            if (Build.VERSION.SDK_INT >= 29
                    && ContextCompat.checkSelfPermission(context, Manifest.permission.ACTIVITY_RECOGNITION)
                    != PackageManager.PERMISSION_GRANTED) {
                DiagLog.addOnChange(context, "PHY", "actdeny", "⚠️ 활동 인식 권한 없음 — 보조 신호 없이 동작");
                return;
            }
            ActivityRecognitionClient arc = ActivityRecognition.getClient(context);
            arc.requestActivityUpdates(60000L, activityPendingIntent(context))
                    .addOnFailureListener(e -> DiagLog.addOnChange(context, "PHY", "acterr",
                            "⚠️ 활동 인식 등록 실패: " + e.getMessage()));
        } catch (Exception ignored) { }
    }

    public static void stopActivityUpdates(Context context) {
        try {
            ActivityRecognition.getClient(context)
                    .removeActivityUpdates(activityPendingIntent(context));
        } catch (Exception ignored) { }
    }

    static PendingIntent activityPendingIntent(Context context) {
        Intent i = new Intent(context, ActivityReceiver.class);
        return PendingIntent.getBroadcast(context, REQ_ACTIVITY, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
    }
}
