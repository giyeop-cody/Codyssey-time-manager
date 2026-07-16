package kr.codyssey.attendance.plugin;

import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.app.PendingIntent;
import android.os.Build;
import android.provider.Settings;

import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.TimeUnit;

import kr.codyssey.attendance.receiver.AlarmReceiver;
import kr.codyssey.attendance.worker.AlarmWorker;
import kr.codyssey.attendance.worker.SyncWorker;

@CapacitorPlugin(name = "AlarmPlugin")
public class AlarmPlugin extends Plugin {

    // 공통 태그로 모든 알람 작업을 묶고(cancelAll 가능), id 태그로 개별 취소
    private static final String WORK_TAG_ALARM = "codyssey_alarm_";
    private static final String WORK_TAG_PERIODIC = "codyssey_periodic_sync";

    @PluginMethod
    public void schedule(PluginCall call) {
        long triggerTimeMillis = call.getLong("triggerTimeMillis");
        String label = call.getString("label", "알람");
        String id = call.getString("id", String.valueOf(System.currentTimeMillis()));

        if (triggerTimeMillis <= 0) {
            call.reject("triggerTimeMillis is required and must be future");
            return;
        }

        long now = System.currentTimeMillis();
        if (triggerTimeMillis <= now) {
            call.reject("triggerTimeMillis must be in the future");
            return;
        }

        // M2 개선: AlarmManager와 WorkManager를 동시에 등록하면 알람이 두 번 울림.
        // 상호배타 원칙 — 정확 알람 가능하면 AlarmManager만, 불가하면 WorkManager만 사용.
        boolean exact = canScheduleExact();

        if (exact) {
            scheduleExactAlarm(triggerTimeMillis, id, label);
        } else {
            enqueueAlarmWork(triggerTimeMillis - now, id, label, triggerTimeMillis);
        }

        JSObject result = new JSObject();
        result.put("success", true);
        result.put("id", id);
        result.put("triggerTime", triggerTimeMillis);
        result.put("exact", exact); // M5: JS가 부정확 알람 여부를 알 수 있도록
        call.resolve(result);
    }

    // 현재 정확 알람 사용 가능 여부 (M5 처리의 기준)
    private boolean canScheduleExact() {
        AlarmManager alarmManager = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return alarmManager.canScheduleExactAlarms();
        }
        return true; // S 미만은 별도 권한 없이 정확 알람 가능
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }

        WorkManager.getInstance(getContext()).cancelAllWorkByTag(WORK_TAG_ALARM + id);
        cancelExactAlarm(id);

        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        // 공통 태그로 한번에 취소 (예약 시 WORK_TAG_ALARM을 항상 추가함)
        WorkManager.getInstance(getContext()).cancelAllWorkByTag(WORK_TAG_ALARM);
        // AlarmManager 쪽은 id별 PendingIntent라 모륵 없음 — 스토리지 목록 순회는 JS(LOGOUT)에서 처리
        call.resolve();
    }

    @PluginMethod
    public void schedulePeriodicSync(PluginCall call) {
        int intervalMinutes = call.getInt("intervalMinutes", 30);

        PeriodicWorkRequest syncWork = new PeriodicWorkRequest.Builder(
                SyncWorker.class, intervalMinutes, TimeUnit.MINUTES)
                .addTag(WORK_TAG_PERIODIC)
                .build();

        WorkManager.getInstance(getContext())
                .enqueueUniquePeriodicWork(
                        WORK_TAG_PERIODIC,
                        ExistingPeriodicWorkPolicy.UPDATE, // 이미 예약된 주기는 유지 (팝업 열 때마다 리셋 방지)
                        syncWork
                );

        JSObject result = new JSObject();
        result.put("success", true);
        result.put("intervalMinutes", intervalMinutes);
        call.resolve(result);
    }

    @PluginMethod
    public void cancelPeriodicSync(PluginCall call) {
        WorkManager.getInstance(getContext()).cancelUniqueWork(WORK_TAG_PERIODIC);
        call.resolve();
    }

    // M5: 정확 알람 권한 설정 화면으로 유도 (Android 12+ 전용)
    @PluginMethod
    public void requestExactAlarmPermission(PluginCall call) {
        boolean granted = canScheduleExact();
        if (!granted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                Intent intent = new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            } catch (Exception e) {
                // 일부 기기에서 인텐트 미지원 — 알람 설정 화면으로 폼백
                try {
                    Intent fallback = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                    fallback.putExtra(Settings.EXTRA_APP_PACKAGE, getContext().getPackageName());
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    getContext().startActivity(fallback);
                } catch (Exception ignored) { /* 무시 */ }
            }
        }
        JSObject result = new JSObject();
        result.put("granted", canScheduleExact());
        call.resolve(result);
    }

    // WorkManager 경로 (정확 알람 불가 시의 폼백)
    private void enqueueAlarmWork(long delayMillis, String id, String label, long triggerTimeMillis) {
        Data inputData = new Data.Builder()
                .putString("label", label)
                .putString("id", id)
                .putLong("triggerTime", triggerTimeMillis)
                .build();

        OneTimeWorkRequest alarmWork = new OneTimeWorkRequest.Builder(AlarmWorker.class)
                .setInputData(inputData)
                .setInitialDelay(delayMillis, TimeUnit.MILLISECONDS)
                .addTag(WORK_TAG_ALARM)          // 공통 태그 (cancelAll용)
                .addTag(WORK_TAG_ALARM + id)     // 개별 태그 (cancel용)
                .build();

        WorkManager.getInstance(getContext()).enqueue(alarmWork);
    }

    private void scheduleExactAlarm(long triggerTimeMillis, String id, String label) {
        AlarmManager alarmManager = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;

        Intent intent = new Intent(getContext(), AlarmReceiver.class);
        intent.putExtra("label", label);
        intent.putExtra("id", id);
        intent.setAction(AlarmReceiver.ACTION_ALARM_TRIGGER);

        PendingIntent pendingIntent = PendingIntent.getBroadcast(
                getContext(),
                id.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    triggerTimeMillis,
                    pendingIntent
            );
        } else {
            alarmManager.setExact(
                    AlarmManager.RTC_WAKEUP,
                    triggerTimeMillis,
                    pendingIntent
            );
        }
    }

    private void cancelExactAlarm(String id) {
        AlarmManager alarmManager = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;

        Intent intent = new Intent(getContext(), AlarmReceiver.class);
        intent.setAction(AlarmReceiver.ACTION_ALARM_TRIGGER);

        PendingIntent pendingIntent = PendingIntent.getBroadcast(
                getContext(),
                id.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        alarmManager.cancel(pendingIntent);
    }
}
