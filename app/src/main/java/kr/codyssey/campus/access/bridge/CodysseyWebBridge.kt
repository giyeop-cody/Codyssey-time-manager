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
    val currentUrl: String = "",
    val isSuccessfullyScraped: Boolean = false
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

            val hasRealData = (mRec > 0 || dRec > 0 || (entryStr != "-" && entryStr != ""))

            val payload = ScrapedAccessPayload(
                monthlyRecognizedMinutes = mRec,
                dailyCompletedMinutes = dRec,
                lastEntryTimeStr = entryStr,
                isCurrentlyInside = isInside,
                currentUrl = url,
                isSuccessfullyScraped = hasRealData
            )

            Handler(Looper.getMainLooper()).post {
                onDataScraped(payload)
            }
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }
}
