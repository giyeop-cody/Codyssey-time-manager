package kr.codyssey.attendance.worker;

import android.content.Context;
import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import kr.codyssey.attendance.receiver.AlarmReceiver;

// 정확 알람(AlarmManager) 불가 시 사용되는 WorkManager 경로.
// 알림 표시/목록 정리/JS 이벤트는 AlarmReceiver에 일원화 (이중 알림 방지 — M2 연계).
public class AlarmWorker extends Worker {

    public AlarmWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        String label = getInputData().getString("label");
        String id = getInputData().getString("id");
        long triggerTime = getInputData().getLong("triggerTime", 0);

        // AlarmReceiver로 위임 (알림 표시 + 저장 목록 정리 + JS 이벤트)
        // K3: triggerTime을 함께 넘겨 수신 측에서 지연 발화 스킵 판정
        Intent intent = new Intent(getApplicationContext(), AlarmReceiver.class);
        intent.putExtra("label", label);
        intent.putExtra("id", id);
        intent.putExtra("triggerTime", triggerTime);
        intent.setAction(AlarmReceiver.ACTION_ALARM_TRIGGER);
        getApplicationContext().sendBroadcast(intent);

        return Result.success();
    }
}
