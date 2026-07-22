package kr.codyssey.attendance.util;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

/**
 * 30차: 5분 감지 틱과 15분 WorkManager 백업이 공유하는 1회 실행 본체.
 * (구 PollingService.doTick + SyncWorker.doWork를 단일 소스로 통합)
 *
 * 수행: (keep-alive 켬·감지 꺼짐일 때만) 세션 핑 → GateCheck(입·퇴실 감지 +
 * 29차 자정 롤오버 확인) → EvalSync(6시간 스로틀 내장) → 세션 쿠키 전이 기록 →
 * "마지막 감지" 시각 갱신. 모든 예외는 내부에서 흡수 (다음 주기에 재시도).
 */
public final class SyncTasks {

    private static final String PREFS_NAME = "codyssey_prefs";

    private SyncTasks() {}

    public static void run(Context context) {
        try {
            // keep-alive가 켜져 있고 입·퇴실 감지가 꺼져 있을 때만 세션 유지 핑.
            // (GateCheck의 인증 조회 자체가 세션을 유지하므로 감지 켜짐이면 핑 생략 — B4/W6)
            if (isKeepAliveEnabled(context) && !isGateNotifyEnabled(context)) {
                CookieManager.pingKeepAlive(context);
            }

            GateCheck.run(context);  // 내부 gateNotifyEnabled 확인 + 29차 롤오버 확인 포함
            MonthlyDeadlineCheck.run(context); // 36차: 월 출입 페이스/마감 경고 (6시간 스로틀·설정 게이트 내장)
            EvalSync.run(context);   // 6시간 스로틀 내장 — 매 틱 호출필요 없음
            PhysicalCheck.sampleAndEvaluate(context); // 31차: 물리 탐지 (내부 phy_enabled 게이트)

            // 인증 확보 여부 전이 — 41차: 저장소 쿠키 또는 백업 중 하나면 서버 조회 가능
            boolean hasCookie = CookieManager.hasUsableSession(context);
            DiagLog.addOnChange(context, "COOKIE", "sess", hasCookie ? "have" : "none",
                    hasCookie ? "세션 확보 (쿠키 저장소 또는 백업) — 서버 조회 가능"
                              : "⚠️ 세션 쿠키·백업 모두 소실 — 이후 서버 조회는 302로 실패 → 재로그인 필요");

            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit()
                    .putLong("dash_last_tick", System.currentTimeMillis())
                    .apply();
        } catch (Exception e) { /* 틱 실패는 다음 틱으로 */ }
    }

    static boolean isKeepAliveEnabled(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String settingsJson = prefs.getString("settings", null);
            if (settingsJson == null) return true; // 기본값: 켬
            return new JSONObject(settingsJson).optBoolean("keepAliveEnabled", true);
        } catch (Exception e) {
            return true;
        }
    }

    static boolean isGateNotifyEnabled(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String settingsJson = prefs.getString("settings", null);
            if (settingsJson == null) return true; // 기본값: 켬
            return new JSONObject(settingsJson).optBoolean("gateNotifyEnabled", true);
        } catch (Exception e) {
            return true;
        }
    }
}
