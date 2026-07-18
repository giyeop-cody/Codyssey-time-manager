package kr.codyssey.attendance.util;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 세션/감지 진단 로그 (19차) — 네이티브와 JS가 같은 링버퍼(codyssey_prefs/diag_log)를 공유.
 * "갑자기 로그인 폼으로 돌아감"의 원인을 사용자가 직접 판독할 수 있게
 * 시각·태그·메시지를 최근순으로 남긴다 (최대 80건, 오래된 것부터 제거).
 */
public class DiagLog {

    private static final String PREFS_NAME = "codyssey_prefs";
    private static final String KEY = "diag_log";
    private static final int MAX_ENTRIES = 80;

    /** 무조건 1건 추가 (실패핸들 무시 — 진단 로그가 앱을 죽이면 안 됨) */
    public static void add(Context ctx, String tag, String msg) {
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray arr = new JSONArray(prefs.getString(KEY, "[]"));
            JSONObject e = new JSONObject();
            e.put("t", System.currentTimeMillis());
            e.put("tag", tag);
            e.put("msg", msg);
            arr.put(e);
            while (arr.length() > MAX_ENTRIES) arr.remove(0);
            prefs.edit().putString(KEY, arr.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    /**
     * 상태 전이 시에만 기록 — 같은 상태가 연속될 때 1분 주기 스팸을 막음.
     * state가 이전과 다륩면 기록하고 저장. (예: GATE 200→302는 기록, 302 연속은 1걸만)
     */
    public static void addOnChange(Context ctx, String tag, String state, String msg) {
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            String sk = "diag_state_" + tag;
            String prev = prefs.getString(sk, null);
            if (state.equals(prev)) return;
            prefs.edit().putString(sk, state).apply();
            add(ctx, tag, msg);
        } catch (Exception ignored) {
        }
    }
}
