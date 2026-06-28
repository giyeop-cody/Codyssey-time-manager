package kr.codyssey.campus.nativeui.model

data class SessionItem(val entry: String, val exit: String, val dur: String)

data class DaySummary(val day: Int, val recognizedMins: Int, val sessions: List<SessionItem>)

data class AccessDataState(
    val monthlyRecognizedMins: Int = 3764,
    val dailyTodayMins: Int = 166,
    val lastEntryTimeStr: String = "12:56:44",
    val isInside: Boolean = true,
    val isScraped: Boolean = false,
    val dayRecords: Map<Int, DaySummary> = emptyMap()
)

fun formatMins(mins: Int): String {
    if (mins <= 0) return "0분"
    val h = mins / 60
    val m = mins % 60
    return if (h == 0) "${m}분" else "${h}시간 ${m}분"
}
