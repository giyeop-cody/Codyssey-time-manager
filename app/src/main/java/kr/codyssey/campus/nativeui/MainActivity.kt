package kr.codyssey.campus.nativeui

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
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import kr.codyssey.campus.nativeui.alarm.AlarmReceiver
import kr.codyssey.campus.nativeui.bridge.WebScraperBridge
import kr.codyssey.campus.nativeui.model.AccessDataState
import kr.codyssey.campus.nativeui.ui.NativeDashboardScreen
import kr.codyssey.campus.nativeui.ui.NativeLoginScreen
import kr.codyssey.campus.nativeui.ui.theme.NativeUiTheme

class MainActivity : ComponentActivity() {
    private var player: MediaPlayer? = null
    private var webRef: WebView? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Settings.canDrawOverlays(this)) {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION))
        }

        val showModal = intent.getBooleanExtra("SHOW_NATIVE_MODAL", false)
        if (showModal) playSound()

        setContent {
            NativeUiTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    var isLoggedIn by remember { mutableStateOf(showModal) }
                    var isLogLoading by remember { mutableStateOf(false) }
                    var dataState by remember { mutableStateOf(AccessDataState()) }
                    var activeAlarmMs by remember { mutableStateOf<Long?>(null) }
                    var isOverlay by remember { mutableStateOf(showModal) }

                    var ticks by remember { mutableStateOf("") }
                    LaunchedEffect(activeAlarmMs) {
                        while (activeAlarmMs != null) {
                            kotlinx.coroutines.delay(1000L)
                            val rem = (activeAlarmMs!! - System.currentTimeMillis()).coerceAtLeast(0L)
                            val s = rem / 1000L
                            ticks = String.format("%02d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60)
                            if (rem <= 0) activeAlarmMs = null
                        }
                    }

                    // Hidden Background WebView
                    Box(Modifier.size(1.dp)) {
                        AndroidView({ ctx ->
                            WebView(ctx).apply {
                                webRef = this
                                settings.javaScriptEnabled = true
                                settings.domStorageEnabled = true
                                settings.databaseEnabled = true
                                CookieManager.getInstance().setAcceptCookie(true)

                                addJavascriptInterface(WebScraperBridge { state ->
                                    dataState = state
                                    if (state.isScraped && !isLoggedIn) {
                                        isLogLoading = false
                                        isLoggedIn = true
                                    }
                                }, "AndroidBridge")

                                webViewClient = object : WebViewClient() {
                                    override fun onPageFinished(view: WebView?, url: String?) {
                                        super.onPageFinished(view, url)
                                        if (url != null && !url.contains("login") && url.contains("codyssey.kr")) {
                                            view?.loadUrl("https://usr.codyssey.kr/main/access-time?year=2026&month=06")
                                        }
                                        val scr = """
                                            javascript:(function(){
                                                function pM(s){if(!s)return 0;let t=0;const h=s.match(/(\d+)\s*시간/);const m=s.match(/(\d+)\s*분/);if(h)t+=parseInt(h[1],10)*60;if(m)t+=parseInt(m[1],10);return t;}
                                                function loop(){
                                                    let mRec=0,dRec=0,en="-",isIn=false;
                                                    const dl=document.querySelector('.access-month-nav__totals');if(dl)dl.querySelectorAll('div').forEach(e=>{if(e.textContent.includes('반영'))mRec=pM(e.textContent);});
                                                    const de=document.querySelector('.access-detail__day-total');if(de)dRec=pM(de.textContent);
                                                    const rows=document.querySelectorAll('.access-detail__table tbody tr');if(rows&&rows.length>0){const c=rows[rows.length-1].querySelectorAll('td');if(c.length>=2){en=c[0].textContent.trim();const ex=c[1].textContent.trim();if(ex==='-'||ex.includes('진행'))isIn=true;}}
                                                    AndroidBridge.onDomScraped(JSON.stringify({mRec,dRec,entryStr:en,isInside:isIn}));
                                                }
                                                loop();setInterval(loop,1000);
                                            })();
                                        """.trimIndent()
                                        view?.evaluateJavascript(scr, null)
                                    }
                                }
                                loadUrl("https://codyssey.kr/loginForm")
                            }
                        })
                    }

                    if (!isLoggedIn) {
                        NativeLoginScreen(isLoading = isLogLoading) { id, pw ->
                            isLogLoading = true
                            val s = """
                                javascript:(function(){
                                    const ie=document.getElementById('userId')||document.querySelector('input[name="userId"]');
                                    const pe=document.getElementById('password')||document.querySelector('input[name="password"]');
                                    const fe=document.getElementById('login')||document.querySelector('form');
                                    if(ie&&pe){ie.value="$id";pe.value="$pw";ie.dispatchEvent(new Event('input',{bubbles:true}));pe.dispatchEvent(new Event('input',{bubbles:true}));const b=document.querySelector('button[type="submit"]')||(fe&&fe.querySelector('.btn-default'));if(b)b.click();else if(fe)fe.submit();}
                                })();
                            """.trimIndent()
                            webRef?.evaluateJavascript(s, null)
                        }
                    } else {
                        NativeDashboardScreen(
                            dataState = dataState,
                            onSelectDayOnWeb = { d -> webRef?.evaluateJavascript("javascript:document.querySelectorAll('.access-calendar__grid button').forEach(b=>{if(b.textContent.trim()=='$d')b.click()});", null) },
                            onScheduleAlarm = { mins ->
                                scheduleAlarm(mins)
                                activeAlarmMs = System.currentTimeMillis() + mins * 60 * 1000L
                            },
                            onCancelAlarm = { cancelAlarm(); activeAlarmMs = null },
                            activeAlarmMs = activeAlarmMs,
                            alarmCountdownStr = ticks,
                            isOverlayShown = isOverlay,
                            onDismissOverlay = { stopSound(); isOverlay = false }
                        )
                    }
                }
            }
        }
    }

    private fun scheduleAlarm(mins: Int) {
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = PendingIntent.getBroadcast(this, AlarmReceiver.NOTIF_ID, Intent(this, AlarmReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val t = System.currentTimeMillis() + mins * 60 * 1000L
        if (Build.VERSION.SDK_INT >= 31) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, t, pi)
        else am.setExact(AlarmManager.RTC_WAKEUP, t, pi)
    }

    private fun cancelAlarm() {
        val am = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val pi = PendingIntent.getBroadcast(this, AlarmReceiver.NOTIF_ID, Intent(this, AlarmReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        am.cancel(pi)
        stopSound()
    }

    private fun playSound() {
        try { stopSound(); player = MediaPlayer.create(this, RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)).apply { isLooping = true; start() } } catch(e:Exception){}
    }

    private fun stopSound() {
        try { player?.stop(); player?.release(); player = null } catch(e:Exception){}
    }

    override fun onDestroy() { super.onDestroy(); stopSound() }
}
