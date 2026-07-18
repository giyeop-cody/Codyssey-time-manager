package kr.codyssey.attendance.plugin;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.TimeUnit;

import kr.codyssey.attendance.util.DiagLog;
import kr.codyssey.attendance.receiver.SyncTickReceiver;
import kr.codyssey.attendance.worker.SyncWorker;

/**
 * 백그라운드 감지(주기 동기화) 제어 + 절전모드 예외 상태/요청 — JS 브릿지.
 *
 * 28차: 1분 FGS 폐기 → 30차: 사용자 지시로 감지 간격을 5분으로 통합.
 *  구조: SyncTickReceiver(정확 알람 5분 체인, 상시 알림 없음) = 주 경로
 *       + WorkManager 15분 SyncWorker = 폴트레런스 백업 (둘 다 SyncTasks 실행)
 *  알람(퇴실/목표/평가)은 계속 AlarmManager 시스템 콜 1회 등록 (AlarmPlugin).
 *
 * startDash/stopDash의 의미 = 5분 틱 체인 + 백업 주기 작업 예약/해제 (dash_enabled 유지).
 */
@CapacitorPlugin(name = "PollingPlugin")
public class PollingPlugin extends Plugin {

    private static final String PREFS_NAME = "codyssey_prefs";
    public static final String PERIODIC_WORK_NAME = "codyssey_periodic_sync";
    public static final int TICK_MINUTES = SyncTickReceiver.TICK_MINUTES; // 5분 (주 경로)
    private static final int PERIODIC_MINUTES = 15; // WorkManager 백업 주기 (시스템 갱신 하한)

    @PluginMethod
    public void startDash(PluginCall call) {
        PluginCall saved = call;
        getBridge().execute(() -> {
            try {
                Context ctx = getContext();
                setEnabled(ctx, true);
                SyncTickReceiver.ensureChain(ctx);   // 30차: 5분 틱 (주 경로)
                ensurePeriodicSync(ctx);             // 15분 백업
                DiagLog.add(ctx, "SVC", "백그라운드 감지 켜짐 — 5분 틱 체인 + 15분 백업 주기 예약");
                JSObject out = new JSObject();
                out.put("running", true);
                out.put("intervalMinutes", TICK_MINUTES);
                saved.resolve(out);
            } catch (Exception e) {
                saved.reject("startDash failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stopDash(PluginCall call) {
        PluginCall saved = call;
        getBridge().execute(() -> {
            try {
                Context ctx = getContext();
                setEnabled(ctx, false);
                SyncTickReceiver.cancelChain(ctx);
                WorkManager.getInstance(ctx).cancelUniqueWork(PERIODIC_WORK_NAME);
                DiagLog.add(ctx, "SVC", "백그라운드 감지 꺼짐 — 5분 틱 체인 + 백업 주기 해제");
                JSObject out = new JSObject();
                out.put("running", false);
                saved.resolve(out);
            } catch (Exception e) {
                saved.reject("stopDash failed: " + e.getMessage());
            }
        });
    }

    // 28차: 주기 감지 예약의 단일 진입점 (MainActivity/BootReceiver/PollingPlugin 공용)
    public static void ensurePeriodicSync(Context ctx) {
        PeriodicWorkRequest syncWork = new PeriodicWorkRequest.Builder(
                SyncWorker.class, PERIODIC_MINUTES, TimeUnit.MINUTES)
                .addTag(PERIODIC_WORK_NAME)
                .build();
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                PERIODIC_WORK_NAME,
                ExistingPeriodicWorkPolicy.UPDATE, // 이미 예약된 주기는 유지
                syncWork);
    }

    public static boolean isEnabled(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean("dash_enabled", false);
    }

    public static void setEnabled(Context context, boolean enabled) {
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().putBoolean("dash_enabled", enabled).apply();
    }

    @PluginMethod
    public void getDashStatus(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        JSObject out = new JSObject();
        out.put("enabled", isEnabled(ctx));
        out.put("intervalMinutes", TICK_MINUTES);
        out.put("lastTick", prefs.getLong("dash_last_tick", 0));
        // 백그라운드 알람 건강 상태 (설정/진단 UI에서 표시)
        android.app.AlarmManager am = (android.app.AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        boolean exact = am != null && (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S
                || am.canScheduleExactAlarms());
        out.put("exactAlarm", exact);
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        out.put("batteryExempt", pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName()));
        call.resolve(out);
    }

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        boolean granted = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        JSObject out = new JSObject();
        out.put("granted", granted);
        call.resolve(out);
    }

    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        Context ctx = getContext();
        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        boolean already = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        if (!already) {
            try {
                // 절전모드 예외 요청 — 시스템 대화상자 개시 (사용자가 거부할 수 있음)
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        android.net.Uri.parse("package:" + ctx.getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(intent);
            } catch (Exception e) {
                try {
                    Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    ctx.startActivity(fallback);
                } catch (Exception ignored) { /* 설정 진입 실패도 치명 아님 */ }
            }
        }
        JSObject out = new JSObject();
        out.put("alreadyExempt", already);
        call.resolve(out);
    }

    // ===== 19차: 진단 로그 JS 브릿지 (네이티브/JS가 같은 링버퍼 공유) =====

    @PluginMethod
    public void logDiag(PluginCall call) {
        String tag = call.getString("tag", "JS");
        String msg = call.getString("msg", "");
        DiagLog.add(getContext(), tag, msg);
        call.resolve(new JSObject());
    }

    @PluginMethod
    public void getDiagLog(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        JSObject out = new JSObject();
        out.put("raw", prefs.getString("diag_log", "[]"));
        call.resolve(out);
    }

    @PluginMethod
    public void clearDiagLog(PluginCall call) {
        getContext().getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().remove("diag_log").apply();
        call.resolve(new JSObject());
    }
}
