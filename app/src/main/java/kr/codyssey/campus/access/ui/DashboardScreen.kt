package kr.codyssey.campus.access.ui

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
    onSetAlarm: (Int) -> Unit,
    onCancelAlarm: () -> Unit,
    activeAlarm: AlarmConfig?,
    isRingingOverlay: Boolean,
    onDismissOverlay: () -> Unit,
    onReopenWebView: () -> Unit
) {
    var selectedDay by remember { mutableStateOf(27) }
    var isInside by remember(liveData.isCurrentlyInside) { mutableStateOf(liveData.isCurrentlyInside) }
    var inputHours by remember { mutableStateOf(4) }
    var inputMins by remember { mutableStateOf(0) }

    val mockDays = remember {
        (1..30).map { d ->
            when (d) {
                7 -> DayAccessRecord(d, 361, true, listOf(SessionRecord("10:00:00", "16:01:00", "06:01:00")))
                16 -> DayAccessRecord(d, 720, true, listOf(SessionRecord("08:30:00", "20:30:00", "12:00:00")))
                21 -> DayAccessRecord(d, 703, true, listOf(SessionRecord("09:00:00", "20:43:00", "11:43:00")))
                22 -> DayAccessRecord(d, 447, true, listOf(SessionRecord("09:30:00", "16:57:00", "07:27:00")))
                23 -> DayAccessRecord(d, 430, true, listOf(SessionRecord("10:00:00", "17:10:00", "07:10:00")))
                25 -> DayAccessRecord(d, 659, true, listOf(SessionRecord("09:00:00", "19:59:00", "10:59:00")))
                26 -> DayAccessRecord(d, 274, true, listOf(SessionRecord("13:00:00", "17:34:00", "04:34:00")))
                27 -> DayAccessRecord(d, liveData.dailyCompletedMinutes, true, listOf(
                    SessionRecord("09:42:32", "12:29:03", "02:46:31"),
                    SessionRecord(liveData.lastEntryTimeStr, if(isInside) "-" else "18:00:00", if(isInside) "진행중" else "05:03:16")
                ))
                else -> DayAccessRecord(d, 0, false)
            }
        }
    }

    val currentDayRecord = mockDays.find { it.day == selectedDay } ?: DayAccessRecord(selectedDay, 0, false)
    
    var ticks by remember { mutableStateOf(0) }
    LaunchedEffect(isInside) {
        while (true) {
            kotlinx.coroutines.delay(1000L)
            ticks++
        }
    }

    val liveOngoingMins = if (selectedDay == 27 && isInside) ticks / 60 else 0
    val dailyRecognized = (currentDayRecord.totalRecognizedMinutes + liveOngoingMins).coerceAtMost(720)
    val monthlyRecognized = (liveData.monthlyRecognizedMinutes + liveOngoingMins)

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
                            Text("Codyssey 공식 웹뷰 연동", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onBackground)
                            Text("🔗 실시간 DOM 스트리밍 활성", fontSize = 11.sp, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.ExtraBold)
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        OutlinedButton(onClick = onReopenWebView, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
                            Text("🌐 웹뷰 열기", fontSize = 11.sp)
                        }
                        OutlinedButton(onClick = { isInside = !isInside }, contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp)) {
                            Text(if (isInside) "🟢 입실중" else "⚪ 퇴실완료", fontSize = 11.sp)
                        }
                    }
                }
            }

            // Monthly Status Card
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Column(Modifier.padding(18.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("📅 이번 달 출입 목표 (필수 80시간)", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            val mPct = ((monthlyRecognized / 4800f) * 100).coerceAtMost(100f)
                            Text(String.format("%.1f%%", mPct), color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.ExtraBold)
                        }
                        Spacer(Modifier.height(10.dp))
                        LinearProgressIndicator(
                            progress = (monthlyRecognized / 4800f).coerceIn(0f, 1f),
                            modifier = Modifier.fillMaxWidth().height(10.dp).clip(CircleShape),
                            color = MaterialTheme.colorScheme.primary,
                            trackColor = MaterialTheme.colorScheme.background
                        )
                        Spacer(Modifier.height(10.dp))
                        val mRem = (4800 - monthlyRecognized).coerceAtLeast(0)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("반영: ${formatMins(monthlyRecognized)}", fontSize = 13.sp, color = MaterialTheme.colorScheme.onSurface)
                            Text(if (mRem == 0) "🎉 월 필수 달성!" else "남은 시간: ${formatMins(mRem)}", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }

            // Daily Status Card
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Column(Modifier.padding(18.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("☀️ 오늘 인정 가능 남은 시간", fontWeight = FontWeight.Bold, fontSize = 14.sp)
                            val dRem = (720 - dailyRecognized).coerceAtLeast(0)
                            Text(if (dRem == 0) "⚠️ 한도 도달" else formatMins(dRem), color = MaterialTheme.colorScheme.tertiary, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp)
                        }
                        Spacer(Modifier.height(10.dp))
                        LinearProgressIndicator(
                            progress = (dailyRecognized / 720f).coerceIn(0f, 1f),
                            modifier = Modifier.fillMaxWidth().height(10.dp).clip(CircleShape),
                            color = MaterialTheme.colorScheme.tertiary,
                            trackColor = MaterialTheme.colorScheme.background
                        )
                        Spacer(Modifier.height(8.dp))
                        Text("오늘 총 인정: ${formatMins(dailyRecognized)} / 최대 12시간", fontSize = 12.sp, color = Color.Gray)
                    }
                }
            }

            // Calendar Card
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Column(Modifier.padding(16.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
                            Text("2026. 06", fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.onSurface)
                        }
                        Spacer(Modifier.height(14.dp))
                        
                        Row(Modifier.fillMaxWidth()) {
                            listOf("일", "월", "화", "수", "목", "금", "토").forEachIndexed { idx, title ->
                                Text(
                                    title, 
                                    modifier = Modifier.weight(1f), 
                                    textAlign = TextAlign.Center, 
                                    fontSize = 13.sp, 
                                    fontWeight = FontWeight.Bold,
                                    color = if (idx == 0) Color(0xFFEF4444) else if (idx == 6) MaterialTheme.colorScheme.primary else Color.Gray
                                )
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            val gridCells = listOf(0, 1, 2, 3, 4, 5, 6) + (7..30).toList() + listOf(0, 0, 0, 0)
                            gridCells.chunked(7).forEach { week ->
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    week.forEach { dayNum ->
                                        if (dayNum == 0) {
                                            Box(Modifier.weight(1f).height(48.dp))
                                        } else {
                                            val isSelected = (dayNum == selectedDay)
                                            val dayObj = mockDays.find { it.day == dayNum }
                                            val hasRec = dayObj?.hasDetail == true
                                            
                                            Box(
                                                modifier = Modifier
                                                    .weight(1f)
                                                    .height(48.dp)
                                                    .clip(RoundedCornerShape(10.dp))
                                                    .background(
                                                        if (isSelected) MaterialTheme.colorScheme.primary 
                                                        else if (hasRec) MaterialTheme.colorScheme.primary.copy(alpha = 0.15f) 
                                                        else MaterialTheme.colorScheme.background
                                                    )
                                                    .border(
                                                        1.dp, 
                                                        if (isSelected) Color.White else if (hasRec) MaterialTheme.colorScheme.primary else Color.Transparent, 
                                                        RoundedCornerShape(10.dp)
                                                    )
                                                    .clickable { selectedDay = dayNum },
                                                contentAlignment = Alignment.Center
                                            ) {
                                                Text(
                                                    dayNum.toString(),
                                                    fontSize = 14.sp,
                                                    fontWeight = if (isSelected || hasRec) FontWeight.ExtraBold else FontWeight.Normal,
                                                    color = if (isSelected) Color.White else if (hasRec) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onBackground
                                                )
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Selected Day Record Table
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Column(Modifier.padding(16.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("6월 ${selectedDay}일 기록", fontWeight = FontWeight.Bold, fontSize = 16.sp)
                            Text(formatMins(currentDayRecord.totalRecognizedMinutes), fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.tertiary)
                        }
                        Spacer(Modifier.height(12.dp))
                        Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).padding(8.dp)) {
                            Text("입실", Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 12.sp, color = Color.Gray)
                            Text("퇴실", Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 12.sp, color = Color.Gray)
                            Text("체류시간", Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 12.sp, color = Color.Gray)
                        }
                        if (currentDayRecord.sessions.isEmpty()) {
                            Text("출입 기록이 없습니다.", Modifier.fillMaxWidth().padding(20.dp), textAlign = TextAlign.Center, color = Color.Gray)
                        } else {
                            currentDayRecord.sessions.forEach { s ->
                                Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                                    Text(s.entryTime, Modifier.weight(1f), textAlign = TextAlign.Center, fontFamily = FontFamily.Monospace, fontSize = 13.sp)
                                    Text(if (selectedDay == 27 && !isInside && s.exitTime == "-") "18:00:00" else s.exitTime, Modifier.weight(1f), textAlign = TextAlign.Center, fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = if (s.exitTime == "-") Color(0xFFF59E0B) else Color.Unspecified)
                                    Text(if (selectedDay == 27 && isInside && s.durationStr == "진행중") "진행중 🟢" else s.durationStr, Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 13.sp)
                                }
                            }
                        }
                    }
                }
            }

            // Alarm Setup Card
            item {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Column(Modifier.padding(18.dp)) {
                        Text("⏰ 스마트 퇴실 알람 설정", fontSize = 16.sp, fontWeight = FontWeight.Bold)
                        Spacer(Modifier.height(12.dp))
                        
                        if (!isInside) {
                            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Color(0xFFFEF2F2)).border(1.dp, Color(0xFFFECACA), RoundedCornerShape(10.dp)).padding(14.dp), contentAlignment = Alignment.Center) {
                                Text("⚠️ 현재 퇴실 상태입니다.\n캠퍼스 입실 처리 후에 알람을 맞출 수 있습니다.", color = Color(0xFFDC2626), fontSize = 13.sp, textAlign = TextAlign.Center)
                            }
                        } else {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                OutlinedTextField(
                                    value = inputHours.toString(),
                                    onValueChange = { inputHours = it.toIntOrNull() ?: 0 },
                                    label = { Text("추가 체류(시간)") },
                                    modifier = Modifier.weight(1f)
                                )
                                OutlinedTextField(
                                    value = inputMins.toString(),
                                    onValueChange = { inputMins = it.toIntOrNull() ?: 0 },
                                    label = { Text("추가 체류(분)") },
                                    modifier = Modifier.weight(1f)
                                )
                            }
                            Spacer(Modifier.height(14.dp))
                            
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(
                                    onClick = {
                                        val rem = (720 - dailyRecognized).coerceAtLeast(0)
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
                            Spacer(Modifier.height(14.dp))
                            
                            val durMins = inputHours * 60 + inputMins
                            val exitDate = remember(durMins) { Date(System.currentTimeMillis() + durMins * 60 * 1000L) }
                            val timeFormat = remember { SimpleDateFormat("a h:mm:ss", Locale.KOREA) }
                            val projDaily = (dailyRecognized + durMins).coerceAtMost(720)
                            
                            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.background).padding(12.dp)) {
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("설정된 체류 시간:", fontSize = 13.sp, color = Color.Gray); Text(formatMins(durMins), fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary) }
                                Spacer(Modifier.height(4.dp))
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("예정 퇴실 시각:", fontSize = 13.sp, color = Color.Gray); Text(timeFormat.format(exitDate), fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.tertiary) }
                                Spacer(Modifier.height(4.dp))
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { Text("퇴실 시 오늘 인정:", fontSize = 13.sp, color = Color.Gray); Text("${formatMins(projDaily)} / 한도 12h", fontSize = 13.sp, color = Color.LightGray) }
                            }
                            Spacer(Modifier.height(16.dp))
                            
                            Button(
                                onClick = { onSetAlarm(durMins) },
                                modifier = Modifier.fillMaxWidth().height(50.dp),
                                shape = RoundedCornerShape(12.dp)
                            ) {
                                Text("⏰ 백그라운드 알람 맞추기", fontSize = 15.sp, fontWeight = FontWeight.Bold)
                            }
                        }
                    }
                }
            }
            
            item { Spacer(Modifier.height(30.dp)) }
        }

        // Full Screen Alert Blocker
        if (isRingingOverlay) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color(0xEE0F172A))
                    .clickable(enabled = false) {},
                contentAlignment = Alignment.Center
            ) {
                Card(
                    modifier = Modifier.fillMaxWidth(0.9f),
                    colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)),
                    shape = RoundedCornerShape(24.dp)
                ) {
                    Column(Modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("⏰", fontSize = 64.sp)
                        Spacer(Modifier.height(16.dp))
                        Text("출입 목표 시간 도달!", fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = Color.White)
                        Text("설정하신 퇴실 시간이 되었습니다.\n캠퍼스 퇴실 처리를 완료하세요!", fontSize = 14.sp, color = Color.LightGray, textAlign = TextAlign.Center)
                        Spacer(Modifier.height(20.dp))
                        
                        val mRem = (4800 - monthlyRecognized).coerceAtLeast(0)
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0xFF0F172A)).padding(14.dp)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("📅 이번 달 출입 목표", color = Color.Gray, fontSize = 12.sp)
                                val p = ((monthlyRecognized/4800f)*100).coerceAtMost(100f)
                                Text(String.format("%.1f%%", p), color = Color(0xFF38BDF8), fontWeight = FontWeight.Bold, fontSize = 12.sp)
                            }
                            Spacer(Modifier.height(6.dp))
                            if (mRem == 0) {
                                Text("🎉 월 필수 80시간 달성 축하합니다!", color = Color(0xFF34D399), fontWeight = FontWeight.ExtraBold, fontSize = 13.sp)
                            } else {
                                Text("월 필수 80시간까지 남은 시간: ${formatMins(mRem)}", color = Color.White, fontSize = 13.sp)
                            }
                        }
                        Spacer(Modifier.height(12.dp))
                        
                        val dRem = (720 - dailyRecognized).coerceAtLeast(0)
                        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(Color(0xFF10B981).copy(alpha=0.15f)).border(1.dp, Color(0xFF10B981), RoundedCornerShape(12.dp)).padding(14.dp)) {
                            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                Text("☀️ 오늘 달성 시간", color = Color(0xFFA7F3D0), fontWeight = FontWeight.Bold, fontSize = 13.sp)
                                Text(formatMins(dailyRecognized), color = Color(0xFF34D399), fontWeight = FontWeight.ExtraBold, fontSize = 18.sp)
                            }
                            Spacer(Modifier.height(4.dp))
                            Text(if (dRem == 0) "👑 오늘 한도(12h) 달성 축하합니다!" else "남은 시간: ${formatMins(dRem)}", color = Color.White, fontSize = 11.sp, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Right)
                        }
                        Spacer(Modifier.height(24.dp))
                        
                        Button(
                            onClick = onDismissOverlay,
                            modifier = Modifier.fillMaxWidth().height(52.dp),
                            colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFEF4444)),
                            shape = RoundedCornerShape(14.dp)
                        ) {
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
