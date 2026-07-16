package kr.codyssey.attendance.receiver;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import kr.codyssey.attendance.worker.SyncWorker;

public class BootReceiver extends BroadcastReceiver {

    private static final String PREFS_NAME = "codyssey_prefs";
    private static final String ALARMS_KEY = "codyssey_alarms";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            return;
        }

        // N7: keep-alive 설정이 켜져 있을 때만 주기 동기화 재시작
        if (isKeepAliveEnabled(context)) {
            PeriodicWorkRequest syncWork = new PeriodicWorkRequest.Builder(
                    SyncWorker.class, 30, TimeUnit.MINUTES)
                    .addTag("codyssey_periodic_sync")
                    .build();

            WorkManager.getInstance(context)
                    .enqueueUniquePeriodicWork(
                            "codyssey_periodic_sync",
                            ExistingPeriodicWorkPolicy.UPDATE,
                            syncWork
                    );
        } else {
            WorkManager.getInstance(context).cancelUniqueWork("codyssey_periodic_sync");
        }

        // L10: 부팅으로 소실된 1회성 알람 복원 (WorkManager 태스크는 유지되지만
        // AlarmManager exact alarm은 재부팅 시 사라지므로, 미래 알람만 다시 예약)
        restoreOneShotAlarms(context);
    }

    private boolean isKeepAliveEnabled(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String settingsJson = prefs.getString("settings", null);
            if (settingsJson == null) return false;
            return new JSONObject(settingsJson).optBoolean("keepAliveEnabled", false);
        } catch (Exception e) {
            return false;
        }
    }

    private void restoreOneShotAlarms(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String alarmsJson = prefs.getString(ALARMS_KEY, null);
            if (alarmsJson == null) return;

            AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (alarmManager == null) return;

            // 정확 알람 권한이 없으면 WorkManager 백업 경로가 동작하므로 여기서는 걸어넘음
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
                return;
            }

            JSONArray arr = new JSONArray(alarmsJson);
            long now = System.currentTimeMillis();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject alarm = arr.optJSONObject(i);
                if (alarm == null) continue;

                long time = alarm.optLong("time", 0);
                String name = alarm.optString("name", null);
                String label = alarm.optString("label", "알림");
                if (name == null || time <= now) continue; // 지난 알람은 복원 불필요

                Intent alarmIntent = new Intent(context, AlarmReceiver.class);
                alarmIntent.setAction(AlarmReceiver.ACTION_ALARM_TRIGGER);
                alarmIntent.putExtra("label", label);
                alarmIntent.putExtra("id", name);

                PendingIntent pendingIntent = PendingIntent.getBroadcast(
                        context,
                        name.hashCode(),
                        alarmIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, time, pendingIntent);
                } else {
                    alarmManager.setExact(AlarmManager.RTC_WAKEUP, time, pendingIntent);
                }
            }
        } catch (Exception e) {
            // 복원 실패 시 WorkManager 경로 또는 다음 앱 실행에서 재동기화
        }
    }
}
