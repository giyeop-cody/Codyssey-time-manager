package kr.codyssey.attendance.util;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 입·퇴실 처리 감지 (G1) — 앱이 닫혀 있어도 SyncWorker 주기 작업에서 실행.
 *
 * web/js/shared-attendance.js의 detectGateEvents/snapshotSessionsByDate/
 * formatGateEventMessage/gateEventKey 와 동일 규칙을 미러링한다.
 * 스냅샷은 Capacitor Preferences와 같은 저장소(codyssey_prefs)의
 * "gate_snapshot_{memberId}" 키를 JS adapter와 공유 → 어느 쪽이 먼저 감지하든
 * 같은 이벤트가 두 번 울리지 않는다.
 */
public class GateCheck {

    private static final String API_BASE = "https://api.usr.codyssey.kr";
    private static final String PREFS_NAME = "codyssey_prefs";
    private static final String GATE_SNAP_PREFIX = "gate_snapshot_";

    // shared-attendance.js의 GATE_EVENT_MAX_AGE_MS / GATE_EVENT_MAX_PER_PASS 와 동일 값
    private static final long GATE_EVENT_MAX_AGE_MS = 4L * 60 * 60 * 1000;
    private static final int GATE_EVENT_MAX_PER_PASS = 3;

    public static void run(Context context) {
        try {
            runInternal(context);
        } catch (Exception e) {
            // 감지 실패는 치명적이지 않음 — 다음 주기에 재시도
        }
    }

    private static void runInternal(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        String memberId = unquoteJson(prefs.getString("member_id", null));
        if (memberId == null || memberId.isEmpty()) {
            // member_id 소실 = JS측 로그아웃 또는 인증 오류 폐기 — 전이 1걸만 기록
            DiagLog.addOnChange(context, "GATE", "nomember", "member_id 없음 — 로그아웃/미로그인 상태라 입·퇴실 감지 스킵");
            return;
        }
        DiagLog.addOnChange(context, "GATE", "member", "member_id 확인 — 입·퇴실 감지 정상 가동");

        boolean gateEnabled = true;
        boolean notifEnabled = true;
        try {
            JSONObject settings = new JSONObject(prefs.getString("settings", "{}"));
            gateEnabled = settings.optBoolean("gateNotifyEnabled", true);
            notifEnabled = settings.optBoolean("notificationsEnabled", true);
        } catch (Exception e) { /* 기본값 유지 */ }
        if (!gateEnabled) return; // 감지 비활성 — API 조회 자체를 하지 않음 (배터리/트래픽 절약)

        Calendar cal = Calendar.getInstance();
        String todayStr = formatDate(cal.getTime());
        Calendar ycal = (Calendar) cal.clone();
        ycal.add(Calendar.DAY_OF_MONTH, -1);
        String yesterdayStr = formatDate(ycal.getTime());

        // 이번 달 조회 (월 1일이면 어제가 전월이므로 전월도 1회 추가 조회)
        JSONObject monthData = fetchMonth(context, memberId, cal.get(Calendar.YEAR), cal.get(Calendar.MONTH) + 1);
        if (monthData == null) return; // 네트워크/세션 오류 — 다음 주기로
        JSONObject prevMonthData = null;
        if (cal.get(Calendar.DAY_OF_MONTH) == 1) {
            Calendar pcal = (Calendar) cal.clone();
            pcal.add(Calendar.MONTH, -1);
            prevMonthData = fetchMonth(context, memberId, pcal.get(Calendar.YEAR), pcal.get(Calendar.MONTH) + 1);
        }

        // 새 스냅샷 구성 (오늘/어제만)
        JSONObject nextDates = new JSONObject();
        nextDates.put(todayStr, sessionsOf(monthData, todayStr));
        JSONArray yesterdaySessions = sessionsOf(monthData, yesterdayStr);
        if (yesterdaySessions.length() == 0 && prevMonthData != null) {
            yesterdaySessions = sessionsOf(prevMonthData, yesterdayStr);
        }
        nextDates.put(yesterdayStr, yesterdaySessions);

        // 이전 스냅샷 로드
        JSONObject prevDates = null;
        String snapRaw = prefs.getString(GATE_SNAP_PREFIX + memberId, null);
        if (snapRaw != null) {
            try {
                JSONObject snap = new JSONObject(snapRaw);
                if (snap.has("dates")) prevDates = snap.getJSONObject("dates");
            } catch (Exception e) { /* 베이스라인으로 */ }
        }

        // 최초 스냅샷은 조용히 채택 (과거 데이터로 알림 폭주 방지) — JS와 동일 정책
        if (prevDates != null && gateEnabled && notifEnabled) {
            List<long[]> holder = new ArrayList<>(); // 정렬용 (atMs, index)
            List<String[]> events = new ArrayList<>(); // [type, dateStr, entry, exit]
            collectEvents(prevDates, nextDates, todayStr, yesterdayStr, events, holder);

            long now = System.currentTimeMillis();
            // 시간순 정렬 후 최신 MAX_PER_PASS건
            List<Integer> order = new ArrayList<>();
            for (int i = 0; i < events.size(); i++) order.add(i);
            java.util.Collections.sort(order, (a, b) -> Long.compare(holder.get(a)[0], holder.get(b)[0]));

            int shown = 0;
            for (int i = order.size() - 1; i >= 0 && shown < GATE_EVENT_MAX_PER_PASS; i--) {
                String[] ev = events.get(order.get(i));
                long atMs = holder.get(order.get(i))[0];
                if (atMs <= 0 || now - atMs > GATE_EVENT_MAX_AGE_MS) continue;

                String title;
                String body;
                String dateLabel = ev[1].equals(todayStr)
                        ? ""
                        : "[" + Integer.parseInt(ev[1].substring(5, 7)) + "월 "
                          + Integer.parseInt(ev[1].substring(8, 10)) + "일] ";
                if ("entry".equals(ev[0])) {
                    title = "✅ 코디세이 입실 처리";
                    body = dateLabel + "입실 처리됨: " + ev[2];
                } else {
                    title = "🏁 코디세이 퇴실 처리";
                    body = dateLabel + "퇴실 처리됨: " + ev[3]
                            + (ev[2] != null ? " (입실 " + ev[2] + ")" : "");
                }
                String key = "gate_" + ev[1] + "_" + ev[0] + "_" + ("exit".equals(ev[0]) ? ev[3] : ev[2]);
                NotificationHelper.showNotification(context, title, body, key);
                shown++;
            }
        }

        // 스냅샷 저장 (알림이 꺼져 있어도 갱신 — 재활성 시 누적 폭주 방지)
        JSONObject snap = new JSONObject();
        snap.put("dates", nextDates);
        snap.put("updatedAt", System.currentTimeMillis());
        prefs.edit().putString(GATE_SNAP_PREFIX + memberId, snap.toString()).apply();

        // 29차: 자정 롤오버 확인 — 전날 입실 후 미퇴실이면 밤샘/누락 확인 알림 (당일 1회)
        checkOvernightRollover(context, prefs, monthData, prevMonthData, todayStr, yesterdayStr);
    }

    // 29차: 전날 시작 미퇴실 세션 감지 → 확인 요청 알림.
    // JS측 표시 정책(임시 집계 제외/밤샘/누락)과 같은 판단 대상을, 앱이 닫혀 있을 때도 묻기 위한 알림.
    private static void checkOvernightRollover(Context context, SharedPreferences prefs,
                                               JSONObject monthData, JSONObject prevMonthData,
                                               String todayStr, String yesterdayStr) {
        try {
            if (todayStr.equals(prefs.getString("overnight_notified", ""))) return; // 당일 1회

            JSONArray y = sessionsOf(monthData, yesterdayStr);
            if (y.length() == 0 && prevMonthData != null) {
                y = sessionsOf(prevMonthData, yesterdayStr); // 월 1일 롤오버
            }
            String openEntry = null;
            for (int i = 0; i < y.length(); i++) {
                JSONArray pair = y.optJSONArray(i);
                if (pair == null || pair.length() < 2 || !pair.isNull(1)) continue;
                openEntry = pair.optString(0, null); // 입실 시각순 — 마지막이 최신
            }
            if (openEntry == null) return;

            // S1과 같은 기준: 입실부터 13시간 넘은 낡은 세션은 확인 대상 아님
            long entryTs = eventTimestamp(yesterdayStr, openEntry, null);
            if (entryTs <= 0 || System.currentTimeMillis() - entryTs > 13L * 60 * 60 * 1000) return;

            // 사용자가 이미 선택한 건(entryDate 일치)이면 다시 묻지 않음
            String decRaw = prefs.getString("overnight_decision", null);
            if (decRaw != null) {
                try {
                    JSONObject dec = new JSONObject(unquoteJson(decRaw));
                    if (yesterdayStr.equals(dec.optString("entryDate", ""))) return;
                } catch (Exception ignore) { /* 파싱 실패 시 알림 진행 */ }
            }

            NotificationHelper.showNotification(context,
                    "⏰ 퇴실 기록 확인 — 자정을 넘겼습니다",
                    "전날 " + openEntry + " 입실 기록이 아직 열려 있습니다. 밤샘 근무인가요, 퇴실 누락인가요? "
                            + "앱을 열어 선택해 주세요. (확인 전까지 오늘 집계에서 제외)",
                    "overnight_check");
            prefs.edit().putString("overnight_notified", todayStr).apply();
            DiagLog.add(context, "GATE",
                    "자정 롤오버 확인 알림 — 전날 " + openEntry + " 입실 세션 미퇴실 (임시 처리 안내)");
        } catch (Exception e) { /* 확인 알림 실패는 다음 주기로 */ }
    }

    // diff: events에 [type, dateStr, entry, exit]를, holder에 [atMs]를 병렬 수집
    private static void collectEvents(JSONObject prevDates, JSONObject nextDates,
                                      String todayStr, String yesterdayStr,
                                      List<String[]> events, List<long[]> holder) throws Exception {
        String[] dates = { todayStr, yesterdayStr };
        for (String dateStr : dates) {
            JSONArray sessions = nextDates.optJSONArray(dateStr);
            if (sessions == null) continue;

            JSONArray prevSessions = prevDates.optJSONArray(dateStr);
            Map<String, String> prevExitByEntry = new HashMap<>();
            if (prevSessions != null) {
                for (int i = 0; i < prevSessions.length(); i++) {
                    JSONArray pair = prevSessions.optJSONArray(i);
                    if (pair == null || pair.length() < 1) continue;
                    String entry = pair.optString(0, null);
                    String exit = pair.length() > 1 && !pair.isNull(1) ? pair.optString(1, null) : null;
                    if (entry != null) prevExitByEntry.put(entry, exit);
                }
            }

            for (int i = 0; i < sessions.length(); i++) {
                JSONArray pair = sessions.optJSONArray(i);
                if (pair == null || pair.length() < 1) continue;
                String entry = pair.optString(0, null);
                String exit = pair.length() > 1 && !pair.isNull(1) ? pair.optString(1, null) : null;
                if (entry == null) continue;

                if (prevExitByEntry.containsKey(entry)) {
                    String prevExit = prevExitByEntry.get(entry);
                    if (prevExit == null && exit != null) {
                        events.add(new String[] { "exit", dateStr, entry, exit });
                        holder.add(new long[] { eventTimestamp(dateStr, exit, entry) });
                    }
                } else {
                    events.add(new String[] { "entry", dateStr, entry, exit });
                    holder.add(new long[] { eventTimestamp(dateStr, entry, null) });
                }
            }
        }
    }

    // 이벤트 시각(ms). 퇴실 시각이 입실 시각보다 작으면 익일로 간주 (야간 세션) — JS gateEventTimestamp와 동일
    private static long eventTimestamp(String dateStr, String timeStr, String entryStr) {
        try {
            String[] d = dateStr.split("-");
            String[] t = timeStr.split(":");
            Calendar cal = Calendar.getInstance();
            cal.set(Integer.parseInt(d[0]), Integer.parseInt(d[1]) - 1, Integer.parseInt(d[2]),
                    Integer.parseInt(t[0]), Integer.parseInt(t[1]), 0);
            cal.set(Calendar.MILLISECOND, 0);
            long ts = cal.getTimeInMillis();
            if (entryStr != null) {
                String[] e = entryStr.split(":");
                int exitMin = Integer.parseInt(t[0]) * 60 + Integer.parseInt(t[1]);
                int entryMin = Integer.parseInt(e[0]) * 60 + Integer.parseInt(e[1]);
                if (exitMin < entryMin) ts += 24L * 60 * 60 * 1000;
            }
            return ts;
        } catch (Exception e) {
            return -1;
        }
    }

    // 해당 날짜의 세션 목록을 [[entry, exit|null], ...] (입실 시각순)로 추출 — JS snapshotSessionsByDate와 동일
    private static JSONArray sessionsOf(JSONObject monthData, String dateStr) throws Exception {
        JSONArray out = new JSONArray();
        if (monthData == null) return out;
        JSONArray detailList = monthData.optJSONArray("detail_list");
        if (detailList == null) detailList = monthData.optJSONArray("result");
        if (detailList == null) detailList = monthData.optJSONArray("data");
        if (detailList == null) return out;

        for (int i = 0; i < detailList.length(); i++) {
            JSONObject day = detailList.optJSONObject(i);
            if (day == null) continue;
            if (!dateStr.equals(day.optString("date", ""))) continue;

            JSONArray sessions = day.optJSONArray("sessions");
            if (sessions == null) continue;
            for (int j = 0; j < sessions.length(); j++) {
                JSONObject s = sessions.optJSONObject(j);
                if (s == null) continue;
                String entry = normalizeHHMM(s.optString("entry_time", null));
                if (entry == null) continue; // 입실 누락 세션은 식별 불가 — JS와 동일하게 제외
                String exit = normalizeHHMM(s.optString("exit_time", null));
                JSONArray pair = new JSONArray();
                pair.put(entry);
                pair.put(exit != null ? exit : JSONObject.NULL);
                out.put(pair);
            }
        }

        // 입실 시각순 정렬 (JSONArray는 직접 정렬 불가라 List 경유)
        List<JSONArray> list = new ArrayList<>();
        for (int i = 0; i < out.length(); i++) list.add(out.getJSONArray(i));
        java.util.Collections.sort(list, (a, b) -> a.optString(0, "").compareTo(b.optString(0, "")));
        JSONArray sorted = new JSONArray();
        for (JSONArray pair : list) sorted.put(pair);
        return sorted;
    }

    // 'HH:MM(:SS)' → 'HH:MM' 정규화 — JS normalizeHHMM과 동일
    private static String normalizeHHMM(String timeStr) {
        if (timeStr == null) return null;
        timeStr = timeStr.trim();
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(\\d{1,2}):(\\d{2})").matcher(timeStr);
        if (!m.find()) return null;
        int h = Integer.parseInt(m.group(1));
        int mm = Integer.parseInt(m.group(2));
        if (h > 30 || mm > 59) return null;
        return String.format(Locale.US, "%02d:%02d", h, mm);
    }

    private static JSONObject fetchMonth(Context context, String memberId, int year, int month) {
        String url = API_BASE + "/rest/secom/detail?mbrId=" + memberId
                + "&year=" + year + "&month=" + String.format(Locale.US, "%02d", month);
        CookieManager.HttpResult res = CookieManager.httpGet(context, url);
        if (res.status != 200) { // 302/401=세션 만료, 그 외는 다음 주기로
            DiagLog.addOnChange(context, "GATE", "api_" + res.status,
                    "출입 조회 HTTP " + res.status + authHint(res.status));
            return null;
        }
        DiagLog.addOnChange(context, "GATE", "ok", "출입 조회 정상 (HTTP 200)");
        try {
            return new JSONObject(res.body);
        } catch (Exception e) {
            return null;
        }
    }

    // 19차: HTTP 상태 → 사용자 판독 힌트 (로그인 폼 회귀 원인 분류)
    private static String authHint(int s) {
        if (s >= 300 && s < 400) return " — 서버가 로그인 페이지로 리다이렉트 (세션 만료 또는 중복 로그인 종료 신호)";
        if (s == 401) return " — 인증 거부 (세션 무효)";
        if (s == 403) return " — 접근 거부 (일시 차단/정책 가능)";
        if (s == -1) return " — 네트워크 오류 (기기 연결 확인)";
        return "";
    }

    private static String formatDate(Date date) {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(date);
    }

    // Capacitor Preferences는 JSON.stringify로 저장 → 문자열 값은 따옴표로 감싸여 있음
    private static String unquoteJson(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }
}
