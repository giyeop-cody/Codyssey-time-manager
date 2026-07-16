package kr.codyssey.attendance.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import kr.codyssey.attendance.MainActivity;
import kr.codyssey.attendance.plugin.AlarmPlugin;
import kr.codyssey.attendance.util.NotificationHelper;

public class AlarmReceiver extends BroadcastReceiver {

    public static final String ACTION_ALARM_TRIGGER = "kr.codyssey.attendance.ALARM_TRIGGER";

    // K3: 예정 시각 대비 이 시간보다 오래 지연 발화되면 알림을 표시하지 않음
    // (web/js/shared-attendance.js의 ALARM_STALE_WINDOW_MS와 동일 값 — 양쪽 동기화 유지)
    private static final long STALE_WINDOW_MS = 15 * 60 * 1000;

    // Capacitor Preferences(group: codyssey_prefs)와 동일 저장소 — adapter의 STORE_KEYS.ALARMS
    private static final String PREFS_NAME = "codyssey_prefs";
    private static final String ALARMS_KEY = "codyssey_alarms";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_ALARM_TRIGGER.equals(intent.getAction())) {
            return;
        }

        String label = intent.getStringExtra("label");
        String id = intent.getStringExtra("id");

        // K7: 발화된 알람은 OS측 예약 기록에서도 제거
        AlarmPlugin.untrackScheduled(context, id);

        // M6: 발화된 알람은 저장 목록에서 제거 (유령 알람 방지 — 익스텐션과 동작 통일)
        removeFiredAlarm(context, id);

        // K3: 기기 전원이 꺼져 있던 사이 예정 시각이 지나 WorkManager가 뒤늦게 발화한 경우
        // (예: 어제 18:00 알림이 다음날 아침에 울림) — 정리만 하고 알림/이벤트는 생략
        long triggerTime = intent.getLongExtra("triggerTime", 0);
        if (triggerTime > 0 && System.currentTimeMillis() - triggerTime > STALE_WINDOW_MS) {
            return;
        }

        // 알림 표시 (title, body, id)
        NotificationHelper.showNotification(context, "⏰ 코디세이 출입 알림", label != null ? label : "알림", id);

        // R8: 앱이 살아있으면 WebView JS로 이벤트 전달 (화면 자동 갱신)
        MainActivity.emitNativeEvent("ALARM_TRIGGERED", label, id);
    }

    // 네이티브 저장소(Preferences)의 알람 목록에서 발화된 항목 제거
    private static void removeFiredAlarm(Context context, String id) {
        if (id == null) return;
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String json = prefs.getString(ALARMS_KEY, null);
            if (json == null) return;

            JSONArray arr = new JSONArray(json);
            JSONArray kept = new JSONArray();
            boolean changed = false;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject alarm = arr.optJSONObject(i);
                if (alarm != null && id.equals(alarm.optString("name"))) {
                    changed = true; // 해당 항목 제외
                    continue;
                }
                kept.put(alarm);
            }
            if (changed) {
                prefs.edit().putString(ALARMS_KEY, kept.toString()).apply();
            }
        } catch (Exception e) {
            // 목록 정리 실패는 치명적이지 않음 — 다음 앱 실행 시 동기화됨
        }
    }
}
