package kr.codyssey.attendance.plugin;

import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.app.PendingIntent;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;

import androidx.work.Data;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import kr.codyssey.attendance.receiver.AlarmReceiver;
import kr.codyssey.attendance.worker.AlarmWorker;
import kr.codyssey.attendance.worker.SyncWorker;

@CapacitorPlugin(name = "AlarmPlugin")
public class AlarmPlugin extends Plugin {

    // 공통 태그로 모든 알람 작업을 묶고(cancelAll 가능), id 태그로 개별 취소
    public static final String WORK_TAG_ALARM = "codyssey_alarm_";
    private static final String WORK_TAG_PERIODIC = "codyssey_periodic_sync";

    // ===== K7: 예약된 알람 id를 네이티브가 자체 추적 =====
    // (JS Preferences 목록은 사용자 데이터이며 저장 실패/유실될 수 있어,
    //  AlarmManager 정확 알람의 완전한 해제를 위해 OS측 기록을 별도 유지)
    private static final String TRACK_PREFS = "codyssey_alarm_ids";
    private static final String TRACK_KEY = "ids";

    public static synchronized void trackScheduled(Context ctx, String id) {
        if (ctx == null || id == null) return;
        SharedPreferences prefs = ctx.getSharedPreferences(TRACK_PREFS, Context.MODE_PRIVATE);
        Set<String> ids = new HashSet<>(prefs.getStringSet(TRACK_KEY, new HashSet<String>()));
        if (ids.add(id)) {
            prefs.edit().putStringSet(TRACK_KEY, ids).apply();
        }
    }

    public static synchronized void untrackScheduled(Context ctx, String id) {
        if (ctx == null || id == null) return;
        SharedPreferences prefs = ctx.getSharedPreferences(TRACK_PREFS, Context.MODE_PRIVATE);
        Set<String> ids = new HashSet<>(prefs.getStringSet(TRACK_KEY, new HashSet<String>()));
        if (ids.remove(id)) {
            prefs.edit().putStringSet(TRACK_KEY, ids).apply();
        }
    }

    public static Set<String> trackedIds(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(TRACK_PREFS, Context.MODE_PRIVATE);
        return new HashSet<>(prefs.getStringSet(TRACK_KEY, new HashSet<String>()));
    }

    private static synchronized void clearTracked(Context ctx) {
        ctx.getSharedPreferences(TRACK_PREFS, Context.MODE_PRIVATE).edit().remove(TRACK_KEY).apply();
    }

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
        boolean usedExact = false;

        if (exact) {
            try {
                scheduleExactAlarm(triggerTimeMillis, id, label);
                usedExact = true;
            } catch (SecurityException se) {
                // 20차: 체크 직후 권한이 빠지는 레이스 — 흔들림 없이 WorkManager 경로로 전환
                kr.codyssey.attendance.util.DiagLog.add(getContext(), "ALARM-S",
                        "⚠️ 정확 알람 권한이 예약 직전에 해제됨 — 부정확 경로로 변경 예약 (지연 가능)");
                enqueueAlarmWork(triggerTimeMillis - now, id, label, triggerTimeMillis);
            }
        } else {
            enqueueAlarmWork(triggerTimeMillis - now, id, label, triggerTimeMillis);
        }
        trackScheduled(getContext(), id); // K7: OS측 예약 기록

        // 20차: 알람 "예약 자체"를 진단 로그에 남김 — "예약은 됐는데 안 울림(시스템 지연)"과
        // "예약이 없었음(앱 미실행)"을 사용자가 로그만으로 구별할 수 있게 함
        String when = new java.text.SimpleDateFormat("MM/dd HH:mm", java.util.Locale.US)
                .format(new java.util.Date(triggerTimeMillis));
        kr.codyssey.attendance.util.DiagLog.add(getContext(), "ALARM-S",
                "알람 예약: [" + label + "] " + when + (usedExact ? " (정확)" : " (부정확 — OS 지연 가능)"));

        JSObject result = new JSObject();
        result.put("success", true);
        result.put("id", id);
        result.put("triggerTime", triggerTimeMillis);
        result.put("exact", usedExact); // M5: JS가 부정확 알람 여부를 알 수 있도록
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
        cancelExactAlarm(getContext(), id);
        untrackScheduled(getContext(), id); // K7

        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }

    @PluginMethod
    public void cancelAll(PluginCall call) {
        // 공통 태그로 한번에 취소 (예약 시 WORK_TAG_ALARM을 항상 추가함)
        WorkManager.getInstance(getContext()).cancelAllWorkByTag(WORK_TAG_ALARM);
        // K7: AlarmManager 정확 알람은 id별 PendingIntent라 태그 취소가 불가 —
        // 네이티브 추적 목록을 순회해 전부 해제 (JS 목록 누락분도 커버)
        Context ctx = getContext();
        for (String id : trackedIds(ctx)) {
            cancelExactAlarm(ctx, id);
        }
        clearTracked(ctx);
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
    // unique + REPLACE: 같은 id로 재예약 시 OS 수준에서 1걸만 유지 (이중 발화 방지)
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

        WorkManager.getInstance(getContext())
                .enqueueUniqueWork(
                        WORK_TAG_ALARM + id,
                        ExistingWorkPolicy.REPLACE,
                        alarmWork
                );
    }

    private void scheduleExactAlarm(long triggerTimeMillis, String id, String label) {
        scheduleExactAlarmAt(getContext(), triggerTimeMillis, id, label);
    }

    // K7/K4 연계: 부트 복원 등 컨텍스트만 있는 곳에서도 사용할 수 있도록 정적 공개
    public static void scheduleExactAlarmAt(Context ctx, long triggerTimeMillis, String id, String label) {
        scheduleExactAlarmAt(ctx, triggerTimeMillis, id, label, 0L);
    }

    // staleWindowMs > 0 이면 그 값이 K3(지연 발화 무시) 상한을 대신함 — 평가 알람은
    // '평가 시작+5분'까지 늦게도 알리는 규칙(익스텐션과 통일)을 위해 lead+5분을 전달 (B9)
    public static void scheduleExactAlarmAt(Context ctx, long triggerTimeMillis, String id, String label, long staleWindowMs) {
        AlarmManager alarmManager = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;

        Intent intent = new Intent(ctx, AlarmReceiver.class);
        intent.putExtra("label", label);
        intent.putExtra("id", id);
        intent.putExtra("triggerTime", triggerTimeMillis); // K3: 수신 측 지연 발화 판정용
        if (staleWindowMs > 0) {
            intent.putExtra("staleWindowMs", staleWindowMs);
        }
        intent.setAction(AlarmReceiver.ACTION_ALARM_TRIGGER);

        PendingIntent pendingIntent = PendingIntent.getBroadcast(
                ctx,
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

    public static void cancelExactAlarm(Context ctx, String id) {
        AlarmManager alarmManager = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;

        Intent intent = new Intent(ctx, AlarmReceiver.class);
        intent.setAction(AlarmReceiver.ACTION_ALARM_TRIGGER);

        PendingIntent pendingIntent = PendingIntent.getBroadcast(
                ctx,
                id.hashCode(),
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        alarmManager.cancel(pendingIntent);
    }

    // W7(18차): 알람 발화 소리 ON/OFF — alarmsound=0이면 해당 알람만 조용히 (NotificationHelper 참조)
    @PluginMethod
    public void setAlarmSound(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        getContext().getSharedPreferences("codyssey_prefs", Context.MODE_PRIVATE)
                .edit()
                .putBoolean("alarm_sound", enabled == null || enabled)
                .apply();
        JSObject out = new JSObject();
        out.put("ok", true);
        call.resolve(out);
    }
}
