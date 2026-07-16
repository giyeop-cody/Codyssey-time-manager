package kr.codyssey.attendance.plugin;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NotificationPlugin")
public class NotificationPlugin extends Plugin {

    private static final String CHANNEL_ID = "codyssey_alarms";
    private static final String CHANNEL_NAME = "출입 알림";
    private static final int NOTIFICATION_ID_BASE = 1000;

    @PluginMethod
    public void show(PluginCall call) {
        String title = call.getString("title", "알림");
        String body = call.getString("body", "");
        String id = call.getString("id", String.valueOf(System.currentTimeMillis()));

        showNotification(getContext(), title, body, id);

        JSObject result = new JSObject();
        result.put("success", true);
        call.resolve(result);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        // Android 13+ 알림 권한 요청
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (getActivity() != null) {
                getActivity().requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 1001);
            }
        }
        JSObject result = new JSObject();
        result.put("granted", NotificationManagerCompat.from(getContext()).areNotificationsEnabled());
        call.resolve(result);
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        boolean enabled = NotificationManagerCompat.from(getContext()).areNotificationsEnabled();
        JSObject result = new JSObject();
        result.put("granted", enabled);
        call.resolve(result);
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
        createNotificationChannel(context);

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

        Uri soundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);

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

        NotificationManagerCompat.from(context).notify(notificationId, notification);
    }

    private static void createNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            if (manager.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel channel = new NotificationChannel(
                        CHANNEL_ID,
                        CHANNEL_NAME,
                        NotificationManager.IMPORTANCE_HIGH
                );
                channel.setDescription("코디세이 출입 알림 채널");
                channel.enableVibration(true);
                channel.setVibrationPattern(new long[]{0, 500, 200, 500});
                manager.createNotificationChannel(channel);
            }
        }
    }

    private static int getSmallIcon(Context context) {
        // 아이콘 리소스가 있으면 사용, 없으면 기본 아이콘
        try {
            return context.getResources().getIdentifier("ic_stat_codyssey", "drawable", context.getPackageName());
        } catch (Exception e) {
            return android.R.drawable.ic_dialog_info;
        }
    }
}