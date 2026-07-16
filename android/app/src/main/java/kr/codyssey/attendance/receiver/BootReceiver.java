package kr.codyssey.attendance.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import java.util.concurrent.TimeUnit;

import kr.codyssey.attendance.worker.SyncWorker;

public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            // 주기적 동기화 재시작 (30분마다)
            PeriodicWorkRequest syncWork = new PeriodicWorkRequest.Builder(
                    SyncWorker.class, 30, TimeUnit.MINUTES)
                    .addTag("codyssey_periodic_sync")
                    .build();

            WorkManager.getInstance(context)
                    .enqueueUniquePeriodicWork(
                            "codyssey_periodic_sync",
                            ExistingPeriodicWorkPolicy.REPLACE,
                            syncWork
                    );
        }
    }
}