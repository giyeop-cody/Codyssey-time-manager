package kr.codyssey.attendance.worker;

import android.content.Context;
import android.content.Intent;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import kr.codyssey.attendance.util.CookieManager;

public class SyncWorker extends Worker {

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            // 백그라운드에서 세션 유지 핑
            CookieManager.pingKeepAlive(getApplicationContext());

            // 웹뷰에 동기화 이벤트 전송
            Intent intent = new Intent("kr.codyssey.attendance.SYNC_COMPLETE");
            getApplicationContext().sendBroadcast(intent);

            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }
}