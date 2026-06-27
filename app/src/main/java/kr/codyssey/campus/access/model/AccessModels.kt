package kr.codyssey.campus.access.model

data class SessionRecord(
    val entryTime: String, // e.g. "09:42:32"
    val exitTime: String,  // e.g. "12:29:03" or "-"
    val durationStr: String // e.g. "02:46:31" or "진행중"
)

data class DayAccessRecord(
    val day: Int,
    val totalRecognizedMinutes: Int,
    val hasDetail: Boolean,
    val sessions: List<SessionRecord> = emptyList()
)

data class AlarmConfig(
    val active: Boolean,
    val targetTimestampMs: Long,
    val targetDurationMinutes: Int,
    val baseEntryTimeStr: String
)
