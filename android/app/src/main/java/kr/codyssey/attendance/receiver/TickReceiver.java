package kr.codyssey.attendance.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import kr.codyssey.attendance.service.PollingService;
import kr.codyssey.attendance.util.DiagLog;

/**
 * 20차: 1분 상시 감지 "부활 알람" 수신기.
 *
 * 배경(사용자 결함 제보: 창이 남아가 있거나 꺼져있으면 알람이 안 옴):
 * 기존에는 부활 알람을 PendingIntent.getService(=백그라운드 startService)로 볼냈다.
 * 앱 프로세스가 살아있지 않은 상태에서 알람이 울리면 백그라운드 서비스 시작 제한
 * (특히 specialUse FGS 제한)에 막혀 서비스가 부활하지 못하고, 사용자가 앱을 열어야만
 * 다시 감지가 시작되는 결함이 있었다.
 *
 * 브로드캐스트 수신 자체는 백그라운드 시작 제한이 없고, 알람 발화 시점에는 임시
 * 화이트리스트가 적용되어 여기서의 startForegroundService가 허용된다.
 */
public class TickReceiver extends BroadcastReceiver {

    public static final String ACTION_TICK = "kr.codyssey.attendance.action.POLL_TICK";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_TICK.equals(intent.getAction())) return;
        if (!PollingService.isEnabled(context)) return; // 설정에서 끈 상태면 부활하지 않음
        try {
            PollingService.startDash(context);
        } catch (Exception e) {
            DiagLog.add(context, "SVC", "⚠️ 틱 알람 수신 후 서비스 복구 실패: " + e.getMessage()
                    + " — 다음 앱 실행 시 복원됨");
        }
    }
}
