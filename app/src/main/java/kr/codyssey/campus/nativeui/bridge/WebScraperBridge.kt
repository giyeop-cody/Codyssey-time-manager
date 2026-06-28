package kr.codyssey.campus.nativeui.bridge

import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import kr.codyssey.campus.nativeui.model.*
import org.json.JSONObject

class WebScraperBridge(private val onDataScraped: (AccessDataState) -> Unit) {

    @JavascriptInterface
    fun onDomScraped(jsonStr: String) {
        try {
            val j = JSONObject(jsonStr)
            val mRec = j.optInt("mRec", 3764)
            val dRec = j.optInt("dRec", 166)
            val entryStr = j.optString("entryStr", "12:56:44")
            val isInside = j.optBoolean("isInside", true)

            val mapObj = j.optJSONObject("dayRecords")
            val dayMap = mutableMapOf<Int, DaySummary>()
            if (mapObj != null) {
                mapObj.keys().forEach { k ->
                    val dayNum = k.toIntOrNull()
                    if (dayNum != null) {
                        val dObj = mapObj.optJSONObject(k)
                        if (dObj != null) {
                            val tot = dObj.optInt("tot", 0)
                            val sArr = dObj.optJSONArray("sess")
                            val sList = mutableListOf<SessionItem>()
                            if (sArr != null) {
                                for(i in 0 until sArr.length()) {
                                    val so = sArr.optJSONObject(i)
                                    if(so != null) sList.add(SessionItem(so.optString("en",""), so.optString("ex","-"), so.optString("du","")))
                                }
                            }
                            dayMap[dayNum] = DaySummary(dayNum, tot, sList)
                        }
                    }
                }
            }

            val state = AccessDataState(mRec, dRec, entryStr, isInside, true, dayMap)
            Handler(Looper.getMainLooper()).post { onDataScraped(state) }
        } catch (e: Exception) { e.printStackTrace() }
    }
}
