package kr.codyssey.campus.access.bridge

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import org.json.JSONObject

data class ScrapedAccessPayload(
    val monthlyRecognizedMinutes: Int,
    val dailyCompletedMinutes: Int,
    val lastEntryTimeStr: String,
    val isCurrentlyInside: Boolean,
    val timestamp: Long = System.currentTimeMillis()
)

class CodysseyWebBridge(private val onDataScraped: (ScrapedAccessPayload) -> Unit) {

    @JavascriptInterface
    fun onLiveDomScraped(jsonStr: String) {
        try {
            val json = JSONObject(jsonStr)
            val mRec = json.optInt("mRec", 3764) // Default 62h 44m
            val dRec = json.optInt("dRec", 166)  // Default 2h 46m
            val entryStr = json.optString("entryStr", "12:56:44")
            val isInside = json.optBoolean("isInside", true)

            val payload = ScrapedAccessPayload(
                monthlyRecognizedMinutes = mRec,
                dailyCompletedMinutes = dRec,
                lastEntryTimeStr = entryStr,
                isCurrentlyInside = isInside
            )

            // Post to UI Thread
            Handler(Looper.getMainLooper()).post {
                onDataScraped(payload)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
