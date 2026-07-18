package kr.codyssey.attendance.plugin;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import kr.codyssey.attendance.service.PollingService;
import kr.codyssey.attendance.util.DiagLog;

/** 1분 상시 감지 서비스 제어 + 절전모드(배터리 최적화) 예외 상태/요청 — JS 브릿지 (W7). */
@CapacitorPlugin(name = "PollingPlugin")
public class PollingPlugin extends Plugin {

    private static final String PREFS_NAME = "codyssey_prefs";

    @PluginMethod
    public void startDash(PluginCall call) {
        PluginCall saved = call;
        getBridge().execute(() -> {
            try {
                Context ctx = getContext();
                PollingService.setEnabled(ctx, true);
                PollingService.startDash(ctx);
                JSObject out = new JSObject();
                out.put("running", true);
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
                PollingService.setEnabled(ctx, false);
                PollingService.stopDash(ctx);
                JSObject out = new JSObject();
                out.put("running", false);
                saved.resolve(out);
            } catch (Exception e) {
                saved.reject("stopDash failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void getDashStatus(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        JSObject out = new JSObject();
        out.put("enabled", PollingService.isEnabled(ctx));
        out.put("lastTick", prefs.getLong("dash_last_tick", 0));
        // 20차: 백그라운드 알람 건강 상태를 JS(설정/진단)에서도 보이게 — 두 축이 물린다
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
                // 절전모드 예외 요청 — 시스템 다이얼로그 개시 (사용자가 거부할 수 있음)
                Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                        android.net.Uri.parse("package:" + ctx.getPackageName()));
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                ctx.startActivity(intent);
            } catch (Exception e) {
                // 대화상자를 열지 못하는 단말 대비 — 설정 화면으로 유도
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
