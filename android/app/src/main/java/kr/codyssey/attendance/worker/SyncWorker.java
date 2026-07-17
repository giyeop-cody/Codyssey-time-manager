package kr.codyssey.attendance.worker;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import kr.codyssey.attendance.MainActivity;
import kr.codyssey.attendance.util.CookieManager;
import kr.codyssey.attendance.util.EvalSync;
import kr.codyssey.attendance.util.GateCheck;

public class SyncWorker extends Worker {

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            // keep-alive가 켜져 있을 때만 세션 유지 핑 (G1 도입으로 주기 작업이 상시화되어도
            // keep-alive opt-in 의미는 그대로 유지 — 출입 조회(GateCheck)와 세션 핑은 별개)
            // B4/W6: 입·퇴실 감지가 켜져 있으면 GateCheck의 인증 조회가 세션을 유지하므로 핑 생략
            boolean keepAliveEnabled = isKeepAliveEnabled(getApplicationContext());
            boolean gateEnabled = isGateNotifyEnabled(getApplicationContext());
            if (keepAliveEnabled && !gateEnabled) {
                CookieManager.pingKeepAlive(getApplicationContext());
            }

            // G1: 입·퇴실 처리 감지 — 앱이 닫혀 있어도 주기적으로 출입 변화를 확인해 알림.
            // 남게 호출되지 않도록 GateCheck 남부에서 모든 예외를 흡수함 (실패 시 Result.retry 폭주 방지)
            GateCheck.run(getApplicationContext());

            // E2: 평가 일정 자동 연동 — 6시간 스로틀 내장이라 매 주기 호출필요 없음
            // (JS와 eval_sync_state를 공유해 중복 등록/알림 없음)
            EvalSync.run(getApplicationContext());

            // K13: 아무 수신자도 없던 임시 브로드캐스트 대신 JS 이벤트로 전달 —
            // 앱이 살아있으면 화면이 스스로 최신 데이터로 갱신됨 (popup.js가 SYNC_COMPLETE 처리)
            MainActivity.emitNativeEvent("SYNC_COMPLETE", null, null);

            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }

    private boolean isKeepAliveEnabled(Context context) {
        try {
            android.content.SharedPreferences prefs =
                    context.getSharedPreferences("codyssey_prefs", Context.MODE_PRIVATE);
            String settingsJson = prefs.getString("settings", null);
            if (settingsJson == null) return false;
            return new org.json.JSONObject(settingsJson).optBoolean("keepAliveEnabled", false);
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isGateNotifyEnabled(Context context) {
        try {
            android.content.SharedPreferences prefs =
                    context.getSharedPreferences("codyssey_prefs", Context.MODE_PRIVATE);
            String settingsJson = prefs.getString("settings", null);
            if (settingsJson == null) return true; // 기본 ON (설정 저장 전 부팅 포함)
            return new org.json.JSONObject(settingsJson).optBoolean("gateNotifyEnabled", true);
        } catch (Exception e) {
            return true;
        }
    }
}