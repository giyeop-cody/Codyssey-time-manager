package kr.codyssey.campus.access.alarm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.RingtoneManager
import android.os.Build
import android.os.PowerManager
import android.os.Vibrator
import androidx.core.app.NotificationCompat
import kr.codyssey.campus.access.MainActivity

class ExitAlarmReceiver : BroadcastReceiver() {
    companion object {
        const val CHANNEL_ID = "CODYSSEY_ALARM_CHANNEL"
        const val NOTIFICATION_ID = 1001
        const val ACTION_TRIGGER_OVERLAY = "kr.codyssey.campus.access.ACTION_TRIGGER_OVERLAY"
    }

    override fun onReceive(context: Context, intent: Intent) {
        // Wake up device screen
        val powerManager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val wakeLock = powerManager.newWakeLock(
            PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
            "Codyssey:ExitAlarmWakeLock"
        )
        wakeLock.acquire(10 * 60 * 1000L) // 10 minutes

        // Vibrate
        val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        vibrator.vibrate(longArrayOf(0, 1000, 500, 1000), 0)

        // Show system notification
        val notifManager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Codyssey 퇴실 풀스크린 알람",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "퇴실 목표 시간 도달 시 화면 잠금 및 소리 알림"
                enableVibration(true)
            }
            notifManager.createNotificationChannel(channel)
        }

        val fullScreenIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("SHOW_ALARM_MODAL", true)
        }
        val pendingIntent = PendingIntent.getActivity(
            context, 0, fullScreenIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val defaultSoundUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("⏰ Codyssey 출입 목표 시간 도달!")
            .setContentText("설정하신 퇴실 시간이 되었습니다. 퇴실 처리를 잊지 마세요!")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setSound(defaultSoundUri)
            .setFullScreenIntent(pendingIntent, true)
            .setAutoCancel(false)
            .setOngoing(true)
            .build()

        notifManager.notify(NOTIFICATION_ID, notification)

        // Launch activity directly if permitted
        context.startActivity(fullScreenIntent)
    }
}
