package kr.codyssey.attendance.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import kr.codyssey.attendance.MainActivity;
import kr.codyssey.attendance.plugin.NotificationPlugin;

public class AlarmReceiver extends BroadcastReceiver {

    public static final String ACTION_ALARM_TRIGGER = "kr.codyssey.attendance.ALARM_TRIGGER";

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

        // 알림 표시 (title, body, id)
        NotificationPlugin.showNotification(context, "⏰ 코디세이 출입 알림", label != null ? label : "알림", id);

        // M6: 발화된 알람은 저장 목록에서 제거 (유령 알람 방지 — 익스텐션과 동작 통일)
        removeFiredAlarm(context, id);

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
