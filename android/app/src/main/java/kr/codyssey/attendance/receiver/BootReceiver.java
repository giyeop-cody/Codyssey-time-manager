package kr.codyssey.attendance.receiver;

import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.concurrent.TimeUnit;

import kr.codyssey.attendance.plugin.AlarmPlugin;
import kr.codyssey.attendance.plugin.PollingPlugin;
import kr.codyssey.attendance.worker.AlarmWorker;

public class BootReceiver extends BroadcastReceiver {

    private static final String PREFS_NAME = "codyssey_prefs";
    private static final String ALARMS_KEY = "codyssey_alarms";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) {
            return;
        }

        // 30차: 감지 체계 = 5분 틱 체인(주) + WorkManager 15분(백업).
        // dash_enabled(백그라운드 감지)가 꺼져 있으면 재예약하지 않음.
        if (isPeriodicSyncEnabled(context) && PollingPlugin.isEnabled(context)) {
            SyncTickReceiver.ensureChain(context);
            PollingPlugin.ensurePeriodicSync(context);
        } else {
            SyncTickReceiver.cancelChain(context);
            WorkManager.getInstance(context).cancelUniqueWork("codyssey_periodic_sync");
        }

        // L10: 부팅으로 소실된 1회성 알람 복원 (WorkManager 워크는 OS가 유지하므로 주기 동기화만 재등록)
        restoreOneShotAlarms(context);

        // 31차: 지오펜스는 재부팅 시 소실 — 활성 상태면 재등록 (PhysicalCheck.learnNow가 학습한 좌표 사용)
        // 32차 N31-8: 부팅 경로는 reg_ok 캐시와 무관하게 강제 재등록이 필요 (OS가 등록을 잃은 상태)
        try {
            kr.codyssey.attendance.util.PhyGeofence.startIfEnabled(context, true);
        } catch (Exception e) { /* 다음 앱 실행에서 재시도 */ }
    }

    // 주기 동기화 필요 여부 = keep-alive 켬 OR 입·퇴실 감지 켬(G1, JS 기본값과 동일하게 기본 true)
    private boolean isPeriodicSyncEnabled(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String settingsJson = prefs.getString("settings", null);
            if (settingsJson == null) return true; // 설정 저장 전 최초 부팅 — G1 기본값(true)에 따름
            JSONObject settings = new JSONObject(settingsJson);
            return settings.optBoolean("keepAliveEnabled", false)
                    || settings.optBoolean("gateNotifyEnabled", true);
        } catch (Exception e) {
            return true; // 파싱 실패 시 감지 기본값(true) 쪽에 붙음 (알림 누락보다 재예약이 안전)
        }
    }

    private boolean canExact(Context context) {
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            return alarmManager.canScheduleExactAlarms();
        }
        return true;
    }

    // 경로 매트릭스 (한 방향만 예약 — 이중 발화 방지):
    //  ① 정확 권한 있음 → AlarmManager로만 복원 + 잔존 WorkManager 백업은 취소 (K4)
    //  ② 정확 권한 없음 → uniqueWork(REPLACE) 폼밭 1걸 (기존 생존 워크와 중복되지 않음) (K5)
    private void restoreOneShotAlarms(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String alarmsJson = prefs.getString(ALARMS_KEY, null);
            if (alarmsJson == null) return;

            JSONArray arr = new JSONArray(alarmsJson);
            JSONArray kept = new JSONArray();
            long now = System.currentTimeMillis();
            boolean exactAvailable = canExact(context);
            boolean changed = false;

            for (int i = 0; i < arr.length(); i++) {
                JSONObject alarm = arr.optJSONObject(i);
                if (alarm == null) continue;

                long time = alarm.optLong("time", 0);
                String name = alarm.optString("name", null);
                String label = alarm.optString("label", "알림");
                if (name == null) continue;

                if (time <= now) {
                    // K8: 기기가 꺼진 사이 지나간 알람 — 복원하지 않고 저장 목록에서도 제거
                    AlarmPlugin.untrackScheduled(context, name);
                    changed = true;
                    continue;
                }
                kept.put(alarm);

                if (exactAvailable) {
                    // K4: 정확 알람으로만 복원 (label/triggerTime 보존), K7 추적 갱신
                    AlarmPlugin.scheduleExactAlarmAt(context, time, name, label);
                    AlarmPlugin.trackScheduled(context, name);
                    // 예약 시점엔 WorkManager 경로였던 알람의 생존 워크가 있을 수 있어 취소
                    WorkManager.getInstance(context)
                            .cancelAllWorkByTag(AlarmPlugin.WORK_TAG_ALARM + name);
                } else {
                    // K5: 정확 알람 불가 — WorkManager 폼밭으로 재예약 (unique + REPLACE로 중복 방지)
                    Data inputData = new Data.Builder()
                            .putString("label", label)
                            .putString("id", name)
                            .putLong("triggerTime", time)
                            .build();

                    OneTimeWorkRequest alarmWork = new OneTimeWorkRequest.Builder(AlarmWorker.class)
                            .setInputData(inputData)
                            .setInitialDelay(time - now, TimeUnit.MILLISECONDS)
                            .addTag(AlarmPlugin.WORK_TAG_ALARM)
                            .addTag(AlarmPlugin.WORK_TAG_ALARM + name)
                            .build();

                    WorkManager.getInstance(context)
                            .enqueueUniqueWork(
                                    AlarmPlugin.WORK_TAG_ALARM + name,
                                    ExistingWorkPolicy.REPLACE,
                                    alarmWork
                            );
                }
            }

            if (changed) {
                prefs.edit().putString(ALARMS_KEY, kept.toString()).apply();
            }
        } catch (Exception e) {
            // 복원 실패 시 다음 앱 실행에서 JS 목록 기준으로 재동기화
        }
    }
}
