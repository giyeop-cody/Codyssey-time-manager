package kr.codyssey.campus.access

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import kr.codyssey.campus.access.alarm.ExitAlarmReceiver
import kr.codyssey.campus.access.bridge.ScrapedAccessPayload
import kr.codyssey.campus.access.model.AlarmConfig
import kr.codyssey.campus.access.ui.DashboardScreen
import kr.codyssey.campus.access.ui.HybridLoginScreen
import kr.codyssey.campus.access.ui.theme.CodysseyAccessTheme

class MainActivity : ComponentActivity() {
    private var mediaPlayer: MediaPlayer? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Settings.canDrawOverlays(this)) {
            val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
            startActivity(intent)
        }

        val showModalFromAlarm = intent.getBooleanExtra("SHOW_ALARM_MODAL", false)

        setContent {
            CodysseyAccessTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    var isLoggedIn by remember { mutableStateOf(showModalFromAlarm) }
                    var activeAlarm by remember { mutableStateOf<AlarmConfig?>(null) }
                    var isRingingOverlay by remember { mutableStateOf(showModalFromAlarm) }
                    var liveScrapedData by remember { mutableStateOf(ScrapedAccessPayload(3764, 166, "12:56:44", true)) }

                    if (showModalFromAlarm) {
                        LaunchedEffect(Unit) {
                            playAlarmChime()
                        }
                    }

                    if (!isLoggedIn) {
                        HybridLoginScreen(
                            onLoginSuccess = { isLoggedIn = true },
                            onDataScraped = { payload -> liveScrapedData = payload }
                        )
                    } else {
                        DashboardScreen(
                            liveData = liveScrapedData,
                            onSetAlarm = { durMins ->
                                scheduleExactExitAlarm(durMins)
                                val tgtMs = System.currentTimeMillis() + durMins * 60 * 1000L
                                activeAlarm = AlarmConfig(true, tgtMs, durMins, liveScrapedData.lastEntryTimeStr)
                                Toast.makeText(this@MainActivity, "⏰ 스마트 백그라운드 퇴실 알람이 설정되었습니다!", Toast.LENGTH_SHORT).show()
                            },
                            onCancelAlarm = {
                                cancelExitAlarm()
                                activeAlarm = null
                                Toast.makeText(this@MainActivity, "알람이 해제되었습니다.", Toast.LENGTH_SHORT).show()
                            },
                            activeAlarm = activeAlarm,
                            isRingingOverlay = isRingingOverlay,
                            onDismissOverlay = {
                                stopAlarmChime()
                                isRingingOverlay = false
                                activeAlarm = null
                            },
                            onReopenWebView = { isLoggedIn = false }
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent?.getBooleanExtra("SHOW_ALARM_MODAL", false) == true) {
            playAlarmChime()
        }
    }

    private fun scheduleExactExitAlarm(durationMinutes: Int) {
        val alarmManager = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(this, ExitAlarmReceiver::class.java).apply {
            action = ExitAlarmReceiver.ACTION_TRIGGER_OVERLAY
        }
        val pendingIntent = PendingIntent.getBroadcast(
            this, ExitAlarmReceiver.NOTIFICATION_ID, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val triggerTimeMs = System.currentTimeMillis() + durationMinutes * 60 * 1000L

        if (Build.VERSION.SDK_INT >= 31) {
            if (alarmManager.canScheduleExactAlarms()) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerTimeMs, pendingIntent)
            } else {
                alarmManager.setWindow(AlarmManager.RTC_WAKEUP, triggerTimeMs, 60000L, pendingIntent)
            }
        } else {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerTimeMs, pendingIntent)
        }
    }

    private fun cancelExitAlarm() {
        val alarmManager = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(this, ExitAlarmReceiver::class.java)
        val pendingIntent = PendingIntent.getBroadcast(
            this, ExitAlarmReceiver.NOTIFICATION_ID, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        alarmManager.cancel(pendingIntent)
        stopAlarmChime()
    }

    private fun playAlarmChime() {
        try {
            stopAlarmChime()
            val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            mediaPlayer = MediaPlayer.create(this, uri).apply {
                isLooping = true
                start()
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    private fun stopAlarmChime() {
        try {
            mediaPlayer?.stop()
            mediaPlayer?.release()
            mediaPlayer = null
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        stopAlarmChime()
    }
}
