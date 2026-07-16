package kr.codyssey.attendance.worker;

import android.content.Context;
import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import kr.codyssey.attendance.plugin.NotificationPlugin;
import kr.codyssey.attendance.receiver.AlarmReceiver;

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

        // 알림 표시
        NotificationPlugin.showNotification(getApplicationContext(), label, id);

        // AlarmReceiver도 호출 (웹뷰 이벤트용)
        Intent intent = new Intent(getApplicationContext(), AlarmReceiver.class);
        intent.putExtra("label", label);
        intent.putExtra("id", id);
        intent.setAction("kr.codyssey.attendance.ALARM_TRIGGER");
        getApplicationContext().sendBroadcast(intent);

        return Result.success();
    }
}