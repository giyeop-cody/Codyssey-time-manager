package kr.codyssey.attendance.util;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * 36차: 월 필수 출입 페이스/마감 경고 (N36-3) — SyncTasks 주기 작업에서 6시간 스로틀로 실행.
 *
 * web/js/shared-attendance.js의 monthlyDeadlineAlert + web/js/background.js의
 * checkMonthlyDeadline 과 동일 규칙을 미러링한다 (규칙 바꾸면 양쪽 다 수정):
 *
 *   rem    = max(0, 월 필수 시간*60 - 인정 누적)
 *   perDay = rem / 남은 일수(오늘 포함)
 *   L2     = perDay >= 720분 → 남은 기간 매일 상한(12시간)을 채워도 도달 불가
 *   L1     = 남은 일수 > 2 && rem / (남은 일수 - 2) >= 720분
 *            → 지금 페이스면 전전날(이틀 뒤)부터 하루 12시간이 필요해지는 시점
 *
 * 인정 누적 = Σ 서버 daily_total_duration(서버측 일일 12시간 상한 이미 적용됨)
 *            + 오늘 진행 중인 신선 개방 세션(≤13시간, 일일 상한 캡 적용).
 *
 * dedup: 하루 1회 — 같은 날 상위 레벨로만 재알림 (monthly_deadline_mark="yyyy-MM-dd:L#").
 */
public class MonthlyDeadlineCheck {

    private static final String PREFS_NAME = "codyssey_prefs";
    private static final long SIX_HOURS_MS = 6L * 60 * 60 * 1000;
    private static final int DAILY_CAP_MIN = 12 * 60;                    // SERVER_DAILY_CAP_MINUTES
    private static final long MAX_OPEN_SESSION_MS = 13L * 60 * 60 * 1000; // MAX_OPEN_SESSION_MS

    public static void run(Context context) {
        try {
            runInternal(context);
        } catch (Exception e) {
            // 실패는 치명적이지 않음 — 다음 주기에 재시도
        }
    }

    private static void runInternal(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        // 설정 확인 (기본값: 켬 — JS settings.deadlineAlertEnabled !== false 와 동일 의미)
        JSONObject settings = new JSONObject(prefs.getString("settings", "{}"));
        if (!settings.optBoolean("deadlineAlertEnabled", true)) return;
        if (!settings.optBoolean("notificationsEnabled", true)) return;
        double requiredHours = settings.optDouble("monthlyRequiredHours", 80); // 월 필수 시간

        // 6시간 스로틀 — GateCheck보다 드물게 (조회가 따로 필요해서)
        long now = System.currentTimeMillis();
        if (now - prefs.getLong("monthly_deadline_last_run", 0) < SIX_HOURS_MS) return;

        String memberId = unquoteJson(prefs.getString("member_id", null));
        if (memberId == null || memberId.isEmpty()) return;

        Calendar cal = Calendar.getInstance();
        JSONObject monthData = GateCheck.fetchMonth(context, memberId,
                cal.get(Calendar.YEAR), cal.get(Calendar.MONTH) + 1);
        if (monthData == null) return; // 네트워크/세션 오류 — 다음 주기로
        prefs.edit().putLong("monthly_deadline_last_run", now).apply();

        // 남은 일수 (오늘 포함)
        int daysInMonth = cal.getActualMaximum(Calendar.DAY_OF_MONTH);
        int daysLeft = daysInMonth - cal.get(Calendar.DAY_OF_MONTH) + 1;

        String todayStr = formatDate(cal.getTime());
        int recognized = recognizedMinutes(monthData, todayStr, now);

        int[] alert = evaluate(recognized, requiredHours, daysLeft);
        if (alert == null) return;
        int level = alert[0];
        int requiredPerDayMin = alert[1];

        // dedup: 같은 날 같은/낮은 레벨은 이미 알림
        String mark = prefs.getString("monthly_deadline_mark", "");
        String[] parts = mark.split(":");
        if (parts.length == 2 && parts[0].equals(todayStr)) {
            try {
                if (Integer.parseInt(parts[1]) >= level) return;
            } catch (NumberFormatException e) { /* 파싱 실패 시 알림 진행 */ }
        }

        String hoursTxt = (requiredPerDayMin / 60) + "시간 " + (requiredPerDayMin % 60) + "분";
        String title;
        String body;
        if (level == 2) {
            title = "🚨 월 출입 목표 마감 임박";
            body = "남은 " + daysLeft + "일 동안 하루 " + hoursTxt
                    + "씩 채워야 합니다 — 매일 12시간(상한)을 채워도 부족할 수 있어요.";
        } else {
            title = "⏳ 월 출입 페이스 경고";
            body = "지금 페이스면 2일 뒤부터 하루 12시간을 채워야 월 목표에 도달합니다 — 남은 "
                    + daysLeft + "일, 하루 " + hoursTxt + " 필요.";
        }

        NotificationHelper.showNotification(context, title, body, "monthly_deadline");
        prefs.edit().putString("monthly_deadline_mark", todayStr + ":L" + level).apply();
        DiagLog.addOnChange(context, "DEADLINE", "L" + level,
                title + " — 인정 " + (recognized / 60) + "시간 " + (recognized % 60) + "분, 남은 " + daysLeft + "일");
    }

    /**
     * 월 인정 누적(분) = Σ daily_total_duration + 오늘 진행 중 개방 세션(일일 상한 캡).
     * JS recognizedMonthly(parsed)와 동일 규칙.
     */
    private static int recognizedMinutes(JSONObject monthData, String todayStr, long nowMs) throws Exception {
        JSONArray detailList = monthData.optJSONArray("detail_list");
        if (detailList == null) detailList = monthData.optJSONArray("result");
        if (detailList == null) detailList = monthData.optJSONArray("data");
        if (detailList == null) return 0;

        int monthly = 0;
        int todayTotal = 0;
        int todayElapsed = 0;
        for (int i = 0; i < detailList.length(); i++) {
            JSONObject day = detailList.optJSONObject(i);
            if (day == null) continue;
            int dur = durationToMinutes(day.optString("daily_total_duration", ""));
            monthly += dur;
            if (!todayStr.equals(day.optString("date", ""))) continue;
            todayTotal = dur;
            long elapsedMs = openSessionElapsedMs(day.optJSONArray("sessions"), todayStr, nowMs);
            todayElapsed = (int) (elapsedMs / 60000); // ≤13시간이라 int 오버플로 없음
        }

        // JS recognizedMonthly: effectiveElapsed = min(elapsed, max(0, 상한 - 오늘 확정분))
        int effectiveElapsed = Math.min(todayElapsed, Math.max(0, DAILY_CAP_MIN - todayTotal));
        return monthly + effectiveElapsed;
    }

    /**
     * 오늘 날짜의 개방 세션(entry만 있고 exit 없음) 경과 시간(ms).
     * 신선도 가드: entry가 미래이거나 13시간보다 오래된 개방 세션은 무시 (JS isOpenSessionFresh).
     * 경과는 13시간으로 클램프 (JS MAX_OPEN_SESSION_MINUTES).
     */
    private static long openSessionElapsedMs(JSONArray sessions, String todayStr, long nowMs) {
        if (sessions == null) return 0;
        long best = 0;
        for (int j = 0; j < sessions.length(); j++) {
            JSONObject s = sessions.optJSONObject(j);
            if (s == null) continue;
            int[] entry = parseHHMM(s.optString("entry_time", null));
            if (entry == null) continue;
            int[] exit = parseHHMM(s.optString("exit_time", null));
            if (exit != null) continue; // 닫힌 세션
            long entryTs = timestampOf(todayStr, entry[0], entry[1]);
            if (entryTs < 0 || entryTs > nowMs) continue;
            long elapsed = nowMs - entryTs;
            if (elapsed > MAX_OPEN_SESSION_MS) continue;   // 낡은 개방 세션 — 집계 제외
            best = Math.max(best, elapsed);
        }
        return Math.min(best, MAX_OPEN_SESSION_MS);
    }

    // monthlyDeadlineAlert 미러 — {level, requiredPerDayMin} 또는 null
    private static int[] evaluate(int recognizedMin, double requiredHours, int daysLeftIncludingToday) {
        int requiredMin = (int) Math.round(requiredHours * 60);
        int rem = Math.max(0, requiredMin - recognizedMin);
        if (rem <= 0 || daysLeftIncludingToday < 1) return null;
        double perDay = rem / (double) daysLeftIncludingToday;
        if (perDay >= DAILY_CAP_MIN) {
            return new int[] { 2, (int) Math.ceil(perDay) };
        }
        if (daysLeftIncludingToday > 2 && rem / (double) (daysLeftIncludingToday - 2) >= DAILY_CAP_MIN) {
            return new int[] { 1, (int) Math.ceil(perDay) };
        }
        return null;
    }

    // "HH:MM(:SS)" → 분 — JS durationToMinutes와 동일
    private static int durationToMinutes(String durationStr) {
        if (durationStr == null || durationStr.isEmpty()) return 0;
        String[] p = durationStr.split(":");
        try {
            if (p.length == 3) return Integer.parseInt(p[0]) * 60 + Integer.parseInt(p[1])
                    + Math.round(Integer.parseInt(p[2]) / 60f);
            if (p.length == 2) return Integer.parseInt(p[0]) * 60 + Integer.parseInt(p[1]);
        } catch (NumberFormatException e) { /* fall-through */ }
        return 0;
    }

    private static int[] parseHHMM(String timeStr) {
        if (timeStr == null) return null;
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("^(\\d{1,2}):(\\d{2})")
                .matcher(timeStr.trim());
        if (!m.find()) return null;
        int h = Integer.parseInt(m.group(1));
        int mm = Integer.parseInt(m.group(2));
        if (h > 30 || mm > 59) return null;
        return new int[] { h, mm };
    }

    private static long timestampOf(String dateStr, int h, int m) {
        try {
            String[] d = dateStr.split("-");
            Calendar cal = Calendar.getInstance();
            cal.set(Integer.parseInt(d[0]), Integer.parseInt(d[1]) - 1, Integer.parseInt(d[2]), h, m, 0);
            cal.set(Calendar.MILLISECOND, 0);
            return cal.getTimeInMillis();
        } catch (Exception e) {
            return -1;
        }
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
