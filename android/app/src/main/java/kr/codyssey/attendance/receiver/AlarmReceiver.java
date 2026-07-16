package kr.codyssey.attendance.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import kr.codyssey.attendance.MainActivity;
import kr.codyssey.attendance.plugin.NotificationPlugin;

public class AlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !"kr.codyssey.attendance.ALARM_TRIGGER".equals(intent.getAction())) {
            return;
        }

        String label = intent.getStringExtra("label");
        String id = intent.getStringExtra("id");

        // 알림 표시 (title, body, id)
        NotificationPlugin.showNotification(context, "⏰ 코디세이 출입 알림", label != null ? label : "알림", id);

        // R8: 앱이 살아있으면 WebView JS로 이벤트 전달 (화면 자동 갱신)
        MainActivity.emitNativeEvent("ALARM_TRIGGERED", label, id);
    }
}
