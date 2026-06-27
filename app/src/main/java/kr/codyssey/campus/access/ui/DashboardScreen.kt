package kr.codyssey.campus.access.ui

import android.annotation.SuppressLint
import android.webkit.*
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kr.codyssey.campus.access.bridge.ScrapedAccessPayload
import kr.codyssey.campus.access.model.*
import java.text.SimpleDateFormat
import java.util.*

@Composable
fun DashboardScreen(
    liveData: ScrapedAccessPayload,
    onSelectDayOnWeb: (Int) -> Unit,
    onSetAlarm: (Int) -> Unit,
    onCancelAlarm: () -> Unit,
    activeAlarm: AlarmConfig?,
    isRingingOverlay: Boolean,
    onDismissOverlay: () -> Unit
) {
    var selectedDay by remember { mutableStateOf(27) }
    var devModeOverrideInside by remember { mutableStateOf(false) }
    var calcMode by remember { mutableStateOf("ADD") } // 'ADD' vs 'GOAL'
    var inputHours by remember { mutableStateOf(4) }
    var inputMins by remember { mutableStateOf(0) }

    val effectiveIsInside = liveData.isCurrentlyInside || devModeOverrideInside

    // Auto terminate active alarm on checkout (exit)
    LaunchedEffect(effectiveIsInside, activeAlarm) {
        if (!effectiveIsInside && activeAlarm != null) {
            onCancelAlarm()
        }
    }

    var ticks by remember { mutableStateOf(0) }
    LaunchedEffect(effectiveIsInside) {
        while (true) {
            kotlinx.coroutines.delay(1000L)
            ticks++
        }
    }

    val ongoingMins = if (effectiveIsInside && liveData.isSuccessfullyScraped) ticks / 60 else 0
    val curDaily = (liveData.dailyCompletedMinutes + ongoingMins).coerceAtMost(720)
    val curMonthly = liveData.monthlyRecognizedMinutes + ongoingMins

    Box(modifier = Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Top App Bar
            item {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("⛵", fontSize = 28.sp)
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text("Codyssey 출입시간 매니저", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onBackground)
                            val statusText = if (liveData.isSuccessfullyScraped) "🟢 라이브 출입데이터 실시간 스트리밍 중" else "📡 공식 웹뷰 백그라운드 데이터 감지 중..."
                            Text(statusText, fontSize = 11.sp, color = if(liveData.isSuccessfullyScraped) Color(0xFF10B981) else Color(0xFF38BDF8), fontWeight = FontWeight.Bold)
                        }
                    }
                }
            }

            // Monthly Card
            item {
                Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.padding(18.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("📅 이번 달 출입 목표 (필수 80시간)", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            val mPct = ((curMonthly / 4800f) * 100).coerceAtMost(100f)
                            Text(String.format("%.1f%%", mPct), color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.ExtraBold)
                        }
                        Spacer(Modifier.height(10.dp))
                        LinearProgressIndicator(progress = (curMonthly / 4800f).coerceIn(0f, 1f), modifier = Modifier.fillMaxWidth().height(10.dp).clip(CircleShape), color = MaterialTheme.colorScheme.primary, trackColor = MaterialTheme.colorScheme.background)
                        Spacer(Modifier.height(10.dp))
                        val mRem = (4800 - curMonthly).coerceAtLeast(0)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("반영: ${formatMins(curMonthly)}", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface)
                            Text(if (mRem == 0) "🎉 월 필수 달성!" else "남은 시간: ${formatMins(mRem)}", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }

            // Daily Card
            item {
                Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.padding(18.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("☀️ 오늘 인정 가능 남은 시간", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            val dRem = (720 - curDaily).coerceAtLeast(0)
                            Text(if (dRem == 0) "⚠️ 한도 도달" else formatMins(dRem), color = MaterialTheme.colorScheme.tertiary, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp)
                        }
                        Spacer(Modifier.height(10.dp))
                        LinearProgressIndicator(progress = (curDaily / 720f).coerceIn(0f, 1f), modifier = Modifier.fillMaxWidth().height(10.dp).clip(CircleShape), color = MaterialTheme.colorScheme.tertiary, trackColor = MaterialTheme.colorScheme.background)
                        Spacer(Modifier.height(8.dp))
                        Text("오늘 총 인정: ${formatMins(curDaily)} / 최대 12시간", fontSize = 12.sp, color = Color.Gray)
                    }
                }
            }

            // Calendar Card
            item {
                Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.padding(16.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) { Text("2026. 06", fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onSurface) }
                        Spacer(Modifier.height(14.dp))
                        Row(Modifier.fillMaxWidth()) {
                            listOf("일", "월", "화", "수", "목", "금", "토").forEachIndexed { idx, title ->
                                Text(title, modifier = Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = if (idx == 0) Color(0xFFEF4444) else if (idx == 6) MaterialTheme.colorScheme.primary else Color.Gray)
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            val gridCells = listOf(0, 1, 2, 3, 4, 5, 6) + (7..30).toList() + listOf(0, 0, 0, 0)
                            gridCells.chunked(7).forEach { week ->
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    week.forEach { dayNum ->
                                        if (dayNum == 0) Box(Modifier.weight(1f).height(48.dp))
                                        else {
                                            val isSelected = (dayNum == selectedDay)
                                            val hasRec = liveData.dayTotalsMap.containsKey(dayNum) || (dayNum == 27 && curDaily > 0)
                                            Box(
                                                modifier = Modifier.weight(1f).height(48.dp).clip(RoundedCornerShape(10.dp))
                                                    .background(if (isSelected) MaterialTheme.colorScheme.primary else if (hasRec) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f) else MaterialTheme.colorScheme.background)
                                                    .border(1.dp, if (isSelected) Color.White else if (hasRec) MaterialTheme.colorScheme.primary else Color.Transparent, RoundedCornerShape(10.dp))
                                                    .clickable { selectedDay = dayNum; onSelectDayOnWeb(dayNum) },
                                                contentAlignment = Alignment.Center
                                            ) {
                                                Text(dayNum.toString(), fontSize = 14.sp, fontWeight = if (isSelected || hasRec) FontWeight.ExtraBold else FontWeight.Normal, color = if (isSelected) Color.White else if (hasRec) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onBackground)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Record Table Card
            item {
                Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.padding(16.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("6월 ${selectedDay}일 기록", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                            val dayTot = if(selectedDay == 27) curDaily else (liveData.dayTotalsMap[selectedDay] ?: 0)
                            Text(formatMins(dayTot), fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.tertiary)
                        }
                        Spacer(Modifier.height(12.dp))
                        Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).padding(8.dp)) {
                            Text("입실", Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 12.sp, color = Color.Gray)
                            Text("퇴실", Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 12.sp, color = Color.Gray)
                            Text("체류시간", Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 12.sp, color = Color.Gray)
                        }
                        if (liveData.tableSessions.isEmpty()) {
                            Text("출입 기록이 없습니다.", Modifier.fillMaxWidth().padding(20.dp), textAlign = TextAlign.Center, color = Color.Gray)
                        } else {
                            liveData.tableSessions.forEach { s ->
                                Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                                    Text(s.entryTime, Modifier.weight(1f), textAlign = TextAlign.Center, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
                                    Text(s.exitTime, Modifier.weight(1f), textAlign = TextAlign.Center, fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = if (s.exitTime == "-") Color(0xFFF59E0B) else Color.Unspecified)
                                    Text(s.durationStr, Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 13.sp)
                                }
                            }
                        }
                    }
                }
            }

            // Smart Exit Alarm Controller Card
            item {
                Card(modifier = Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.padding(18.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text("⏰ 스마트 추가 체류 알람 설정", fontSize = 16.sp, fontWeight = FontWeight.Bold)
                            val badgeText = if (effectiveIsInside) "🟢 입실 중" else "⚪ 퇴실 완료"
                            Text(badgeText, fontSize = 12.sp, fontWeight = FontWeight.ExtraBold, color = if (effectiveIsInside) Color(0xFF10B981) else Color(0xFFF59E0B))
                        }
                        
                        Spacer(Modifier.height(14.dp))

                        // =========================================================================
                        // [나중에 정식 출시 시 아래 개발자 테스트 전용 카드 블록만 삭제하시면 됩니다 시작]
                        // =========================================================================
                        Card(
                            modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp),
                            colors = CardDefaults.cardColors(containerColor = if(effectiveIsInside) Color(0xFF10B981).copy(alpha=0.15f) else Color(0xFFF59E0B).copy(alpha=0.15f)),
                            border = androidx.compose.foundation.BorderStroke(1.dp, if(effectiveIsInside) Color(0xFF10B981) else Color(0xFFF59E0B))
                        ) {
                            Row(
                                modifier = Modifier.fillMaxWidth().padding(14.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(Modifier.weight(1f)) {
                                    Text("🛠️ 개발자 모드: 강제 입실 상태 ON/OFF", fontWeight = FontWeight.Bold, fontSize = 13.sp, color = Color.White)
                                    Text("현재 퇴실 상태여도 알람 맞추기 테스트 가능", fontSize = 11.sp, color = Color.LightGray)
                                }
                                Switch(
                                    checked = devModeOverrideInside,
                                    onCheckedChange = { devModeOverrideInside = it }
                                )
                            }
                        }
                        // =========================================================================
                        // [나중에 정식 출시 시 위 개발자 테스트 전용 카드 블록만 삭제하시면 됩니다 끝]
                        // =========================================================================

                        if (!effectiveIsInside && activeAlarm == null) {
                            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Color(0xFFFEF2F2)).border(1.dp, Color(0xFFFECACA), RoundedCornerShape(10.dp)).padding(14.dp), contentAlignment = Alignment.Center) {
                                Text("⚠️ 현재 퇴실 상태입니다.\n입실 처리 후에 퇴실 알람을 맞출 수 있습니다. (테스트 시 위 개발자 모드 토글을 켜세요)", color = Color(0xFFDC2626), fontSize = 12.sp, textAlign = TextAlign.Center)
                            }
                        } else if (activeAlarm != null) {
                            val remainMs = (activeAlarm.targetTimestampMs - System.currentTimeMillis()).coerceAtLeast(0L)
                            val totalSecs = remainMs / 1000L
                            val hh = String.format("%02d", totalSecs / 3600)
                            val mm = String.format("%02d", (totalSecs % 3600) / 60)
                            val ss = String.format("%02d", totalSecs % 60)
                            
                            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha=0.15f)).padding(14.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("⏰ 퇴실 알람 작동 중!", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary, fontSize = 13.sp)
                                Text("$hh:$mm:$ss", fontSize = 28.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.primary)
                                Text("화면이 꺼져 있거나 다른 앱 중에도 팝업이 울립니다.", fontSize = 11.sp, color = Color.Gray)
                                Spacer(Modifier.height(10.dp))
                                Button(onClick = onCancelAlarm, colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFEF4444)), modifier = Modifier.fillMaxWidth().height(42.dp)) {
                                    Text("알람 해제하기", fontWeight = FontWeight.Bold)
                                }
                            }
                        } else {
                            // Click-clack Mode Toggle
                            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.background).padding(4.dp)) {
                                Box(Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).background(if(calcMode=="ADD") MaterialTheme.colorScheme.primary else Color.Transparent).clickable { calcMode="ADD"; inputHours=4; inputMins=0 }.padding(8.dp), contentAlignment = Alignment.Center) {
                                    Text("➕ 추가 체류 설정", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = if(calcMode=="ADD") Color.White else Color.Gray)
                                }
                                Box(Modifier.weight(1f).clip(RoundedCornerShape(8.dp)).background(if(calcMode=="GOAL") MaterialTheme.colorScheme.primary else Color.Transparent).clickable { calcMode="GOAL"; inputHours=8; inputMins=0 }.padding(8.dp), contentAlignment = Alignment.Center) {
                                    Text("🎯 일일 목표 설정", fontSize = 12.sp, fontWeight = FontWeight.Bold, color = if(calcMode=="GOAL") Color.White else Color.Gray)
                                }
                            }

                            Spacer(Modifier.height(10.dp))

                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(
                                    onClick = {
                                        if (calcMode == "ADD") {
                                            val rem = (720 - curDaily).coerceAtLeast(0)
                                            inputHours = rem / 60
                                            inputMins = rem % 60
                                        } else {
                                            inputHours = 12; inputMins = 0
                                        }
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

                            val lblH = if (calcMode == "ADD") "추가 체류(시간)" else "일일 목표(시간)"
                            val lblM = if (calcMode == "ADD") "추가 체류(분)" else "일일 목표(분)"

                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                OutlinedTextField(value = inputHours.toString(), onValueChange = { inputHours = it.toIntOrNull() ?: 0 }, label = { Text(lblH) }, modifier = Modifier.weight(1f))
                                OutlinedTextField(value = inputMins.toString(), onValueChange = { inputMins = it.toIntOrNull() ?: 0 }, label = { Text(lblM) }, modifier = Modifier.weight(1f))
                            }

                            Spacer(Modifier.height(10.dp))

                            val configuredMins = inputHours * 60 + inputMins
                            val durMins = if (calcMode == "ADD") configuredMins else (configuredMins - curDaily).coerceAtLeast(1)
                            val exitDate = remember(durMins) { Date(System.currentTimeMillis() + durMins * 60 * 1000L) }
                            val timeFormat = remember { SimpleDateFormat("a h:mm:ss", Locale.KOREA) }
                            val projDaily = if (calcMode == "ADD") (curDaily + durMins).coerceAtMost(720) else configuredMins

                            Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.background).padding(10.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                                Text("예정 퇴실 시각: ${timeFormat.format(exitDate)}", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.tertiary)
                                Text("오늘 총 인정: ${formatMins(projDaily)}", fontSize = 12.sp, color = Color.Gray)
                            }

                            Spacer(Modifier.height(12.dp))

                            Button(onClick = { onSetAlarm(durMins) }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(12.dp)) {
                                Text("⏰ 스마트 백그라운드 알람 맞추기", fontSize = 15.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
            item { Spacer(Modifier.height(30.dp)) }
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
                        Text("설정하신 퇴실 시간이 되었습니다.\n상단 공식 웹앱에서 실제 퇴실 처리를 완료하세요!", fontSize = 14.sp, color = Color.LightGray, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(20.dp))

                        val mRem = (4800 - curMonthly).coerceAtLeast(0)
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0xFF0F172A)).padding(14.dp)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("📅 월 실제 출입 반영", color = Color.Gray, fontSize = 12.sp)
                                val p = ((curMonthly/4800f)*100).coerceAtMost(100f)
                                Text(String.format("%.1f%%", p), color = Color(0xFF38BDF8), fontWeight = FontWeight.Bold, fontSize = 12.sp)
                            }
                            Spacer(Modifier.height(6.dp))
                            if (mRem == 0) Text("🎉 월 필수 80시간 달성 축하합니다!", color = Color(0xFF34D399), fontWeight = FontWeight.ExtraBold, fontSize = 13.sp)
                            else Text("월 필수 80시간까지 남은 시간: ${formatMins(mRem)}", color = Color.White, fontSize = 13.sp)
                        }
                        Spacer(Modifier.height(12.dp))

                        val dRem = (720 - curDaily).coerceAtLeast(0)
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0xFF10B981).copy(alpha=0.15f)).border(1.dp, Color(0xFF10B981), RoundedCornerShape(12.dp)).padding(14.dp)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("☀️ 오늘 달성 시간", color = Color(0xFFA7F3D0), fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                Text(formatMins(curDaily), color = Color(0xFF34D399), fontWeight = FontWeight.ExtraBold, fontSize = 18.sp)
                            }
                            Spacer(Modifier.height(4.dp))
                            Text(if (dRem == 0) "👑 오늘 한도(12h) 달성 축하합니다!" else "남은 시간: ${formatMins(dRem)}", color = Color.White, fontSize = 11.sp, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Right)
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
