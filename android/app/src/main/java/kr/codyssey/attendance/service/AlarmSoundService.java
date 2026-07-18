package kr.codyssey.attendance.service;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

import kr.codyssey.attendance.util.DiagLog;

/**
 * 25차: 알람 "울림" 전담 서비스.
 *
 * 배경(사용자 요청): 기존에는 알림 채널의 단발 알람음(수 초)만 재생되어,
 * 폰이 무음 구간/주머니 속에 있으면 알람을 놓칠 수 있었다.
 * → "모든 알람은 사람이 해제하기 전까지 최대 1분간 울렸다가 지워지게" 구현.
 *
 * 동작:
 *  - AlarmReceiver가 발화 시 이 서비스를 전경 시작.
 *  - MediaPlayer(USAGE_ALARM, 루프)로 기본 알람음을 최대 60초 반복 재생
 *    (이어폰 착용 시 이어폰으로 자동 라우팅 — AudioAttributes 정책).
 *  - "끄기" 액션/콘텐츠 탭(앱 열기)으로 사용자가 해제하거나 60초가 지나면
 *    울림·고정 알림을 모두 정리하고 자동 종료.
 *  - 설정 alarm_sound=false면 이 서비스는 호출되지 않고 기존 조용한 경로 유지.
 */
public class AlarmSoundService extends Service {

    private static final String ACTION_START = "kr.codyssey.attendance.action.ALARM_SOUND_START";
    private static final String ACTION_STOP  = "kr.codyssey.attendance.action.ALARM_SOUND_STOP";

    private static final long MAX_RING_MS = 60_000; // 1분
    private static final String CHANNEL_ID = "codyssey_alarms_ring";
    private static final int RING_NOTIF_ID = 900;

    public static final String EXTRA_STOP_ALARM_SOUND = "stopAlarmSound"; // MainActivity 탭 처리용

    private MediaPlayer mediaPlayer;
    private final Handler handler = new Handler(android.os.Looper.getMainLooper());
    private final Runnable timeoutStop = () -> finishRing("1분 경과 — 자동 종료");
    private boolean ringing = false;
    private String label = "알림";

    // ===== 외부 인터페이스 =====

    public static void start(Context context, String label, String alarmId) {
        Intent i = new Intent(context, AlarmSoundService.class).setAction(ACTION_START);
        i.putExtra("label", label);
        i.putExtra("id", alarmId);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(i);
        } else {
            context.startService(i);
        }
    }

    public static void stopSound(Context context) {
        Intent i = new Intent(context, AlarmSoundService.class).setAction(ACTION_STOP);
        context.startService(i);
    }

    // ===== 수명주기 =====

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) return START_NOT_STICKY;
        String action = intent.getAction();

        if (ACTION_STOP.equals(action)) {
            finishRing("사용자 해제");
            return START_NOT_STICKY;
        }

        if (ACTION_START.equals(action)) {
            label = intent.getStringExtra("label") != null ? intent.getStringExtra("label") : "알림";
            startForegroundWithRingNotification();
            startLooping();
            DiagLog.add(this, "ALARM-F", "알람 울림 시작 (최대 60초): [" + label + "]");
            return START_STICKY;
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        stopLooping();
        handler.removeCallbacks(timeoutStop);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ===== 울림 제어 =====

    private void startLooping() {
        stopLooping(); // 동시에 두 울림 방지 — 새 알람으로 교체
        try {
            Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM);
            if (soundUri == null) {
                DiagLog.add(this, "ALARM-F", "⚠️ 알람음 리소스를 찾지 못해 울릴 수 없음: [" + label + "]");
                return;
            }
            mediaPlayer = new MediaPlayer();
            mediaPlayer.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM) // 이어폰 자동 라우팅·알람 볼륨
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build());
            mediaPlayer.setDataSource(this, soundUri);
            mediaPlayer.setLooping(true);
            mediaPlayer.prepare();
            mediaPlayer.start();
            ringing = true;
            handler.postDelayed(timeoutStop, MAX_RING_MS);
        } catch (Exception e) {
            DiagLog.add(this, "ALARM-F", "⚠️ 알람 울림 시작 실패: " + e.getMessage());
        }
    }

    private void stopLooping() {
        ringing = false;
        if (mediaPlayer != null) {
            try { if (mediaPlayer.isPlaying()) mediaPlayer.stop(); } catch (Exception ignored) {}
            try { mediaPlayer.release(); } catch (Exception ignored) {}
            mediaPlayer = null;
        }
    }

    private void finishRing(String reason) {
        stopLooping();
        handler.removeCallbacks(timeoutStop);
        DiagLog.add(this, "ALARM-F", "알람 울림 종료 (" + reason + ") — 알림 정리: [" + label + "]");
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null) nm.cancel(RING_NOTIF_ID);
        } catch (Exception ignored) {}
        stopForeground(true);
        stopSelf();
    }

    // ===== 고정 알림 (호출 중 표시) =====

    private void startForegroundWithRingNotification() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                    CHANNEL_ID, "출입 알람 울림", NotificationManager.IMPORTANCE_HIGH);
            ch.setDescription("알람이 울리는 동안 표시되는 고정 알림 (소리는 알람 스트림이 담당)");
            // 이 채널은 소리 없음 — 반복 재생은 MediaPlayer가 담당 (채널 단발음과 중복 방지)
            ch.setSound(null, null);
            ch.enableVibration(true);
            ch.setVibrationPattern(new long[]{0, 500, 200, 500});
            nm.createNotificationChannel(ch);
        }

        // 콘텐츠 탭 → 앱 열기 + 울림 정지 신호
        Intent open = new Intent(this, kr.codyssey.attendance.MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        open.putExtra(EXTRA_STOP_ALARM_SOUND, true);
        open.putExtra("alarmId", "ring");
        PendingIntent openPi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        // "끄기" 액션 → 앱을 열지 않고 울림만 정지
        Intent stop = new Intent(this, AlarmSoundService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification notif = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(kr.codyssey.attendance.util.NotificationHelper.getRingIcon(this))
                .setContentTitle("⏰ 코디세이 알람 울림 중")
                .setContentText(label + " — 해제하려면 '끄기' 또는 탭")
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setOngoing(true)
                .setAutoCancel(false)
                .setContentIntent(openPi)
                .addAction(0, "끄기", stopPi)
                .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(RING_NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(RING_NOTIF_ID, notif);
        }
    }
}
