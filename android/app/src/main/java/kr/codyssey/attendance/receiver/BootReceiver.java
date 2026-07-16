package kr.codyssey.attendance.receiver;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import kr.codyssey.attendance.worker.SyncWorker;

public class BootReceiver extends BroadcastReceiver {

    private static final String PREFS_NAME = "codyssey_prefs";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            return;
        }

        // N7: keep-alive 설정이 켜져 있을 때만 주기 동기화 재시작
        if (isKeepAliveEnabled(context)) {
            PeriodicWorkRequest syncWork = new PeriodicWorkRequest.Builder(
                    SyncWorker.class, 30, TimeUnit.MINUTES)
                    .addTag("codyssey_periodic_sync")
                    .build();

            WorkManager.getInstance(context)
                    .enqueueUniquePeriodicWork(
                            "codyssey_periodic_sync",
                            ExistingPeriodicWorkPolicy.UPDATE,
                            syncWork
                    );
        } else {
            WorkManager.getInstance(context).cancelUniqueWork("codyssey_periodic_sync");
        }
    }

    private boolean isKeepAliveEnabled(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String settingsJson = prefs.getString("settings", null);
            if (settingsJson == null) return false;
            return new JSONObject(settingsJson).optBoolean("keepAliveEnabled", false);
        } catch (Exception e) {
            return false;
        }
    }
}
