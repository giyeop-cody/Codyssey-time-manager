package kr.codyssey.campus.access

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.*
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kr.codyssey.campus.access.alarm.ExitAlarmReceiver
import kr.codyssey.campus.access.bridge.CodysseyWebBridge
import kr.codyssey.campus.access.bridge.ScrapedAccessPayload
import kr.codyssey.campus.access.model.AlarmConfig
import kr.codyssey.campus.access.ui.DashboardScreen
import kr.codyssey.campus.access.ui.NativeLoginScreen
import kr.codyssey.campus.access.ui.theme.CodysseyAccessTheme

class MainActivity : ComponentActivity() {
    private var mediaPlayer: MediaPlayer? = null
    private var webViewInstance: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
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
                    var liveScrapedData by remember { mutableStateOf(ScrapedAccessPayload(0, 0, "-", false)) }
                    var targetWebUrl by remember { mutableStateOf("https://codyssey.kr/loginForm") }

                    if (showModalFromAlarm) {
                        LaunchedEffect(Unit) { playAlarmChime() }
                    }

                    // Headless Permanent Background WebView (Scrapes data 24/7)
                    Box(modifier = Modifier.size(1.dp)) {
                        AndroidView(
                            factory = { ctx ->
                                WebView(ctx).apply {
                                    webViewInstance = this
                                    settings.javaScriptEnabled = true
                                    settings.domStorageEnabled = true
                                    settings.databaseEnabled = true
                                    settings.userAgentString = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.111 Mobile Safari/537.36"

                                    CookieManager.getInstance().setAcceptCookie(true)
                                    CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

                                    addJavascriptInterface(CodysseyWebBridge { payload ->
                                        liveScrapedData = payload
                                        if (payload.isSuccessfullyScraped && !isLoggedIn) {
                                            isLoggedIn = true
                                        }
                                    }, "AndroidBridge")

                                    webChromeClient = WebChromeClient()
                                    webViewClient = object : WebViewClient() {
                                        override fun onPageFinished(view: WebView?, url: String?) {
                                            super.onPageFinished(view, url)
                                            if (url?.contains("login") == true || url?.contains("codyssey.kr") == true) {
                                                val prefill = """
                                                    javascript:(function() {
                                                        const idEl = document.getElementById('userId') || document.querySelector('input[name="userId"]');
                                                        const pwEl = document.getElementById('password') || document.querySelector('input[name="password"]');
                                                        const formEl = document.getElementById('login') || document.querySelector('form');
                                                        if (idEl && pwEl && !window._sub) {
                                                            window._sub = true;
                                                            idEl.value = "rlduq1993@gmail.com"; pwEl.value = "coddjaakwhgdk11!";
                                                            idEl.dispatchEvent(new Event('input', {bubbles:true}));
                                                            pwEl.dispatchEvent(new Event('input', {bubbles:true}));
                                                            const b = document.querySelector('button[type="submit"]') || (formEl && formEl.querySelector('.btn-default'));
                                                            if(b) b.click(); else if(formEl) formEl.submit();
                                                        }
                                                    })();
                                                """.trimIndent()
                                                view?.evaluateJavascript(prefill, null)
                                            }

                                            if (url != null && !url.contains("login") && !url.contains("access-time") && (url.contains("codyssey.kr") || url.contains("main"))) {
                                                view?.loadUrl("https://usr.codyssey.kr/main/access-time?year=2026&month=06")
                                            }

                                            if (url?.contains("access-time") == true || url?.contains("main") == true) {
                                                val scraper = """
                                                    javascript:(function() {
                                                        function parseM(str) {
                                                            if(!str) return 0; let t = 0;
                                                            const h = str.match(/(\d+)\s*시간/); const m = str.match(/(\d+)\s*분/);
                                                            if(h) t += parseInt(h[1],10)*60; if(m) t += parseInt(m[1],10);
                                                            return t;
                                                        }
                                                        function scrapeLoop() {
                                                            let mRec = 0, dRec = 0, entryStr = "-", isInside = false;
                                                            const dl = document.querySelector('.access-month-nav__totals');
                                                            if(dl) dl.querySelectorAll('div').forEach(el => { if(el.textContent.includes('반영시간')) mRec = parseM(el.querySelector('dd,span').textContent); });
                                                            if(mRec === 0) document.querySelectorAll('dt,span,div,p').forEach(el => { if(el.textContent.trim() === '총 반영시간') { const n = el.nextElementSibling || el.parentElement.querySelector('dd,strong'); if(n) mRec = parseM(n.textContent); } });
                                                            const de = document.querySelector('.access-detail__day-total'); if(de) dRec = parseM(de.textContent);
                                                            const rows = document.querySelectorAll('.access-detail__table tbody tr');
                                                            const sess = [];
                                                            if(rows) rows.forEach(r => { const c = r.querySelectorAll('td'); if(c.length >= 2) { const en = c[0].textContent.trim(); const ex = c[1].textContent.trim(); const du = c[2]?c[2].textContent.trim():""; sess.push({entry:en, exit:ex, dur:du}); entryStr = en; if(ex === '-' || ex.includes('진행')) isInside = true; } });
                                                            const payload = JSON.stringify({ url: window.location.href, mRec, dRec, entryStr, isInside, tableSessions: sess });
                                                            AndroidBridge.onLiveDomScraped(payload);
                                                        }
                                                        scrapeLoop(); setInterval(scrapeLoop, 1000);
                                                    })();
                                                """.trimIndent()
                                                view?.evaluateJavascript(scraper, null)
                                            }
                                        }
                                    }
                                    loadUrl(targetWebUrl)
                                }
                            }
                        )
                    }

                    if (!isLoggedIn) {
                        NativeLoginScreen { enteredId, enteredPw ->
                            // Inject manual credentials to hidden WebView
                            val loginScript = """
                                javascript:(function() {
                                    const idEl = document.getElementById('userId') || document.querySelector('input[name="userId"]');
                                    const pwEl = document.getElementById('password') || document.querySelector('input[name="password"]');
                                    const formEl = document.getElementById('login') || document.querySelector('form');
                                    if(idEl && pwEl) {
                                        idEl.value = "${enteredId}"; pwEl.value = "${enteredPw}";
                                        idEl.dispatchEvent(new Event('input', {bubbles:true})); pwEl.dispatchEvent(new Event('input', {bubbles:true}));
                                        const b = document.querySelector('button[type="submit"]') || (formEl && formEl.querySelector('.btn-default'));
                                        if(b) b.click(); else if(formEl) formEl.submit();
                                    }
                                })();
                            """.trimIndent()
                            webViewInstance?.evaluateJavascript(loginScript, null)
                            Toast.makeText(this@MainActivity, "⛵ 백그라운드 웹뷰에서 공식 로그인 연동을 전송했습니다.", Toast.LENGTH_SHORT).show()
                        }
                    } else {
                        DashboardScreen(
                            liveData = liveScrapedData,
                            onSelectDayOnWeb = { dayNum ->
                                webViewInstance?.evaluateJavascript("javascript:document.querySelectorAll('.access-calendar__grid button').forEach(b=>{if(b.textContent.trim()=='$dayNum')b.click()});", null)
                            },
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
                            }
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
