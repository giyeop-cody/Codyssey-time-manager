package kr.codyssey.attendance.worker;

import android.content.Context;

import androidx.annotation.NonNull;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import kr.codyssey.attendance.MainActivity;
import kr.codyssey.attendance.util.SyncTasks;

/**
 * 주기 동기화 워커 (WorkManager 15분 — 시스템이 보장하는 백업 경로).
 * 30차: 본체는 SyncTasks로 통합 — 5분 틱 리시버(SyncTickReceiver)와 동일한 작업을
 * 더 느린 안전망 주기로 실행. 양쪽이 같은 동기화라 중복 실행도 스냅샷 멱등으로 안전.
 */
public class SyncWorker extends Worker {

    public SyncWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        try {
            SyncTasks.run(getApplicationContext());

            // K13: JS 이벤트로 전달 — 앱이 살아있으면 화면이 스스로 최신 데이터로 갱신
            // (popup.js가 SYNC_COMPLETE 처리)
            MainActivity.emitNativeEvent("SYNC_COMPLETE", null, null);

            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }
}
