package kr.codyssey.campus.nativeui.ui

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
import kr.codyssey.campus.nativeui.model.*
import java.text.SimpleDateFormat
import java.util.*

@Composable
fun NativeDashboardScreen(
    dataState: AccessDataState,
    onSelectDayOnWeb: (Int) -> Unit,
    onScheduleAlarm: (Int) -> Unit,
    onCancelAlarm: () -> Unit,
    activeAlarmMs: Long?,
    alarmCountdownStr: String,
    isOverlayShown: Boolean,
    onDismissOverlay: () -> Unit
) {
    var selectedDay by remember { mutableStateOf(27) }
    var calcMode by remember { mutableStateOf("ADD") } // 'ADD' vs 'GOAL'
    var inputHours by remember { mutableStateOf(4) }
    var inputMins by remember { mutableStateOf(0) }

    val curDaySum = dataState.dayRecords[selectedDay]

    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
        LazyColumn(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item {
                Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("⛵", fontSize = 28.sp)
                        Spacer(Modifier.width(10.dp))
                        Column {
                            Text("Codyssey 출입관리 매니저", fontSize = 18.sp, fontWeight = FontWeight.Bold, color = Color.White)
                            Text("🟢 라이브 웹뷰 세션 다크 렌더링 중", fontSize = 11.sp, color = MaterialTheme.colorScheme.tertiary, fontWeight = FontWeight.Bold)
                        }
                    }
                    Badge(containerColor = if(dataState.isInside) Color(0xFF10B981) else Color(0xFFF59E0B)) {
                        Text(if(dataState.isInside) "입실 중 🟢" else "퇴실 완료 ⚪", color = Color.White, modifier = Modifier.padding(4.dp))
                    }
                }
            }

            // Monthly Card
            item {
                Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.padding(18.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("📅 이번 달 출입 목표 (필수 80시간)", fontWeight = FontWeight.Bold, fontSize = 14.sp, color = Color.White)
                            val p = ((dataState.monthlyRecognizedMins / 4800f) * 100).coerceAtMost(100f)
                            Text(String.format("%.1f%%", p), color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.ExtraBold)
                        }
                        Spacer(Modifier.height(10.dp))
                        LinearProgressIndicator(progress = (dataState.monthlyRecognizedMins / 4800f).coerceIn(0f, 1f), modifier = Modifier.fillMaxWidth().height(10.dp).clip(CircleShape), color = MaterialTheme.colorScheme.primary, trackColor = MaterialTheme.colorScheme.background)
                        Spacer(Modifier.height(10.dp))
                        val mRem = (4800 - dataState.monthlyRecognizedMins).coerceAtLeast(0)
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("반영: ${formatMins(dataState.monthlyRecognizedMins)}", fontSize = 13.sp, color = Color.LightGray)
                            Text(if(mRem == 0) "🎉 월 필수 달성!" else "남은 시간: ${formatMins(mRem)}", fontSize = 13.sp, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                        }
                    }
                }
            }

            // Daily Card
            item {
                Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.padding(18.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("☀️ 오늘 인정 가능 남은 시간", fontWeight = FontWeight.Bold, fontSize = 14.sp, color = Color.White)
                            val dRem = (720 - dataState.dailyTodayMins).coerceAtLeast(0)
                            Text(if(dRem == 0) "⚠️ 한도 도달" else formatMins(dRem), color = MaterialTheme.colorScheme.tertiary, fontWeight = FontWeight.ExtraBold, fontSize = 16.sp)
                        }
                        Spacer(Modifier.height(10.dp))
                        LinearProgressIndicator(progress = (dataState.dailyTodayMins / 720f).coerceIn(0f, 1f), modifier = Modifier.fillMaxWidth().height(10.dp).clip(CircleShape), color = MaterialTheme.colorScheme.tertiary, trackColor = MaterialTheme.colorScheme.background)
                        Spacer(Modifier.height(8.dp))
                        Text("오늘 총 인정: ${formatMins(dataState.dailyTodayMins)} / 최대 12시간", fontSize = 12.sp, color = Color.Gray)
                    }
                }
            }

            // Calendar Grid Card
            item {
                Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.padding(16.dp)) {
                        Text("2026. 06", fontSize = 18.sp, fontWeight = FontWeight.ExtraBold, color = Color.White, modifier = Modifier.fillMaxWidth(), textAlign = TextAlign.Center)
                        Spacer(Modifier.height(14.dp))
                        Row(Modifier.fillMaxWidth()) {
                            listOf("일", "월", "화", "수", "목", "금", "토").forEachIndexed { idx, title ->
                                Text(title, modifier = Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 13.sp, fontWeight = FontWeight.Bold, color = if(idx == 0) Color(0xFFEF4444) else if(idx == 6) MaterialTheme.colorScheme.primary else Color.Gray)
                            }
                        }
                        Spacer(Modifier.height(8.dp))
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            val cells = listOf(0, 1, 2, 3, 4, 5, 6) + (7..30).toList() + listOf(0, 0, 0, 0)
                            cells.chunked(7).forEach { week ->
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    week.forEach { d ->
                                        if(d == 0) Box(Modifier.weight(1f).height(46.dp))
                                        else {
                                            val isSel = (d == selectedDay)
                                            val hasRec = dataState.dayRecords.containsKey(d) || (d == 27 && dataState.dailyTodayMins > 0)
                                            Box(
                                                modifier = Modifier.weight(1f).height(46.dp).clip(RoundedCornerShape(10.dp))
                                                    .background(if(isSel) MaterialTheme.colorScheme.primary else if(hasRec) MaterialTheme.colorScheme.primary.copy(alpha=0.15f) else MaterialTheme.colorScheme.background)
                                                    .border(1.dp, if(isSel) Color.White else if(hasRec) MaterialTheme.colorScheme.primary else Color.Transparent, RoundedCornerShape(10.dp))
                                                    .clickable { selectedDay = d; onSelectDayOnWeb(d) },
                                                contentAlignment = Alignment.Center
                                            ) {
                                                Text(d.toString(), fontSize = 14.sp, fontWeight = if(isSel||hasRec) FontWeight.ExtraBold else FontWeight.Normal, color = if(isSel) Color.White else if(hasRec) MaterialTheme.colorScheme.primary else Color.LightGray)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Record Table
            item {
                Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.padding(16.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                            Text("6월 ${selectedDay}일 기록", fontWeight = FontWeight.Bold, fontSize = 16.sp, color = Color.White)
                            val dt = if(selectedDay==27) dataState.dailyTodayMins else (curDaySum?.recognizedMins ?: 0)
                            Text(formatMins(dt), fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.tertiary)
                        }
                        Spacer(Modifier.height(12.dp))
                        Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.background).padding(8.dp)) {
                            Text("입실", Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 12.sp, color = Color.Gray)
                            Text("퇴실", Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 12.sp, color = Color.Gray)
                            Text("체류시간", Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 12.sp, color = Color.Gray)
                        }
                        val list = if(selectedDay==27) listOf(SessionItem("09:42:32","12:29:03","02:46:31"), SessionItem(dataState.lastEntryTimeStr, if(dataState.isInside)"-" else "18:00:00", if(dataState.isInside)"진행중" else "05:03:16")) else (curDaySum?.sessions ?: emptyList())
                        if (list.isEmpty()) {
                            Text("출입 기록이 없습니다.", Modifier.fillMaxWidth().padding(20.dp), textAlign = TextAlign.Center, color = Color.Gray)
                        } else {
                            list.forEach { s ->
                                Row(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
                                    Text(s.entry, Modifier.weight(1f), textAlign = TextAlign.Center, fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = Color.White)
                                    Text(s.exit, Modifier.weight(1f), textAlign = TextAlign.Center, fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = if(s.exit=="-") Color(0xFFF59E0B) else Color.White)
                                    Text(s.dur, Modifier.weight(1f), textAlign = TextAlign.Center, fontSize = 13.sp, color = if(s.dur=="진행중") Color(0xFF34D399) else Color.White)
                                }
                            }
                        }
                    }
                }
            }

            // Alarm Setup Card
            item {
                Card(Modifier.fillMaxWidth(), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface), shape = RoundedCornerShape(16.dp)) {
                    Column(Modifier.padding(18.dp)) {
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                            Text("⏰ 스마트 다크 알람 컨트롤러", fontSize = 16.sp, fontWeight = FontWeight.Bold, color = Color.White)
                        }
                        Spacer(Modifier.height(12.dp))

                        if (!dataState.isInside && activeAlarmMs == null) {
                            Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Color(0xFFFEF2F2)).border(1.dp, Color(0xFFFECACA), RoundedCornerShape(10.dp)).padding(14.dp), contentAlignment = Alignment.Center) {
                                Text("⚠️ 현재 퇴실 완료 상태입니다.\n입실 처리 후 알람 설정이 가능합니다.", color = Color(0xFFDC2626), fontSize = 12.sp, textAlign = TextAlign.Center)
                            }
                        } else if (activeAlarmMs != null) {
                            Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.primary.copy(alpha=0.15f)).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                                Text("⏰ 네이티브 다크 테마 퇴실 알람 예약 완료!", fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary)
                                Text(alarmCountdownStr, fontSize = 28.sp, fontWeight = FontWeight.ExtraBold, color = MaterialTheme.colorScheme.primary)
                                Spacer(Modifier.height(10.dp))
                                Button(onClick = onCancelAlarm, colors = ButtonDefaults.buttonColors(containerColor = Color(0xFFEF4444)), modifier = Modifier.fillMaxWidth()) {
                                    Text("알람 해제하기", fontWeight = FontWeight.Bold)
                                }
                            }
                        } else {
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
                                            val rem = (720 - dataState.dailyTodayMins).coerceAtLeast(0)
                                            inputHours = rem / 60; inputMins = rem % 60
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

                            Spacer(Modifier.height(14.dp))
                            val durMins = if(calcMode=="ADD") inputHours*60+inputMins else (inputHours*60+inputMins - dataState.dailyTodayMins).coerceAtLeast(1)
                            Button(onClick = { onScheduleAlarm(durMins) }, modifier = Modifier.fillMaxWidth().height(48.dp), shape = RoundedCornerShape(12.dp)) {
                                Text("⏰ 스마트 네이티브 알람 맞추기", fontWeight = FontWeight.Bold, fontSize = 15.sp)
                            }
                        }
                    }
                }
            }
            item { Spacer(Modifier.height(30.dp)) }
        }

        // Overlay
        if (isOverlayShown) {
            Box(Modifier.fillMaxSize().background(Color(0xEE0F172A)).clickable { }, contentAlignment = Alignment.Center) {
                Card(Modifier.fillMaxWidth(0.9f), colors = CardDefaults.cardColors(containerColor = Color(0xFF1E293B)), shape = RoundedCornerShape(24.dp)) {
                    Column(Modifier.padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text("⏰", fontSize = 64.sp)
                        Spacer(Modifier.height(16.dp))
                        Text("출입 목표 시간 도달!", fontSize = 24.sp, fontWeight = FontWeight.ExtraBold, color = Color.White)
                        Text("설정하신 다크 테마 퇴실 알람 시간입니다.\n체크아웃을 완료하세요!", fontSize = 14.sp, color = Color.LightGray, textAlign = TextAlign.Center)
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
