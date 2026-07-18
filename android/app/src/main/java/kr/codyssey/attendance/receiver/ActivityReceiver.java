package kr.codyssey.attendance.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import com.google.android.gms.location.ActivityRecognitionResult;
import com.google.android.gms.location.DetectedActivity;

import kr.codyssey.attendance.util.DiagLog;

/**
 * 31차(C안) ⑥: 활동 인식 결과 수신 — 위치는 모르고 행동(정지/걷기/차량)만 기록.
 * 물리 판정의 신뢰도 보조(예: 이탈 직후 차량 탑승 = 귀가 신뢰도↑)와 수집 데이터에 첨부.
 */
public class ActivityReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ActivityRecognitionResult.hasResult(intent)) return;
        ActivityRecognitionResult result = ActivityRecognitionResult.extractResult(intent);
        if (result == null) return;
        DetectedActivity activity = result.getMostProbableActivity();
        String label = labelFor(activity.getType()) + ":" + activity.getConfidence();
        context.getSharedPreferences("codyssey_prefs", Context.MODE_PRIVATE)
                .edit().putString("phy_activity", label).apply();
        DiagLog.addOnChange(context, "PHY", "act_" + labelFor(activity.getType()),
                "활동 인식: " + label);
    }

    static String labelFor(int type) {
        switch (type) {
            case DetectedActivity.IN_VEHICLE: return "vehicle";
            case DetectedActivity.ON_BICYCLE: return "bicycle";
            case DetectedActivity.ON_FOOT: return "foot";
            case DetectedActivity.RUNNING: return "running";
            case DetectedActivity.STILL: return "still";
            case DetectedActivity.WALKING: return "walking";
            default: return "unknown";
        }
    }
}
