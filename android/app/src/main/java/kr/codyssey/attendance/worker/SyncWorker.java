package kr.codyssey.attendance.worker;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import kr.codyssey.attendance.MainActivity;
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

            // K13: 아무 수신자도 없던 임시 브로드캐스트 대신 JS 이벤트로 전달 —
            // 앱이 살아있으면 화면이 스스로 최신 데이터로 갱신됨 (popup.js가 SYNC_COMPLETE 처리)
            MainActivity.emitNativeEvent("SYNC_COMPLETE", null, null);

            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }
}