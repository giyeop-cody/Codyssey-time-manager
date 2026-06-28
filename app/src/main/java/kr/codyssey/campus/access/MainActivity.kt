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
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import kr.codyssey.campus.access.alarm.ExitAlarmReceiver
import kr.codyssey.campus.access.model.AlarmConfig
import kr.codyssey.campus.access.model.formatMins
import kr.codyssey.campus.access.ui.theme.CodysseyAccessTheme

class MainActivity : ComponentActivity() {
    private var mediaPlayer: MediaPlayer? = null
    private var activeAlarmState by mutableStateOf<AlarmConfig?>(null)
    private var isRingingState by mutableStateOf(false)

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        if (!Settings.canDrawOverlays(this)) {
            val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION)
            startActivity(intent)
        }

        val showModalFromAlarm = intent.getBooleanExtra("SHOW_ALARM_MODAL", false)
        isRingingState = showModalFromAlarm
        if (showModalFromAlarm) {
            playAlarmChime()
        }

        setContent {
            CodysseyAccessTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    Box(modifier = Modifier.fillMaxSize()) {
                        // 1. Full Screen Native WebView (Shows real official Codyssey login & access page)
                        AndroidView(
                            factory = { ctx ->
                                WebView(ctx).apply {
                                    settings.javaScriptEnabled = true
                                    settings.domStorageEnabled = true
                                    settings.databaseEnabled = true
                                    settings.userAgentString = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.111 Mobile Safari/537.36"

                                    CookieManager.getInstance().setAcceptCookie(true)
                                    CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)

                                    // Bridge for injected DOM panel to schedule Android physical alarms
                                    addJavascriptInterface(object {
                                        @JavascriptInterface
                                        fun setAlarm(targetTimeMs: Long, durationMins: Int, baseEntryStr: String) {
                                            runOnUiThread {
                                                scheduleExactExitAlarm(targetTimeMs)
                                                activeAlarmState = AlarmConfig(true, targetTimeMs, durationMins, baseEntryStr)
                                                Toast.makeText(ctx, "⏰ 폰 물리 알람이 맞추어졌습니다! 앱을 끄거나 화면을 꺼도 알람이 울립니다.", Toast.LENGTH_LONG).show()
                                            }
                                        }

                                        @JavascriptInterface
                                        fun cancelAlarm() {
                                            runOnUiThread {
                                                cancelExitAlarm()
                                                activeAlarmState = null
                                                Toast.makeText(ctx, "⚪ 퇴실 처리 감지: 예약된 퇴실 알람이 자동 종료되었습니다.", Toast.LENGTH_LONG).show()
                                            }
                                        }
                                    }, "AndroidBridge")

                                    webChromeClient = WebChromeClient()
                                    webViewClient = object : WebViewClient() {
                                        override fun onPageFinished(view: WebView?, url: String?) {
                                            super.onPageFinished(view, url)

                                            if (url?.contains("access-time") == true || url?.contains("main") == true) {
                                                // 1. Hide Codyssey navigation UI that allows leaving to other pages
                                                val hideUiCss = """
                                                    javascript:(function() {
                                                        const style = document.createElement('style');
                                                        style.innerHTML = `
                                                            #sidebar, #gnb, .notice, .mobile-menu, .link-area, .btn-link-login { display: none !important; }
                                                            #header { padding-left: 20px !important; }
                                                            #content { max-width: 100% !important; width: 100% !important; padding: 16px !important; }
                                                            #codyssey-ext-panel { min-width: 320px !important; width: 100% !important; margin-top: 20px !important; }
                                                        `;
                                                        document.head.appendChild(style);
                                                    })();
                                                """.trimIndent()
                                                view?.evaluateJavascript(hideUiCss, null)

                                                // 2. Inject Chrome Extension DOM Helper Panel inside WebView
                                                val injectPanelJs = """
                                                    javascript:(function() {
                                                        if (window._panelInjected) return;
                                                        window._panelInjected = true;

                                                        const DAILY_MAX_MINUTES = 720;
                                                        let state = { dailyCompletedMins: 0, lastEntryTimeStr: '-', isCurrentlyInside: false, inputHours: 4, inputMinutes: 0 };

                                                        function parsePageData() {
                                                            const dayTotalEl = document.querySelector('.access-detail__day-total');
                                                            if (dayTotalEl) {
                                                                const h = dayTotalEl.textContent.match(/(\d+)\s*시간/); const m = dayTotalEl.textContent.match(/(\d+)\s*분/);
                                                                let tot = 0; if(h) tot += parseInt(h[1],10)*60; if(m) tot += parseInt(m[1],10);
                                                                state.dailyCompletedMins = tot;
                                                            }
                                                            const rows = document.querySelectorAll('.access-detail__table tbody tr');
                                                            state.isCurrentlyInside = false;
                                                            if (rows && rows.length > 0) {
                                                                const last = rows[rows.length - 1]; const cells = last.querySelectorAll('td');
                                                                if (cells.length >= 2) {
                                                                    state.lastEntryTimeStr = cells[0].textContent.trim();
                                                                    const ext = cells[1].textContent.trim();
                                                                    if (ext === '-' || cells[1].classList.contains('is-placeholder') || ext.includes('진행')) state.isCurrentlyInside = true;
                                                                }
                                                            }
                                                        }

                                                        function createUI() {
                                                            const existing = document.getElementById('codyssey-ext-panel'); if(existing) existing.remove();
                                                            const panel = document.createElement('div'); panel.id = 'codyssey-ext-panel';
                                                            panel.style.cssText = 'background:#ffffff; border:2px solid #3b82f6; border-radius:16px; padding:20px; box-shadow:0 10px 25px rgba(59,130,246,0.15); color:#1e293b; font-family:sans-serif;';
                                                            panel.innerHTML = `
                                                                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;border-bottom:2px solid #f1f5f9;padding-bottom:12px;">
                                                                    <b style="font-size:16px;color:#0f172a;">⏰ 스마트 추가 체류 알람 매니저</b>
                                                                    <span id="cody-badge" style="font-size:11px;padding:4px 8px;border-radius:999px;background:#eff6ff;color:#2563eb;font-weight:bold;">진행 중 🟢</span>
                                                                </div>
                                                                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
                                                                    <div><div style="font-size:11px;color:#64748b;margin-bottom:4px;font-weight:bold;">추가 체류 (시간)</div><input type="number" id="in-h" value="4" min="0" max="12" style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;text-align:center;font-size:16px;font-weight:bold;"></div>
                                                                    <div><div style="font-size:11px;color:#64748b;margin-bottom:4px;font-weight:bold;">추가 체류 (분)</div><input type="number" id="in-m" value="0" min="0" max="59" style="width:100%;padding:10px;border:1px solid #cbd5e1;border-radius:8px;text-align:center;font-size:16px;font-weight:bold;"></div>
                                                                </div>
                                                                <div style="display:flex;gap:8px;margin-bottom:16px;">
                                                                    <button type="button" id="btn-max12" style="flex:2;background:#eff6ff;border:1px solid #bfdbfe;color:#2563eb;padding:10px;border-radius:8px;font-size:12px;font-weight:bold;cursor:pointer;">🔥 최대 12시간 자동</button>
                                                                    <button type="button" id="btn-30m" style="flex:1;background:#f1f5f9;border:1px solid #cbd5e1;color:#334155;padding:10px;border-radius:8px;font-size:12px;font-weight:bold;cursor:pointer;">+30분</button>
                                                                    <button type="button" id="btn-1h" style="flex:1;background:#f1f5f9;border:1px solid #cbd5e1;color:#334155;padding:10px;border-radius:8px;font-size:12px;font-weight:bold;cursor:pointer;">+1시간</button>
                                                                </div>
                                                                <div style="background:#0f172a;color:white;padding:12px;border-radius:10px;font-size:13px;margin-bottom:16px;">
                                                                    <div style="display:flex;justify-content:space-between;margin-bottom:4px;"><span style="color:#94a3b8;">예정 퇴실 시각:</span><b style="color:#38bdf8;" id="prev-time">-</b></div>
                                                                    <div style="display:flex;justify-content:space-between;"><span style="color:#94a3b8;">퇴실 시 오늘 인정:</span><b style="color:#34d399;" id="prev-tot">-</b></div>
                                                                </div>
                                                                <button type="button" id="btn-set" style="width:100%;background:linear-gradient(135deg,#2563eb,#1d4ed8);color:white;border:none;padding:14px;border-radius:10px;font-size:15px;font-weight:bold;cursor:pointer;box-shadow:0 4px 12px rgba(37,99,235,0.3);">⏰ 스마트 백그라운드 알람 맞추기</button>
                                                            `;
                                                            const container = document.querySelector('.access-time-view') || document.getElementById('content');
                                                            if(container) container.appendChild(panel);

                                                            bindEvents();
                                                        }

                                                        function bindEvents() {
                                                            const inH = document.getElementById('in-h'); const inM = document.getElementById('in-m');
                                                            inH.oninput = () => { state.inputHours = parseInt(inH.value,10)||0; updatePrev(); };
                                                            inM.oninput = () => { state.inputMinutes = parseInt(inM.value,10)||0; updatePrev(); };

                                                            document.getElementById('btn-max12').onclick = () => {
                                                                parsePageData();
                                                                if(!state.isCurrentlyInside) { alert('퇴실 완료 상태입니다.'); return; }
                                                                const needed = DAILY_MAX_MINUTES - state.dailyCompletedMins;
                                                                if(needed <= 0) { alert('이미 오늘 12시간 달성 완료!'); return; }
                                                                state.inputHours = Math.floor(needed/60); state.inputMinutes = needed % 60;
                                                                inH.value = state.inputHours; inM.value = state.inputMinutes; updatePrev();
                                                            };
                                                            document.getElementById('btn-30m').onclick = () => { const tot = state.inputHours*60 + state.inputMinutes + 30; state.inputHours=Math.floor(tot/60); state.inputMinutes=tot%60; inH.value=state.inputHours; inM.value=state.inputMinutes; updatePrev(); };
                                                            document.getElementById('btn-1h').onclick = () => { state.inputHours+=1; inH.value=state.inputHours; updatePrev(); };

                                                            document.getElementById('btn-set').onclick = () => {
                                                                parsePageData();
                                                                if(!state.isCurrentlyInside) { alert('퇴실 완료 상태입니다.'); return; }
                                                                const dur = state.inputHours*60 + state.inputMinutes;
                                                                if(dur <= 0) { alert('1분 이상 설정해주세요.'); return; }
                                                                const parts = state.lastEntryTimeStr.split(':');
                                                                const base = new Date(); base.setHours(parseInt(parts[0],10)||0, parseInt(parts[1],10)||0, parseInt(parts[2],10)||0, 0);
                                                                const targetTime = base.getTime() + dur*60*1000;
                                                                if (targetTime <= Date.now()) { alert('예정 퇴실 시각이 이미 지났습니다!'); return; }
                                                                AndroidBridge.setAlarm(targetTime, dur, state.lastEntryTimeStr);
                                                            };
                                                        }

                                                        function updatePrev() {
                                                            const dur = state.inputHours*60 + state.inputMinutes;
                                                            const parts = state.lastEntryTimeStr.split(':');
                                                            const base = new Date(); base.setHours(parseInt(parts[0],10)||0, parseInt(parts[1],10)||0, parseInt(parts[2],10)||0, 0);
                                                            const tgtDate = new Date(base.getTime() + dur*60*1000);
                                                            document.getElementById('prev-time').textContent = tgtDate.toLocaleTimeString('ko-KR');
                                                            document.getElementById('prev-tot').textContent = Math.floor((state.dailyCompletedMins+dur)/60) + "시간 " + ((state.dailyCompletedMins+dur)%60) + "분 / 최대 12h";
                                                        }

                                                        function loop() {
                                                            const wasInside = state.isCurrentlyInside;
                                                            parsePageData();
                                                            const b = document.getElementById('cody-badge');
                                                            if(b) {
                                                                b.textContent = state.isCurrentlyInside ? "🟢 입실 중" : "⚪ 퇴실 완료";
                                                                b.style.color = state.isCurrentlyInside ? "#10b981" : "#f59e0b";
                                                            }
                                                            if(wasInside && !state.isCurrentlyInside) {
                                                                AndroidBridge.cancelAlarm();
                                                            }
                                                            updatePrev();
                                                        }

                                                        parsePageData(); createUI(); loop(); setInterval(loop, 1000);
                                                    })();
                                                """.trimIndent()
                                                view?.evaluateJavascript(injectPanelJs, null)
                                            }
                                        }
                                    }
                                    loadUrl("https://usr.codyssey.kr/main/access-time?year=2026&month=06")
                                }
                            },
                            modifier = Modifier.fillMaxSize()
                        )

                        // 2. Full Screen Android Blocker Overlay
                        if (isRingingState) {
                            Box(modifier = Modifier.fillMaxSize().background(Color(0xEE0F172A)).clickable { }, contentAlignment = Alignment.Center) {
                                Card(modifier = Modifier.fillMaxWidth(0.9f), colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)), shape = RoundedCornerShape(24.dp)) {
                                    Column(Modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                        Text("⏰", fontSize = 64.sp)
                                        Spacer(Modifier.height(16.dp))
                                        Text("출입 목표 시간 도달!", fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = Color.White)
                                        Text("설정하신 퇴실 시간이 되었습니다.\n화면 잠금을 해제하시고 체크아웃을 완료하세요!", fontSize = 14.sp, color = Color.LightGray, textAlign = TextAlign.Center)
                                        Spacer(Modifier.height(24.dp))
                                        Button(onClick = {
                                            stopAlarmChime()
                                            isRingingState = false
                                            activeAlarmState = null
                                        }, modifier = Modifier.fillMaxWidth().height(52.dp), colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFEF4444)), shape = RoundedCornerShape(14.dp)) {
                                            Text("🔕 알람 확인 및 화면 잠금 해제", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        if (intent?.getBooleanExtra("SHOW_ALARM_MODAL", false) == true) {
            isRingingState = true
            playAlarmChime()
        }
    }

    private fun scheduleExactExitAlarm(triggerTimeMs: Long) {
        val alarmManager = getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val intent = Intent(this, ExitAlarmReceiver::class.java).apply {
            action = ExitAlarmReceiver.ACTION_TRIGGER_OVERLAY
        }
        val pendingIntent = PendingIntent.getBroadcast(
            this, ExitAlarmReceiver.NOTIFICATION_ID, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

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
