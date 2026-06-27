package kr.codyssey.campus.access.ui

import android.annotation.SuppressLint
import android.webkit.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import kr.codyssey.campus.access.bridge.CodysseyWebBridge
import kr.codyssey.campus.access.bridge.ScrapedAccessPayload
import kr.codyssey.campus.access.model.AlarmConfig
import java.text.SimpleDateFormat
import java.util.*

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun MainHybridDashboardScreen(
    onSetAlarm: (Int) -> Unit,
    onCancelAlarm: () -> Unit,
    activeAlarm: AlarmConfig?,
    isRingingOverlay: Boolean,
    onDismissOverlay: () -> Unit
) {
    var liveData by remember { mutableStateOf(ScrapedAccessPayload(0, 0, "-", false)) }
    var inputHours by remember { mutableStateOf(4) }
    var inputMins by remember { mutableStateOf(0) }
    var currentWebUrl by remember { mutableStateOf("https://codyssey.kr/loginForm") } // Official initial login target
    var webViewInstance: WebView? by remember { mutableStateOf(null) }

    var ticks by remember { mutableStateOf(0) }
    LaunchedEffect(liveData.isCurrentlyInside) {
        while (true) {
            kotlinx.coroutines.delay(1000L)
            ticks++
        }
    }

    val ongoingMins = if (liveData.isCurrentlyInside && liveData.isSuccessfullyScraped) ticks / 60 else 0
    val curDaily = (liveData.dailyCompletedMinutes + ongoingMins).coerceAtMost(720)
    val curMonthly = liveData.monthlyRecognizedMinutes + ongoingMins

    Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        Column(modifier = Modifier.fillMaxSize()) {
            // 1. Top App Bar
            Surface(color = MaterialTheme.colorScheme.surface, shadowElevation = 4.dp) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("⛵", fontSize = 24.sp)
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text("Codyssey 실제 계정 연동 중", fontSize = 16.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onSurface)
                            val statusText = if (liveData.isSuccessfullyScraped) "🟢 실제 라이브 출입데이터 연동 중" else "⚡ 자동 로그인 및 페이지 이동 중..."
                            Text(statusText, fontSize = 11.sp, color = if(liveData.isSuccessfullyScraped) Color(0xFF10B981) else Color(0xFF38BDF8), fontWeight = FontWeight.Bold)
                        }
                    }
                    OutlinedButton(
                        onClick = { webViewInstance?.loadUrl("https://codyssey.kr/loginForm") },
                        contentPadding = PaddingValues(horizontal = 10.dp, vertical = 4.dp)
                    ) {
                        Text("🌐 로그인 폼", fontSize = 11.sp)
                    }
                }
            }

            // 2. Main Official Live WebView Viewport (Auto logs in and loads real user site)
            Box(modifier = Modifier.weight(1f).fillMaxWidth().background(Color.White)) {
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
                                liveData = payload
                            }, "AndroidBridge")

                            webChromeClient = WebChromeClient()
                            webViewClient = object : WebViewClient() {
                                override fun onPageFinished(view: WebView?, url: String?) {
                                    super.onPageFinished(view, url)
                                    
                                    // 1. Auto Login injection for rlduq1993@gmail.com
                                    if (url?.contains("login") == true || url?.contains("codyssey.kr") == true) {
                                        val autoLoginScript = """
                                            javascript:(function() {
                                                const idEl = document.getElementById('userId') || document.querySelector('input[name="userId"]');
                                                const pwEl = document.getElementById('password') || document.querySelector('input[name="password"]');
                                                const formEl = document.getElementById('login') || document.querySelector('form');

                                                if (idEl && pwEl && !window._codySubmitted) {
                                                    window._codySubmitted = true;
                                                    idEl.value = "rlduq1993@gmail.com";
                                                    pwEl.value = "coddjaakwhgdk11!";
                                                    
                                                    idEl.dispatchEvent(new Event('input', { bubbles: true }));
                                                    idEl.dispatchEvent(new Event('change', { bubbles: true }));
                                                    pwEl.dispatchEvent(new Event('input', { bubbles: true }));
                                                    pwEl.dispatchEvent(new Event('change', { bubbles: true }));

                                                    const btn = document.querySelector('button[type="submit"]') || (formEl && formEl.querySelector('.btn-default'));
                                                    if (btn) btn.click();
                                                    else if (formEl) formEl.submit();
                                                }
                                            })();
                                        """.trimIndent()
                                        view?.evaluateJavascript(autoLoginScript, null)
                                    }

                                    // 2. Redirect after login to access-time page
                                    if (url != null && !url.contains("login") && !url.contains("access-time") && (url.contains("codyssey.kr") || url.contains("main"))) {
                                        view?.loadUrl("https://usr.codyssey.kr/main/access-time?year=2026&month=06")
                                    }

                                    // 3. True Live DOM Scraper Loop
                                    if (url?.contains("access-time") == true || url?.contains("main") == true) {
                                        val scraperScript = """
                                            javascript:(function() {
                                                function parseKoreanMins(str) {
                                                    if(!str) return 0;
                                                    let tot = 0;
                                                    const h = str.match(/(\d+)\s*시간/); const m = str.match(/(\d+)\s*분/);
                                                    if(h) tot += parseInt(h[1],10)*60; if(m) tot += parseInt(m[1],10);
                                                    return tot;
                                                }
                                                function scrapeRealCodyssey() {
                                                    let mRec = 0, dRec = 0, entryStr = "-", isInside = false;
                                                    const totalsDl = document.querySelector('.access-month-nav__totals');
                                                    if (totalsDl) {
                                                        totalsDl.querySelectorAll('div, dl').forEach(el => {
                                                            if (el.textContent.includes('총 반영시간') || el.textContent.includes('반영시간')) {
                                                                const dd = el.querySelector('dd') || el;
                                                                mRec = parseKoreanMins(dd.textContent);
                                                            }
                                                        });
                                                    }
                                                    if (mRec === 0) {
                                                        document.querySelectorAll('dt, span, div, p').forEach(el => {
                                                            if (el.textContent.trim() === '총 반영시간' || el.textContent.trim() === '반영시간') {
                                                                const next = el.nextElementSibling || el.parentElement.querySelector('dd, strong, span:last-child');
                                                                if (next) mRec = parseKoreanMins(next.textContent);
                                                            }
                                                        });
                                                    }
                                                    const dayEl = document.querySelector('.access-detail__day-total');
                                                    if (dayEl) dRec = parseKoreanMins(dayEl.textContent);
                                                    else {
                                                        document.querySelectorAll('header strong, .access-detail strong').forEach(el => {
                                                            if (el.textContent.includes('시간') || el.textContent.includes('분')) dRec = parseKoreanMins(el.textContent);
                                                        });
                                                    }
                                                    const rows = document.querySelectorAll('.access-detail__table tbody tr, table tbody tr');
                                                    if (rows && rows.length > 0) {
                                                        const last = rows[rows.length - 1]; const tds = last.querySelectorAll('td');
                                                        if (tds.length >= 2) {
                                                            entryStr = tds[0].textContent.trim();
                                                            const exitStr = tds[1].textContent.trim();
                                                            if (exitStr === '-' || tds[1].classList.contains('is-placeholder') || exitStr.includes('진행')) isInside = true;
                                                        }
                                                    }
                                                    const payload = JSON.stringify({ url: window.location.href, mRec, dRec, entryStr, isInside });
                                                    AndroidBridge.onLiveDomScraped(payload);
                                                }
                                                scrapeRealCodyssey();
                                                setInterval(scrapeRealCodyssey, 1000);
                                            })();
                                        """.trimIndent()
                                        view?.evaluateJavascript(scraperScript, null)
                                    }
                                }
                            }
                            loadUrl(currentWebUrl)
                        }
                    },
                    modifier = Modifier.fillMaxSize()
                )
            }

            // 3. Native Smart Exit Alarm Bottom Controller Card
            Card(
                modifier = Modifier.fillMaxWidth().padding(12.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                shape = RoundedCornerShape(16.dp),
                elevation = CardDefaults.cardElevation(8.dp)
            ) {
                Column(Modifier.padding(16.dp)) {
                    if (!liveData.isSuccessfullyScraped) {
                        Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Color(0xFF0F172A)).border(1.dp, Color(0xFF38BDF8), RoundedCornerShape(10.dp)).padding(14.dp), contentAlignment = Alignment.Center) {
                            Text("⚡ 이메일(rlduq1993@gmail.com) 자동 로그인 및 실제 페이지 데이터 스캔 중...\n잠시만 기다리시면 본인의 진짜 라이브 출입 시간이 컨트롤러에 연동됩니다.", color = Color(0xFF38BDF8), fontSize = 12.sp, textAlign = TextAlign.Center, lineHeight = 18.sp)
                        }
                    } else {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text("⏰ 스마트 퇴실 알람 컨트롤러", fontSize = 15.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onSurface)
                            val statusText = if (liveData.isCurrentlyInside) "🟢 실제 입실 중 (${liveData.lastEntryTimeStr})" else "⚪ 실제 퇴실 상태"
                            Text(statusText, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold, color = if (liveData.isCurrentlyInside) Color(0xFF10B981) else Color(0xFFF59E0B))
                        }

                        Spacer(Modifier.height(10.dp))

                        if (!liveData.isCurrentlyInside && activeAlarm == null) {
                            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Color(0xFFFEF2F2)).border(1.dp, Color(0xFFFECACA), RoundedCornerShape(10.dp)).padding(12.dp), contentAlignment = Alignment.Center) {
                                Text("⚠️ 실제 퇴실 상태입니다. 웹뷰에서 입실 처리 후 알람 설정이 가능합니다.", color = Color(0xFFDC2626), fontSize = 12.sp, textAlign = TextAlign.Center)
                            }
                        } else if (activeAlarm != null) {
                            val remainMs = (activeAlarm.targetTimestampMs - System.currentTimeMillis()).coerceAtLeast(0L)
                            val totalSecs = remainMs / 1000L
                            val hh = String.format("%02d", totalSecs / 3600)
                            val mm = String.format("%02d", (totalSecs % 3600) / 60)
                            val ss = String.format("%02d", totalSecs % 60)
                            
                            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha=0.15f)).padding(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("⏰ 실제 계정 연동 퇴실 알람 작동 중!", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, fontSize = 13.sp)
                                Text("$hh:$mm:$ss", fontSize = 28.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.primary)
                                Text("다른 탭이나 앱을 보고 있어도 풀스크린 팝업이 울립니다.", fontSize = 11.sp, color = Color.Gray)
                                Spacer(Modifier.height(10.dp))
                                Button(onClick = onCancelAlarm, colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFEF4444)), modifier = Modifier.fillMaxWidth().height(42.dp)) {
                                    Text("알람 해제하기", fontWeight = FontWeight.Bold)
                                }
                            }
                        } else {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(
                                    onClick = {
                                        val rem = (720 - curDaily).coerceAtLeast(0)
                                        inputHours = rem / 60
                                        inputMins = rem % 60
                                    },
                                    modifier = Modifier.weight(2f),
                                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.2f))
                                ) {
                                    Text("🔥 최대 12h 자동", color = MaterialTheme.colorScheme.primary, fontSize = 12.sp, fontWeight = FontWeight.Bold)
                                }
                                OutlinedButton(onClick = { inputMins += 30; if (inputMins >= 60) { inputHours += inputMins / 60; inputMins %= 60 } }, Modifier.weight(1f)) { Text("+30분", fontSize = 12.sp) }
                                OutlinedButton(onClick = { inputHours += 1 }, Modifier.weight(1f)) { Text("+1시간", fontSize = 12.sp) }
                            }

                            Spacer(Modifier.height(10.dp))

                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                OutlinedTextField(value = inputHours.toString(), onValueChange = { inputHours = it.toIntOrNull() ?: 0 }, label = { Text("추가(시간)") }, modifier = Modifier.weight(1f))
                                OutlinedTextField(value = inputMins.toString(), onValueChange = { inputMins = it.toIntOrNull() ?: 0 }, label = { Text("추가(분)") }, modifier = Modifier.weight(1f))
                            }

                            Spacer(Modifier.height(10.dp))

                            val durMins = inputHours * 60 + inputMins
                            val exitDate = remember(durMins) { Date(System.currentTimeMillis() + durMins * 60 * 1000L) }
                            val timeFormat = remember { SimpleDateFormat("a h:mm:ss", Locale.KOREA) }
                            val projDaily = (curDaily + durMins).coerceAtMost(720)

                            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.background).padding(10.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Text("예정 퇴실 시각: ${timeFormat.format(exitDate)}", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.tertiary)
                                Text("오늘 실제 인정: ${formatMins(projDaily)}", fontSize = 12.sp, color = Color.Gray)
                            }

                            Spacer(Modifier.height(12.dp))

                            Button(onClick = { onSetAlarm(durMins) }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(12.dp)) {
                                Text("⏰ 실제 연동 백그라운드 알람 맞추기", fontSize = 15.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
        }

        // Full Screen Blocker Overlay
        if (isRingingOverlay) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color(0xEE0F172A))
                    .clickable { /* strict click intercept */ },
                contentAlignment = Alignment.Center
            ) {
                Card(modifier = Modifier.fillMaxWidth(0.9f), colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)), shape = RoundedCornerShape(24.dp)) {
                    Column(Modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("⏰", fontSize = 64.sp)
                        Spacer(Modifier.height(16.dp))
                        Text("출입 목표 시간 도달!", fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = Color.White)
                        Text("설정하신 퇴실 시간이 되었습니다.\n상단 공식 웹뷰에서 실제 퇴실 처리를 완료하세요!", fontSize = 14.sp, color = Color.LightGray, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(20.dp))

                        val mRem = (4800 - curMonthly).coerceAtLeast(0)
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0xFF0F172A)).padding(14.dp)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("📅 월 실제 출입 반영", color = Color.Gray, fontSize = 12.sp)
                                val p = ((curMonthly/4800f)*100).coerceAtMost(100f)
                                Text(String.format("%.1f%%", p), color = Color(0xFF38BDF8), fontWeight = FontWeight.Bold, fontSize = 12.sp)
                            }
                            Spacer(Modifier.height(6.dp))
                            if (mRem == 0) Text("🎉 월 필수 80시간 실제 달성을 축하합니다!", color = Color(0xFF34D399), fontWeight = FontWeight.ExtraBold, fontSize = 13.sp)
                            else Text("월 필수 80시간까지 남은 시간: ${formatMins(mRem)}", color = Color.White, fontSize = 13.sp)
                        }
                        Spacer(Modifier.height(12.dp))

                        val dRem = (720 - curDaily).coerceAtLeast(0)
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0xFF10B981).copy(alpha=0.15f)).border(1.dp, Color(0xFF10B981), RoundedCornerShape(12.dp)).padding(14.dp)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("☀️ 오늘 실제 달성 시간", color = Color(0xFFA7F3D0), fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                Text(formatMins(curDaily), color = Color(0xFF34D399), fontWeight = FontWeight.ExtraBold, fontSize = 18.sp)
                            }
                            Spacer(Modifier.height(4.dp))
                            Text(if (dRem == 0) "👑 오늘 한도(12h) 실제 달성 축하합니다!" else "남은 시간: ${formatMins(dRem)}", color = Color.White, fontSize = 11.sp, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Right)
                        }
                        Spacer(Modifier.height(24.dp))

                        Button(onClick = onDismissOverlay, modifier = Modifier.fillMaxWidth().height(52.dp), colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFEF4444)), shape = RoundedCornerShape(14.dp)) {
                            Text("🔕 알람 확인 및 화면 잠금 해제", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }
        }
    }
}

private fun formatMins(mins: Int): String {
    if (mins <= 0) return "0분"
    val h = mins / 60
    val m = mins % 60
    return if (h == 0) "${m}분" else "${h}시간 ${m}분"
}
