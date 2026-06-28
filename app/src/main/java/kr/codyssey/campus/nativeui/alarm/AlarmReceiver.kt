package kr.codyssey.campus.nativeui.alarm

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
import kr.codyssey.campus.nativeui.MainActivity

class AlarmReceiver : BroadcastReceiver() {
    companion object {
        const val CH_ID = "CODYSSEY_NATIVE_UI_ALARM"
        const val NOTIF_ID = 3003
    }

    override fun onReceive(context: Context, intent: Intent) {
        val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
        val wl = pm.newWakeLock(PowerManager.FULL_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "CodyNativeUi:Wake")
        wl.acquire(5 * 60 * 1000L)

        val vib = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        vib.vibrate(longArrayOf(0, 1000, 500, 1000), 0)

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            val ch = NotificationChannel(CH_ID, "NativeCards 퇴실 알람", NotificationManager.IMPORTANCE_HIGH)
            ch.enableVibration(true)
            nm.createNotificationChannel(ch)
        }

        val launchIntent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("SHOW_NATIVE_MODAL", true)
        }
        val pi = PendingIntent.getActivity(context, 0, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        val notif = NotificationCompat.Builder(context, CH_ID)
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("⏰ NativeCards 출입 목표 시간 도달!")
            .setContentText("설정하신 다크 테마 퇴실 알람 시간입니다. 체크아웃하세요.")
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM))
            .setFullScreenIntent(pi, true)
            .build()

        nm.notify(NOTIF_ID, notif)
        context.startActivity(launchIntent)
    }
}
