package kr.codyssey.attendance.util;

import android.annotation.SuppressLint;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

/**
 * 알림 표시 유틸 (Q8).
 *
 * 기존 plugin/NotificationPlugin은 @PluginMethod 브리지였지만 JS에서 한 번도 호출되지 않고
 * AlarmReceiver가 static 메서드만 사용했음 → 데드 브리지 표면을 제거하고 순수 util로 전환.
 * (Android 13+ 알림 권한 요청은 Capacitor LocalNotifications 플러그인이 adapter에서 담당)
 */
public class NotificationHelper {

    private static final String CHANNEL_ID = "codyssey_alarms";
    private static final String CHANNEL_NAME = "출입 알림";
    private static final int NOTIFICATION_ID_BASE = 1000;
    private static final String PREFS_NAME = "codyssey_prefs";

    // W7(18차): 알람 발화 소리 — AlarmPlugin.setAlarmSound JS 설정과 연동.
    // 소리는 기존과 동일하게 "알람 스트림(USAGE_ALARM)": 이어폰 착용 시 이어폰으로 자동 라우팅되고,
    // 미착용 시엔 매너모드 중에도 알람 볼륨으로 재생되는 단말 정책을 그대로 따른다.
    private static boolean alarmSoundEnabled(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getBoolean("alarm_sound", true);
    }

    // M7: 알람 id의 hashCode 충돌로 다른 알림을 덮어쓰는 문제 방지 — id별 고유 int 매핑 유지
    private static int notificationIdFor(Context context, String key) {
        android.content.SharedPreferences prefs =
                context.getSharedPreferences("codyssey_notif_ids", Context.MODE_PRIVATE);
        int existing = prefs.getInt("map_" + key, -1);
        if (existing >= 0) return existing;
        int next = prefs.getInt("counter", NOTIFICATION_ID_BASE) + 1;
        if (next < 0) next = NOTIFICATION_ID_BASE; // 오버플로우 방어
        prefs.edit()
                .putInt("counter", next)
                .putInt("map_" + key, next)
                .apply();
        return next;
    }

    public static void showNotification(Context context, String title, String body, String id) {
        boolean sound = alarmSoundEnabled(context);
        createNotificationChannel(context, sound);

        String notifIdKey = id != null ? id : "default";
        int notificationId = notificationIdFor(context, notifIdKey);

        // 앱 실행 인텐트 (설치 직후 등으로 런처 인텐트가 없으면 MainActivity 직접 지정)
        Intent intent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (intent == null) {
            intent = new Intent(context, kr.codyssey.attendance.MainActivity.class);
        }
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra("alarmId", notifIdKey);

        PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                notificationId,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // 소리 OFF 설정이면 알람음 대신 조용히(진동 패턴은 건드리지 않음)
        Uri soundUri = sound
                ? RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
                : null;

        Notification notification = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(getSmallIcon(context))
                .setContentTitle(title)
                .setContentText(body)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setSound(soundUri)
                .setContentIntent(pendingIntent)
                .setVibrate(new long[]{0, 500, 200, 500})
                .build();

        // 20차: POST_NOTIFICATIONS 미허용 등으로 notify()가 던지는 예외를 흡수하고 로그에 남긴다.
        // (방어 전엔 SecurityException이 AlarmReceiver/폴서비스 틱까지 전파돼 알람이 조용히 죽었다)
        try {
            NotificationManagerCompat.from(context).notify(notificationId, notification);
        } catch (SecurityException se) {
            kr.codyssey.attendance.util.DiagLog.add(context, "NOTIF",
                    "⚠️ 알림 발송 실패 — 시스템 설정에서 이 앱의 알림이 꺼져 있음: " + title);
        } catch (Exception e) {
            kr.codyssey.attendance.util.DiagLog.add(context, "NOTIF",
                    "알림 발송 오류: " + e.getMessage());
        }
    }

    // 알람 스트림 속성 — 이어폰/스피커 자동 라우팅 + 매너모드 우회는 시스템 알람음 정책에 위임
    private static AudioAttributes alarmAudioAttributes() {
        return new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
    }

    private static void createNotificationChannel(Context context, boolean sound) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            NotificationChannel existing = manager.getNotificationChannel(CHANNEL_ID);
            // W7: 알람 채널이 이미 만들어져 있어도 소리 설정은 사용자가 바꿀 수 있으므로 매번 동기화
            if (existing == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID,
                        CHANNEL_NAME,
                        NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("코디세이 출입 알림 채널");
                channel.enableVibration(true);
                channel.setVibrationPattern(new long[]{0, 500, 200, 500});
                if (sound) {
                    channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                            alarmAudioAttributes());
                } else {
                    channel.setSound(null, null);
                }
                manager.createNotificationChannel(channel);
                return;
            }
            if (sound) {
                existing.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                        alarmAudioAttributes());
            } else {
                existing.setSound(null, null);
            }
            manager.createNotificationChannel(existing);
        }
    }

    private static int getSmallIcon(Context context) {
        // Q8 수정: getIdentifier는 리소스 부재 시 예외가 아니라 0을 반환하고,
        // resId=0을 setSmallIcon에 넘기면 IllegalArgumentException이 나므로 폴곤 필수
        try {
            int id = context.getResources()
                    .getIdentifier("ic_stat_codyssey", "drawable", context.getPackageName());
            if (id != 0) return id;
        } catch (Exception e) { /* 폴곤으로 */ }
        return android.R.drawable.ic_dialog_info;
    }
}
