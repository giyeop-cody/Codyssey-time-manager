package kr.codyssey.attendance.plugin;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;

import androidx.annotation.NonNull;
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

        long delay = triggerTimeMillis - now;

        // WorkManager로 정확한 알림 예약 (Doze 모드 대응)
        Data inputData = new Data.Builder()
                .putString("label", label)
                .putString("id", id)
                .putLong("triggerTime", triggerTimeMillis)
                .build();

        OneTimeWorkRequest alarmWork = new OneTimeWorkRequest.Builder(AlarmWorker.class)
                .setInputData(inputData)
                .setInitialDelay(delay, TimeUnit.MILLISECONDS)
                .addTag(WORK_TAG_ALARM + id)
                .build();

        WorkManager.getInstance(getContext()).enqueue(alarmWork);

        // 정확한 시간 보장을 위해 AlarmManager도 병행 (Android 12+ exact alarm 권한 필요)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            scheduleExactAlarm(triggerTimeMillis, id, label);
        }

        JSObject result = new JSObject();
        result.put("success", true);
        result.put("id", id);
        result.put("triggerTime", triggerTimeMillis);
        call.resolve(result);
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        String id = call.getString("id");
        if (id == null) {
            call.reject("id is required");
            return;
        }

        WorkManager.getInstance(getContext()).cancelAllWorkByTag(WORK_TAG_ALARM + id);

        // AlarmManager 취소
        cancelExactAlarm(id);

        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        WorkManager.getInstance(getContext()).cancelAllWorkByTag(WORK_TAG_ALARM);
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

    private void scheduleExactAlarm(long triggerTimeMillis, String id, String label) {
        AlarmManager alarmManager = (AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;

        Intent intent = new Intent(getContext(), AlarmReceiver.class);
        intent.putExtra("label", label);
        intent.putExtra("id", id);
        intent.setAction("kr.codyssey.attendance.ALARM_TRIGGER");

        PendingIntent pendingIntent = PendingIntent.getBroadcast(
                getContext(),
                id.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (alarmManager.canScheduleExactAlarms()) {
                alarmManager.setExactAndAllowWhileIdle(
                        AlarmManager.RTC_WAKEUP,
                        triggerTimeMillis,
                        pendingIntent
                );
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
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
        intent.setAction("kr.codyssey.attendance.ALARM_TRIGGER");

        PendingIntent pendingIntent = PendingIntent.getBroadcast(
                getContext(),
                id.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        alarmManager.cancel(pendingIntent);
    }
}