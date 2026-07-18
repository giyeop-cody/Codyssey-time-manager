package kr.codyssey.attendance.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.google.android.gms.location.Geofence;
import com.google.android.gms.location.GeofencingEvent;

import kr.codyssey.attendance.util.DiagLog;
import kr.codyssey.attendance.util.PhysicalCheck;

/**
 * 31차(C안) ⑤: 지오펜스 진입/이탈 이벤트 수신.
 * 이벤트 도착 즉시 힌트(phy_geo_hint)를 갱신하고 물리 판정을 1회 돌린다 —
 * 5분 틱을 기다리지 않아 퇴실 누락 알림 반응 속도가 수십 초 수준으로 빨라진다.
 */
public class GeofenceReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        GeofencingEvent event = intent != null ? GeofencingEvent.fromIntent(intent) : null;
        if (event == null) return;
        if (event.hasError()) {
            DiagLog.add(context, "PHY", "⚠️ 지오펜스 이벤트 오류 code=" + event.getErrorCode());
            return;
        }
        int transition = event.getGeofenceTransition();
        final Context appCtx = context.getApplicationContext();
        if (transition == Geofence.GEOFENCE_TRANSITION_ENTER
                || transition == Geofence.GEOFENCE_TRANSITION_DWELL) {
            appCtx.getSharedPreferences("codyssey_prefs", Context.MODE_PRIVATE)
                    .edit().putInt("phy_geo_hint", 1).apply();
        } else if (transition == Geofence.GEOFENCE_TRANSITION_EXIT) {
            appCtx.getSharedPreferences("codyssey_prefs", Context.MODE_PRIVATE)
                    .edit().putInt("phy_geo_hint", -1).apply();
        } else {
            return;
        }
        DiagLog.add(context, "PHY",
                transition == Geofence.GEOFENCE_TRANSITION_EXIT
                        ? "지오펜스 이탈 — 즉시 물리 판정 실행" : "지오펜스 진입 — 즉시 물리 판정 실행");

        final PendingResult pending = goAsync();
        new Thread(() -> {
            try {
                PhysicalCheck.sampleAndEvaluate(appCtx);
            } finally {
                pending.finish();
            }
        }, "codyssey-phy-geofence").start();
    }
}
