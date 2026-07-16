package kr.codyssey.attendance.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import kr.codyssey.attendance.plugin.NotificationPlugin;

public class AlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !"kr.codyssey.attendance.ALARM_TRIGGER".equals(intent.getAction())) {
            return;
        }

        String label = intent.getStringExtra("label");
        String id = intent.getStringExtra("id");

        // 알림 표시
        NotificationPlugin.showNotification(context, label != null ? label : "알림", id);

        // 웹뷰에 알람 트리거 이벤트 전달
        Intent webIntent = new Intent("kr.codyssey.attendance.ALARM_TRIGGERED");
        webIntent.putExtra("label", label);
        webIntent.putExtra("id", id);
        context.sendBroadcast(webIntent);
    }
}