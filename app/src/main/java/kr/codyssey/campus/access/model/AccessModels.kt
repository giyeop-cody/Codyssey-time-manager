package kr.codyssey.campus.access.model

data class SessionRecord(
    val entryTime: String,
    val exitTime: String,
    val durationStr: String
)

data class AlarmConfig(
    val active: Boolean,
    val targetTimestampMs: Long,
    val targetDurationMinutes: Int,
    val baseEntryTimeStr: String
)

fun formatMins(mins: Int): String {
    if (mins <= 0) return "0분"
    val h = mins / 60
    val m = mins % 60
    return if (h == 0) "${m}분" else "${h}시간 ${m}분"
}
