package kr.codyssey.attendance.receiver;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;

import kr.codyssey.attendance.plugin.PollingPlugin;
import kr.codyssey.attendance.util.DiagLog;
import kr.codyssey.attendance.util.SyncTasks;

/**
 * 30차: 5분 감지 틱 체인 — FGS 없이 브로드캐스트만으로 동작 (상시 알림 없음).
 *
 * - 사용자 지시 "15분은 김, 5분으로 통합" 반영.
 * - AlarmManager.setExactAndAllowWhileIdle(RTC_WAKEUP)으로 5분 뒤 자기 예약 →
 *   발화 시 여기서 SyncTasks(GateCheck 등)를 직접 실행. 서비스가 없으므로
 *   "감지 중" 상시 알림(FGS 필수)은 필요 없음.
 * - 정확 알람 권한이 없으면 부정확 알람으로 축소 (지연 가능 → 진단 로그로 가시화).
 * - 깊은 Doze에서는 OS가 발화를 수 분 늦출 수 있음 (플랫폼 특성, 제거 불가).
 * - WorkManager 15분 주기 동기화는 폴트러넌스(체인 끊김/부팅 보조)로 유지 —
 *   양쪽 모두 같은 SyncTasks를 실행하므로 중복 실행은 스냅샷 멱등으로 안전.
 */
public class SyncTickReceiver extends BroadcastReceiver {

    public static final String ACTION_TICK = "kr.codyssey.attendance.action.SYNC_TICK";
    public static final long TICK_MS = 5 * 60 * 1000;
    public static final int TICK_MINUTES = (int) (TICK_MS / 60000);

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_TICK.equals(intent.getAction())) return;
        if (!PollingPlugin.isEnabled(context)) return; // 설정에서 끈 상태면 체인 중단

        checkTickGap(context); // 37차: 틱 공백 진단 (OS 지연/체인 끊김 가시화)

        scheduleNextTick(context); // 체인 유지 — 실행 성공/실패와 무관하게 다음 틱 예약

        // 네트워크 호출 수행 — 리시버는 메인 스레드라 goAsync + 백그라운드 스레드
        final PendingResult pending = goAsync();
        final Context appCtx = context.getApplicationContext();
        new Thread(() -> {
            try {
                SyncTasks.run(appCtx);
            } finally {
                pending.finish();
            }
        }, "codyssey-sync-tick").start();
    }

    // 37차: 직전 틱 발화와의 간격이 비정상(정상 5분, 허용 15분=3틱)이면 진단 로그.
    // 백그라운드에서 이 로그가 쌓이면 OS가 알람을 지연시킨 것(절전/앱 제한)이고,
    // 아예 tick 기록 자체가 없으면 체인이 죽은 것(강제종료/권한)으로 구분할 수 있다.
    private static void checkTickGap(Context context) {
        try {
            SharedPreferences prefs =
                    context.getSharedPreferences("codyssey_prefs", Context.MODE_PRIVATE);
            long now = System.currentTimeMillis();
            long last = prefs.getLong("tick_last_fire", 0);
            prefs.edit().putLong("tick_last_fire", now).apply();
            if (last > 0 && now - last > 15 * 60 * 1000) {
                DiagLog.add(context, "TICK",
                        "⚠️ 감지 틱 공백 " + ((now - last) / 60000)
                                + "분 — OS가 알람을 지연(절전/앱 제한)시켰거나 체인이 끊겼던 흔적");
            }
        } catch (Exception e) { /* 진단 실패는 무시 */ }
    }

    // ===== 체인 관리 (PollingPlugin/BootReceiver/MainActivity 공용 진입점) =====

    public static void ensureChain(Context context) {
        // 이미 다음 틱이 잡혀 있으면 사실상 덮어쓰기(UpdateCurrent)라 idempotent
        scheduleNextTick(context);
    }

    public static void cancelChain(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(tickPendingIntent(context));
    }

    static void scheduleNextTick(Context context) {
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = tickPendingIntent(context);
        long nextAt = SystemClock.elapsedRealtime() + TICK_MS;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                am.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, nextAt, pi);
            } else {
                am.setExact(AlarmManager.ELAPSED_REALTIME_WAKEUP, nextAt, pi);
            }
            DiagLog.addOnChange(context, "SVC-SCHED", "ok", "5분 감지 틱 예약 정상 (정확 알람)");
        } catch (SecurityException e) {
            DiagLog.addOnChange(context, "SVC-SCHED", "denied",
                    "⚠️ 정확 알람 권한 거부 — 5분 감지 틱이 부정확해짐 (OS가 지연시킬 수 있음)");
            try {
                am.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, nextAt + TICK_MS, pi);
            } catch (Exception e2) {
                DiagLog.add(context, "SVC-SCHED", "⚠️ 감지 틱 예약 자체 실패: " + e2.getMessage());
            }
        }
    }

    static PendingIntent tickPendingIntent(Context context) {
        Intent i = new Intent(context, SyncTickReceiver.class).setAction(ACTION_TICK);
        return PendingIntent.getBroadcast(context, 0, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
