package kr.codyssey.campus.access.bridge

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import kr.codyssey.campus.access.model.SessionRecord
import org.json.JSONObject

data class ScrapedAccessPayload(
    val monthlyRecognizedMinutes: Int,
    val dailyCompletedMinutes: Int,
    val lastEntryTimeStr: String,
    val isCurrentlyInside: Boolean,
    val currentUrl: String = "",
    val isSuccessfullyScraped: Boolean = false,
    val dayTotalsMap: Map<Int, Int> = emptyMap(),
    val tableSessions: List<SessionRecord> = emptyList()
)

class CodysseyWebBridge(private val onDataScraped: (ScrapedAccessPayload) -> Unit) {

    @JavascriptInterface
    fun onLiveDomScraped(jsonStr: String) {
        try {
            val json = JSONObject(jsonStr)
            val url = json.optString("url", "")
            val mRec = json.optInt("mRec", 0)
            val dRec = json.optInt("dRec", 0)
            val entryStr = json.optString("entryStr", "-")
            val isInside = json.optBoolean("isInside", false)

            val mapObj = json.optJSONObject("dayTotalsMap")
            val dayMap = mutableMapOf<Int, Int>()
            if (mapObj != null) {
                mapObj.keys().forEach { k ->
                    val dayNum = k.toIntOrNull()
                    if (dayNum != null) {
                        dayMap[dayNum] = mapObj.optInt(k, 0)
                    }
                }
            }

            val sessArr = json.optJSONArray("tableSessions")
            val sessions = mutableListOf<SessionRecord>()
            if (sessArr != null) {
                for (i in 0 until sessArr.length()) {
                    val item = sessArr.optJSONObject(i)
                    if (item != null) {
                        sessions.add(
                            SessionRecord(
                                entryTime = item.optString("entry", ""),
                                exitTime = item.optString("exit", "-"),
                                durationStr = item.optString("dur", "")
                            )
                        )
                    }
                }
            }

            val hasRealData = (mRec > 0 || dRec > 0 || sessions.isNotEmpty() || dayMap.isNotEmpty())

            val payload = ScrapedAccessPayload(
                monthlyRecognizedMinutes = mRec,
                dailyCompletedMinutes = dRec,
                lastEntryTimeStr = entryStr,
                isCurrentlyInside = isInside,
                currentUrl = url,
                isSuccessfullyScraped = hasRealData,
                dayTotalsMap = dayMap,
                tableSessions = sessions
            )

            Handler(Looper.getMainLooper()).post {
                onDataScraped(payload)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
