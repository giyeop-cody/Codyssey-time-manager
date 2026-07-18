package kr.codyssey.attendance.util;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import kr.codyssey.attendance.plugin.AlarmPlugin;

/**
 * 평가 일정 자동 연동 (E2) — 앱이 닫혀 있어도 SyncWorker 주기 작업에서 실행.
 *
 * API: POST https://api.usr.codyssey.kr/schedule/scheduleAllList/ (쿼리스트링, 본문 없음)
 *  - instCd, bgngYmd~endYmd(YYYY.MM.DD), scheduleType=request
 *  - 응답 result.reqList[] 해석 규칙 (2026-07-17 usr 프론트엔드 번들 실측으로 확정):
 *    scdlGubunCd "EV"가 평가 행, 시작 시각 bgngYmd+bgngTm,
 *    reqDetail 첫 토큰 R=내가 피평가자 / A=내가 평가자, title || scdlGubunNm이 제목,
 *    fixedCd 00004=거절 / 00005=요청취소 / 00006=완료 → 알람 대상 아님
 *
 * web/js/capacitor-adapter.js의 syncEvalAlarms와 같은 저장 상태(eval_sync_state,
 * codyssey_prefs)를 JS/네이티브가 공유 → 어느 쪽이 동기화하든 알람이 중복되지 않는다.
 * 필드명 폴곤 체인(날짜/시각/제목/고유키)도 shared-attendance.js의 parseScheduleRows와 동일.
 */
public class EvalSync {

    private static final String PREFS_NAME = "codyssey_prefs";
    private static final String ALARMS_KEY = "codyssey_alarms";
    private static final String STATE_KEY = "eval_sync_state";
    private static final String INSTCD_KEY = "eval_inst_cd";
    private static final String USR_API = "https://api.usr.codyssey.kr";
    private static final String SCHEDULE_API = USR_API; // 평가 API도 usr 게이트웨이 (번들 실측)

    // 앱이 열릴 때마다 JS도 동기화하므로 네이티브는 6시간에 1회면 충분 (배터리/트래픽 절약)
    private static final long THROTTLE_MS = 6L * 60 * 60 * 1000;
    private static final int MAX_NOTIFY_PER_PASS = 3;

    private static final Set<String> CANCEL_CODES =
            new HashSet<>(Arrays.asList("00004", "00005", "00006")); // 거절/요청취소/완료
    private static final Set<String> CONFIRMED_CODES =
            new HashSet<>(Arrays.asList("00002", "00003")); // 확정/진행 — "감지" 알림 대상 (C2)

    // 미상(코드 없음)은 확정으로 간주 — JS isEvalConfirmed와 동일
    private static boolean isConfirmed(String state) {
        return state == null || state.isEmpty() || CONFIRMED_CODES.contains(state);
    }

    // shared-attendance.js의 EVAL_DT_*_KEYS와 동일 순서
    private static final String[] DT_FULL_KEYS = {
            "scdlBgngDt", "evlBgngDt", "scdlDttm", "bgngDttm", "evlDt", "scdlStartDt",
            "evlStartDt", "startDt", "bgngDt", "scdlBeginDt", "evlBgngDttm"
    };
    private static final String[] DT_DATE_KEYS = {
            "scdlDe", "scdlDt", "scdlYmd", "evlDe", "bgngYmd", "evlYmd", "scdlDay", "evlDate", "scdlDate"
    };
    private static final String[] DT_TIME_KEYS = {
            // ※ 종료 시각 키(endTm 등)는 넣지 않음 — 시작 날짜+종료 시각 오조합 방지 (JS와 동일)
            "scdlTime", "scdlHm", "bgngTm", "bgngHm", "bgngTime", "evlBgngHm", "startTime", "startHm", "scdlStartHm"
    };
    private static final String[] ID_KEYS = {
            "mtlEvlSn", "scdlNo", "evlScdlNo", "evlNo", "evlDegr", "reqNo", "scdlSn", "scheduleNo", "evalReqNo", "evlReqNo"
    };
    private static final String[] TITLE_KEYS = {
            "title", "scdlGubunNm", "lcorsNm", "mtlEvlNm", "evlNm", "courseNm", "projectNm", "subjectNm", "evlTtl", "ttmsNm"
    };
    private static final String[] FIXED_KEYS = { "fixedCd", "fixedCode", "sttsCd", "stusCd" };
    private static final String[] GUBUN_KEYS = { "scdlGubunCd" }; // "EV"가 아니면 평가 아님 (AM/EXAM/MT)
    private static final String[] DETAIL_KEYS = { "reqDetail", "reqDtl", "detailCd" };
    private static final String[] REQUSR_KEYS = { "scdlReqUsr", "reqUsrNm", "reqNm" };

    private static final Pattern YMD_RE =
            Pattern.compile("(20\\d\\d)[.\\-/]?(0[1-9]|1[0-2])[.\\-/]?(0[1-9]|[12]\\d|3[01])");
    private static final Pattern YMD_SHORT_RE = // '26/07/01' 같은 2자리 연도 (레거시 페이지 표기)
            Pattern.compile("^(\\d{2})[.\\-/](0?[1-9]|1[0-2])[.\\-/](0?[1-9]|[12]\\d|3[01])$");
    private static final Pattern HM_COLON_RE = Pattern.compile("(\\d{1,2}):(\\d{2})");
    private static final Pattern HM_DIGIT_RE = Pattern.compile("(\\d{2})(\\d{2})");

    public static void run(Context context) {
        try {
            runInternal(context);
        } catch (Exception e) {
            // 실패는 다음 주기로 (Crashlytics 없음 — 조용히 삼킴)
        }
    }

    // ===== 메인 =====
    private static void runInternal(Context context) throws Exception {
        SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        JSONObject settings = readJson(prefs.getString("settings", null));
        if (settings.optBoolean("evalAutoSyncEnabled", true) == false) return;
        int lead = clamp(settings.optInt("evalLeadMinutes", 30), 0, 1440);
        boolean notifEnabled = settings.optBoolean("notificationsEnabled", true);

        String memberId = unquoteJson(prefs.getString("member_id", null));
        if (memberId == null || memberId.isEmpty()) return;

        // 스로틀: JS(앱 열림) 또는 이전 네이티브 실행이 6시간 남에 동기화했으면 스킵 (상태 공유)
        JSONObject state = readJson(prefs.getString(STATE_KEY, null));
        long fetchedAt = state.optLong("fetchedAt", 0);
        if (System.currentTimeMillis() - fetchedAt < THROTTLE_MS) return;

        // E3(15차): 알림함 채널 — instCd 불필요, 스케줄 채널 실패(403/세션 만료 등)와 무관하게 시도
        int noticeFresh = 0;
        String noticeError = null;
        try {
            noticeFresh = syncNoticeChannel(context, prefs, lead, notifEnabled);
        } catch (Exception e) {
            noticeError = "notice_" + (e.getMessage() != null ? e.getMessage() : "error");
        }
        state.put("noticeFresh", noticeFresh);
        if (noticeError != null) {
            state.put("alarmError", noticeError);
            state.put("alarmErrorAt", System.currentTimeMillis());
            DiagLog.addOnChange(context, "EVAL-N", noticeError, "평가 알림함 채널 실패: " + noticeError);
        } else {
            state.remove("alarmError");
            state.remove("alarmErrorAt");
            DiagLog.addOnChange(context, "EVAL-N", "ok", "평가 알림함 채널 정상 (신규 " + noticeFresh + "건)");
        }

        String instCd = resolveInstCd(context, prefs, settings);
        if (instCd == null || instCd.isEmpty()) {
            recordSkip(prefs, state, "no_instcd");
            return;
        }

        Calendar today = Calendar.getInstance();
        Calendar from = (Calendar) today.clone();
        from.add(Calendar.DAY_OF_MONTH, -1);
        Calendar to = (Calendar) today.clone();
        to.add(Calendar.DAY_OF_MONTH, 365); // C1: 30일 밖 평가도 잡히는 즉시 등록 (JS와 동일 범위)

        String url = SCHEDULE_API + "/schedule/scheduleAllList/?"
                + "mbrId=" + enc(memberId) + "&instCd=" + enc(instCd)
                + "&bgngYmd=" + ymdDot(from) + "&endYmd=" + ymdDot(to)
                + "&scheduleType=request";
        CookieManager.HttpResult res = CookieManager.httpRequest(context, url, "POST", null); // 실측: 본문 없이 쿼리스트링만
        if (res.status != 200) {
            recordSkip(prefs, state, "api_" + res.status); // 302/401=세션 만료 — 폭주 없이 다음 기회로
            DiagLog.addOnChange(context, "EVAL-S", "api_" + res.status,
                    "평가 스케줄 조회 HTTP " + res.status
                    + (res.status >= 300 && res.status < 400 ? " — 서버 리다이렉트(세션 만료 신호)" : ""));
            return;
        }
        DiagLog.addOnChange(context, "EVAL-S", "ok", "평가 스케줄 조회 정상 (HTTP 200)");

        JSONObject raw;
        try {
            raw = new JSONObject(res.body);
        } catch (Exception e) {
            recordSkip(prefs, state, "parse_error");
            return;
        }

        JSONArray reqList = null;
        JSONObject result = raw.optJSONObject("result");
        if (result != null) {
            reqList = result.optJSONArray("reqList");
            if (reqList == null) reqList = result.optJSONArray("list");
        }
        if (reqList == null) reqList = raw.optJSONArray("reqList");
        if (reqList == null) reqList = new JSONArray();

        ParsedRows parsed = parseRows(reqList);

        // 이전 동기화 항목 (같은 계정일 때만)
        List<StateItem> prevItems = new ArrayList<>();
        if (memberId.equals(state.optString("memberId", ""))) {
            JSONArray prevArr = state.optJSONArray("items");
            if (prevArr != null) {
                for (int i = 0; i < prevArr.length(); i++) {
                    JSONObject p = prevArr.optJSONObject(i);
                    if (p == null) continue;
                    StateItem si = new StateItem();
                    si.key = p.optString("key", "");
                    si.name = p.optString("name", null);
                    si.whenMs = p.optLong("whenMs", 0);
                    si.leadMinutes = p.optInt("leadMinutes", 30);
                    si.title = p.optString("title", "평가");
                    si.state = p.optString("state", "");
                    if (!si.key.isEmpty()) prevItems.add(si);
                }
            }
        }
        Map<String, StateItem> prevByKey = new HashMap<>();
        for (StateItem si : prevItems) prevByKey.put(si.key, si);
        Map<String, EvalItem> nextByKey = new HashMap<>();
        for (EvalItem it : parsed.items) nextByKey.put(it.key, it);

        long now = System.currentTimeMillis();
        JSONArray nextItems = new JSONArray();
        int notified = 0;

        for (EvalItem it : parsed.items) {
            StateItem existing = prevByKey.get(it.key);
            String name = (existing != null && existing.name != null)
                    ? existing.name
                    : "codyssey_eval_auto_" + it.key;

            // 지나간 평가: 예약·목록 정리 후 상태에서도 제외
            if (it.whenMs <= now) {
                if (existing != null && existing.name != null) cancelAuto(context, prefs, existing.name);
                continue;
            }

            boolean isNew = existing == null;
            boolean changed = existing != null
                    && (existing.whenMs != it.whenMs || existing.leadMinutes != lead || !it.title.equals(existing.title));

            if (isNew || changed) {
                if (existing != null && existing.name != null) {
                    cancelAuto(context, prefs, existing.name);
                }
                long triggerAt = Math.max(it.whenMs - lead * 60000L, now + 5000);
                // B9: 평가 알람의 지연 발화 허용 상한을 lead+5분으로 — '평가 시작+5분'까지는 늦게도 알림
                //     (익스텐션 handleEvalAlarmFired 규칙과 통일, 기본 15분 K3은 출입 알람용)
                AlarmPlugin.scheduleExactAlarmAt(context, triggerAt, name,
                        "📋 평가 " + lead + "분 전: " + it.title, lead * 60000L + 5 * 60000L);
                AlarmPlugin.trackScheduled(context, name);
                upsertAlarmList(prefs, name, triggerAt, it.title, it.whenMs, lead,
                        it.state != null ? it.state : "");
                // C2: 협의중(00001)은 조용히 등록 — 확정/진행(00002/00003) 또는 미상일 때만 알림
                if (notifEnabled && notified < MAX_NOTIFY_PER_PASS && isConfirmed(it.state)) {
                    notified++;
                    NotificationHelper.showNotification(context,
                            "📋 평가 일정 감지",
                            formatWhenKo(it.whenMs) + " — " + it.title + " (" + lead + "분 전 알람 등록)",
                            "evalnew_" + it.key);
                }
            } else {
                // 그대로 유지 — 단 C2: 협의중 → 확정/진행 전환은 알람 변경 없이 "확정" 알림만
                for (int i = 0; i < prevItems.size(); i++) {
                    StateItem pi = prevItems.get(i);
                    if (pi.key.equals(it.key)) {
                        if (!isConfirmed(pi.state) && isConfirmed(it.state)
                                && notifEnabled && notified < MAX_NOTIFY_PER_PASS) {
                            notified++;
                            NotificationHelper.showNotification(context,
                                    "📋 평가 확정",
                                    formatWhenKo(it.whenMs) + " — " + it.title + " 평가가 확정되었습니다. (" + lead + "분 전 알람 유지)",
                                    "evalconf_" + it.key + "_" + now);
                        }
                        JSONObject keep = new JSONObject();
                        keep.put("key", it.key);
                        keep.put("name", pi.name);
                        keep.put("whenMs", it.whenMs);
                        keep.put("leadMinutes", pi.leadMinutes);
                        keep.put("title", it.title);
                        keep.put("role", it.role);
                        keep.put("state", it.state != null ? it.state : "");
                        keep.put("auto", true);
                        nextItems.put(keep);
                    }
                }
                continue;
            }

            JSONObject saved = new JSONObject();
            saved.put("key", it.key);
            saved.put("name", name);
            saved.put("whenMs", it.whenMs);
            saved.put("leadMinutes", lead);
            saved.put("title", it.title);
            saved.put("role", it.role);
            saved.put("state", it.state != null ? it.state : "");
            saved.put("auto", true);
            nextItems.put(saved);
        }

        // 사라진 항목: 알람 해제 + 알림
        for (StateItem si : prevItems) {
            if (!nextByKey.containsKey(si.key)) {
                if (si.name != null) cancelAuto(context, prefs, si.name);
                if (notifEnabled && notified < MAX_NOTIFY_PER_PASS) {
                    notified++;
                    NotificationHelper.showNotification(context,
                            "📋 평가 일정 변경",
                            (si.title != null ? si.title : "평가") + " 일정이 취소/완료되어 알람을 해제했습니다.",
                            "evaldel_" + si.key + "_" + now);
                }
            }
        }

        JSONObject newState = new JSONObject();
        newState.put("memberId", memberId);
        newState.put("instCd", instCd);
        newState.put("items", nextItems);
        newState.put("fetchedAt", now);
        newState.put("skipped", parsed.skipped);
        newState.put("nonEv", parsed.nonEv);
        newState.put("noticeFresh", noticeFresh);
        if (noticeError != null) {
            newState.put("alarmError", noticeError);
            newState.put("alarmErrorAt", System.currentTimeMillis());
        }
        if (parsed.sampleKeys != null) newState.put("sampleKeys", parsed.sampleKeys);
        prefs.edit().putString(STATE_KEY, newState.toString()).apply();
    }

    // ===== E3(15차): 알림함(alarm/alarmList/list) 평가 감지 채널 =====
    // - "평가 지정" 시스템 알림(실측 sysDivCd 00017 등)에서 평가예정일시를 읽어
    //   신규 1걸당 1회 알림 + N분 전 알람 등록. pstartSn 캐시로 중복 알림 방지.
    // - 스케줄 채널(scheduleAllList)이 이미 잡은 평가(±2분)는 캐시만 (중복 알람/알림 방지)
    private static final String NOTICE_STATE_KEY = "eval_notice_seen";
    private static final Pattern NOTICE_WHEN_RE = Pattern.compile(
            "평가예정일시\\s*[:：]\\s*(20\\d\\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])[ T]([01]\\d|2[0-3]):([0-5]\\d)(?::([0-5]\\d))?");

    private static int syncNoticeChannel(Context context, SharedPreferences prefs, int lead,
                                         boolean notifEnabled) throws Exception {
        JSONObject payload = new JSONObject();
        payload.put("page", 1);
        payload.put("pagePerRows", 30); // JS EVAL_NOTICE_PAGE_PER_ROWS
        CookieManager.HttpResult res = CookieManager.httpRequest(
                context, SCHEDULE_API + "/alarm/alarmList/list", "POST", payload.toString());
        if (res.status != 200) throw new Exception("api_" + res.status);

        JSONObject raw = new JSONObject(res.body);
        JSONObject result = raw.optJSONObject("result");
        JSONArray rows = result != null ? result.optJSONArray("list") : raw.optJSONArray("list");
        if (rows == null) return 0;

        JSONObject seenRoot = readJson(prefs.getString(NOTICE_STATE_KEY, null));
        JSONObject ids = seenRoot.optJSONObject("ids");
        if (ids == null) ids = new JSONObject();

        long now = System.currentTimeMillis();
        int fresh = 0;
        int notified = 0;
        JSONArray alarmList = readAlarmList(prefs); // 스케줄 채널 포함 전체 알람 목록

        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            long snL = row.optLong("pstartSn", -1);
            if (snL < 0) continue;
            String sn = String.valueOf(snL);
            if (ids.has(sn)) continue;

            String bodyText = unescapeAlarmHtml(row.optString("pstartCn", ""));
            if (!bodyText.contains("평가예정일시")) continue; // 종료/포인트/레벨 등 배제
            Matcher wm = NOTICE_WHEN_RE.matcher(bodyText);
            if (!wm.find()) continue;

            String title0 = row.optString("pstartTitlNm", "");
            if ((title0.contains("종료") || title0.contains("취소"))
                    && !(title0.contains("지정") || title0.contains("배정") || title0.contains("안내"))) {
                continue; // 종료/취소 변종 방어 (JS parseEvalNoticeAlarms와 동일 규칙)
            }

            Calendar cal = Calendar.getInstance();
            cal.clear();
            cal.set(Integer.parseInt(wm.group(1)), Integer.parseInt(wm.group(2)) - 1,
                    Integer.parseInt(wm.group(3)), Integer.parseInt(wm.group(4)),
                    Integer.parseInt(wm.group(5)), wm.group(6) != null ? Integer.parseInt(wm.group(6)) : 0);
            long whenMs = cal.getTimeInMillis();

            String requester = noticeField(bodyText, "요청자")
                    .replaceAll("\\s*\\([^)]*\\)\\s*$", "").trim(); // 이름(이메일) → 이름
            String project = noticeField(bodyText, "프로젝트명");
            String role = (title0 + " " + bodyText).contains("동료평가자") ? "A" : "";
            StringBuilder bits = new StringBuilder();
            if ("A".equals(role)) bits.append("평가자");
            if (!requester.isEmpty()) {
                if (bits.length() > 0) bits.append(" · ");
                bits.append("요청자: ").append(requester);
            }
            String title = (project.isEmpty() ? "평가" : project)
                    + (bits.length() > 0 ? " (" + bits + ")" : "");

            fresh++;
            JSONObject rec = new JSONObject();
            rec.put("whenMs", whenMs);
            rec.put("title", title);
            rec.put("firstSeenAt", now);
            ids.put(sn, rec);

            // 중복 방지: 같은 시각(±2분)의 eval 알람이 이미 있으면 캐시만
            boolean covered = false;
            for (int j = 0; j < alarmList.length(); j++) {
                JSONObject a = alarmList.optJSONObject(j);
                if (a == null || !"eval".equals(a.optString("type", ""))) continue;
                long ew = a.optLong("evalWhen", 0);
                if (ew > 0 && Math.abs(ew - whenMs) <= 2 * 60000L) { covered = true; break; }
            }
            if (covered || whenMs <= now) continue;

            String name = "codyssey_eval_auto_notice_" + sn;
            long triggerAt = Math.max(whenMs - lead * 60000L, now + 5000);
            // B9와 동일 허용 상한 (lead+5분)
            AlarmPlugin.scheduleExactAlarmAt(context, triggerAt, name,
                    "📋 평가 " + lead + "분 전: " + title, lead * 60000L + 5 * 60000L);
            AlarmPlugin.trackScheduled(context, name);
            upsertAlarmList(prefs, name, triggerAt, title, whenMs, lead, "");
            JSONObject justAdded = new JSONObject(); // 동일 pass 내 dedup 정확도
            justAdded.put("type", "eval");
            justAdded.put("evalWhen", whenMs);
            alarmList.put(justAdded);

            if (notifEnabled && notified < MAX_NOTIFY_PER_PASS) {
                notified++;
                NotificationHelper.showNotification(context,
                        "📋 평가 일정 감지",
                        formatWhenKo(whenMs) + " — " + title + " (알림함 감지 · " + lead + "분 전 알람 등록)",
                        "evalnotice_" + sn);
            }
        }

        // seen 캐시 프루닝(90일) + 저장
        long cutoff = now - 90L * 24 * 3600 * 1000;
        List<String> drop = new ArrayList<>();
        java.util.Iterator<String> keys = ids.keys();
        while (keys.hasNext()) {
            String k = keys.next();
            JSONObject r = ids.optJSONObject(k);
            if (r == null || r.optLong("firstSeenAt", 0) < cutoff) drop.add(k);
        }
        for (String k : drop) ids.remove(k);
        seenRoot.put("ids", ids);
        seenRoot.put("updatedAt", now);
        prefs.edit().putString(NOTICE_STATE_KEY, seenRoot.toString()).apply();
        return fresh;
    }

    // JS unescapeAlarmHtml과 동일 규칙 (엔티티 디코드 → <br> 개행 → 태그 제거 → &amp; 마지막)
    private static String unescapeAlarmHtml(String s) {
        if (s == null) return "";
        return s.replaceAll("(?i)&lt;", "<")
                .replaceAll("(?i)&gt;", ">")
                .replaceAll("(?i)&quot;", "\"")
                .replaceAll("(?i)&#0?39;|(?i)&#x27;", "'")
                .replaceAll("(?i)&nbsp;", " ")
                .replaceAll("(?i)<\\s*br\\s*/?\\s*>", "\n")
                .replaceAll("<[^>]+>", "")
                .replaceAll("(?i)&amp;", "&")
                .replace("\r", "");
    }

    // 라인 필드("label : value") 추출 — 개행까지
    private static String noticeField(String text, String label) {
        Matcher m = Pattern.compile("(?m)^\\s*" + Pattern.quote(label) + "\\s*[:：]\\s*(.+)$")
                .matcher(text);
        return m.find() ? m.group(1).trim() : "";
    }

    // 실패 시 fetchedAt만 갱신 (내용 유지) — 세션 만료 등에서 15분마다 두드리지 않게
    private static void recordSkip(SharedPreferences prefs, JSONObject state, String reason) {
        try {
            if (state == null) state = new JSONObject();
            state.put("fetchedAt", System.currentTimeMillis());
            state.put("lastError", reason);
            prefs.edit().putString(STATE_KEY, state.toString()).apply();
        } catch (Exception ignored) { /* 무시 */ }
    }

    // ===== instCd 해결: 설정 수동값 → 저장 캐시 → member info 재귀 탐색 =====
    private static String resolveInstCd(Context context, SharedPreferences prefs, JSONObject settings) {
        String manual = settings.optString("evalInstCd", "");
        if (!manual.isEmpty()) return manual;
        String cached = unquoteJson(prefs.getString(INSTCD_KEY, null));
        if (cached != null && !cached.isEmpty()) return cached;
        try {
            CookieManager.HttpResult res = CookieManager.httpGet(context, USR_API + "/rest/user/info/detail");
            if (res.status == 200 && res.body != null && !res.body.isEmpty()) {
                String found = findInstCdRecursive(new JSONObject(res.body));
                if (found != null && !found.isEmpty()) {
                    // JS Preferences(JSON.stringify) 호환 — 따옴표로 감싸 저장
                    prefs.edit().putString(INSTCD_KEY, "\"" + found + "\"").apply();
                    return found;
                }
            }
        } catch (Exception ignored) { /* 무시 */ }
        return null;
    }

    // 응답 어디에 있든 instCd/instCode 키를 재귀 탐색 — JS findInstCd와 동일 규칙
    private static String findInstCdRecursive(Object node) {
        ArrayDeque<Object> stack = new ArrayDeque<>();
        stack.push(node);
        Set<Object> seen = new HashSet<>();
        while (!stack.isEmpty()) {
            Object cur = stack.pop();
            if (cur == null || seen.contains(cur)) continue;
            seen.add(cur);
            if (cur instanceof JSONObject) {
                JSONObject obj = (JSONObject) cur;
                java.util.Iterator<String> it = obj.keys();
                List<Object> children = new ArrayList<>();
                while (it.hasNext()) {
                    String k = it.next();
                    Object v = obj.opt(k);
                    // S4: 문자염뿐 아니라 숫자형(instCd: 21)도 수용 — JS findInstCd와 동일 규칙
                    if (k.matches("(?i)^inst(cd|code)?$") && v instanceof String && !((String) v).trim().isEmpty()) {
                        return ((String) v).trim();
                    }
                    if (k.matches("(?i)^inst(cd|code)?$") && v instanceof Number) {
                        return String.valueOf(v);
                    }
                    children.add(v);
                }
                for (Object c : children) {
                    if (c instanceof JSONObject || c instanceof JSONArray) stack.push(c);
                }
            } else if (cur instanceof JSONArray) {
                JSONArray arr = (JSONArray) cur;
                for (int i = 0; i < arr.length(); i++) {
                    Object v = arr.opt(i);
                    if (v instanceof JSONObject || v instanceof JSONArray) stack.push(v);
                }
            }
        }
        return null;
    }

    // ===== reqList 파싱 — JS parseScheduleRows 미러 =====
    private static class EvalItem {
        String key;
        String title;
        String role;
        long whenMs;
        String state = ""; // fixedCd — 협의/확정 구분 알림용 (C2)
    }

    private static class StateItem {
        String key;
        String name;
        long whenMs;
        int leadMinutes;
        String title;
        String state = "";
    }

    private static class ParsedRows {
        List<EvalItem> items = new ArrayList<>();
        int skipped = 0;
        int nonEv = 0;                    // 평가 아닌 행 수 (AM/EXAM/MT 등)
        JSONArray sampleKeys = null;      // 첫 EV 행의 키 목록 (진단용)
        JSONArray firstRowKeys = null;    // 폴곤: EV가 하나도 없으면 첫 행의 키 목록
    }

    private static ParsedRows parseRows(JSONArray reqList) throws Exception {
        ParsedRows out = new ParsedRows();
        Set<String> seenKeys = new HashSet<>();

        for (int i = 0; i < reqList.length(); i++) {
            JSONObject row = reqList.optJSONObject(i);
            if (row == null) { out.skipped++; continue; }
            if (i == 0 && out.firstRowKeys == null) out.firstRowKeys = row.names();

            String gubun = pickFirst(row, GUBUN_KEYS);
            if (gubun != null && !"EV".equals(gubun)) { out.nonEv++; continue; } // 평가(EV) 아님
            if (out.sampleKeys == null) out.sampleKeys = row.names();

            String fixed = pickFirst(row, FIXED_KEYS);
            if (fixed != null && CANCEL_CODES.contains(fixed)) continue;

            long whenMs = extractDateTimeMs(row);
            if (whenMs <= 0) { out.skipped++; continue; }

            String detail = pickFirst(row, DETAIL_KEYS);
            if (detail == null) detail = "";
            String role = "";
            String detailSn = null; // reqDetail "R||35||…" 의 두 번째 토큰(mtlEvlSn)
            if (!detail.isEmpty()) {
                List<String> toks = new ArrayList<>();
                for (String tk : detail.split("\\|+")) { if (!tk.isEmpty()) toks.add(tk); }
                if (!toks.isEmpty() && ("R".equals(toks.get(0)) || "A".equals(toks.get(0)))) {
                    role = toks.get(0);
                    if (toks.size() >= 2) detailSn = toks.get(1);
                }
            }
            String course = pickFirst(row, TITLE_KEYS);
            if (course == null) course = "평가";
            String reqUsr = pickFirst(row, REQUSR_KEYS);
            String roleLabel = "R".equals(role) ? "피평가자" : "A".equals(role) ? "평가자" : "평가";
            String title = reqUsr != null
                    ? course + " (" + roleLabel + ": " + reqUsr + ")"
                    : course + " (" + roleLabel + ")";

            List<String> idParts = new ArrayList<>();
            for (String k : ID_KEYS) {
                String v = pickFirst(row, new String[] { k });
                if (v != null) idParts.add(v);
            }
            if (idParts.isEmpty() && detailSn != null) idParts.add(detailSn); // reqDetail의 mtlEvlSn
            String key = !idParts.isEmpty()
                    ? join(idParts, "_")
                    : whenMs + "_" + detail + "_" + (reqUsr != null ? reqUsr : "");
            key = key.replaceAll("[^A-Za-z0-9_.-]", "_");
            if (seenKeys.contains(key)) continue;
            seenKeys.add(key);

            EvalItem item = new EvalItem();
            item.key = key;
            item.title = title;
            item.role = role;
            item.whenMs = whenMs;
            item.state = fixed != null ? fixed : ""; // C2: 협의/확정 구분 알림용
            out.items.add(item);
        }

        java.util.Collections.sort(out.items, (a, b) -> Long.compare(a.whenMs, b.whenMs));
        if (out.sampleKeys == null) out.sampleKeys = out.firstRowKeys;
        return out;
    }

    private static long extractDateTimeMs(JSONObject row) {
        // 1. 전체 일시 키
        for (String k : DT_FULL_KEYS) {
            String v = pickFirst(row, new String[] { k });
            if (v == null) continue;
            int[] ymd = ymd(v);
            int[] hm = hm(v);
            if (ymd != null && hm != null) return toMillis(ymd, hm);
        }
        // 2. 날짜 키 + 시각 키
        int[] ymd = null;
        for (String k : DT_DATE_KEYS) {
            ymd = ymd(pickFirst(row, new String[] { k }));
            if (ymd != null) break;
        }
        int[] hm = null;
        for (String k : DT_TIME_KEYS) {
            hm = hm(pickFirst(row, new String[] { k }));
            if (hm != null) break;
        }
        if (ymd != null && hm != null) return toMillis(ymd, hm);

        // 3. 전 필드 스캔 (완전한 일시 패턴 첫 값, 시각 없으면 09:00 간주)
        java.util.Iterator<String> it = row.keys();
        while (it.hasNext()) {
            Object v = row.opt(it.next());
            if (!(v instanceof String) && !(v instanceof Number)) continue;
            String s = String.valueOf(v);
            int[] y2 = ymd(s);
            if (y2 == null) continue;
            int[] h2 = hm(s);
            if (h2 == null) h2 = new int[] { 9, 0 };
            return toMillis(y2, h2);
        }
        return -1;
    }

    private static long toMillis(int[] ymd, int[] hm) {
        Calendar cal = Calendar.getInstance();
        cal.set(ymd[0], ymd[1] - 1, ymd[2], hm[0], hm[1], 0);
        cal.set(Calendar.MILLISECOND, 0);
        return cal.getTimeInMillis();
    }

    private static int[] ymd(String s) {
        if (s == null) return null;
        Matcher m = YMD_RE.matcher(s);
        if (m.find()) {
            try {
                return new int[] { Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3)) };
            } catch (Exception e) {
                return null;
            }
        }
        Matcher s2 = YMD_SHORT_RE.matcher(s.trim());
        if (s2.find()) {
            try {
                return new int[] { 2000 + Integer.parseInt(s2.group(1)), Integer.parseInt(s2.group(2)), Integer.parseInt(s2.group(3)) };
            } catch (Exception e) {
                return null;
            }
        }
        return null;
    }

    private static int[] hm(String s) {
        if (s == null) return null;
        // 뒤쪽 "HH:MM" (날짜가 붙은 문자열에서는 시각만 추출) — JS hmFromString과 동일
        Matcher m = HM_COLON_RE.matcher(s);
        int[] last = null;
        while (m.find()) {
            int h = Integer.parseInt(m.group(1));
            int mm = Integer.parseInt(m.group(2));
            if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) last = new int[] { h, mm };
        }
        if (last != null) return last;
        Matcher m2 = HM_DIGIT_RE.matcher(s);
        if (m2.find()) {
            int h = Integer.parseInt(m2.group(1));
            int mm = Integer.parseInt(m2.group(2));
            if (h >= 0 && h <= 23 && mm >= 0 && mm <= 59) return new int[] { h, mm };
        }
        return null;
    }

    private static String pickFirst(JSONObject row, String[] names) {
        for (String n : names) {
            Object v = row.opt(n);
            if (v == null || v == JSONObject.NULL) continue;
            String s = String.valueOf(v).trim();
            if (!s.isEmpty()) return s;
        }
        return null;
    }

    // ===== 알람 목록(codyssey_alarms) upsert/제거 — JS 목록과 같은 항목 형태 =====
    private static void upsertAlarmList(SharedPreferences prefs, String name, long triggerAt,
                                        String title, long evalWhen, int lead) throws Exception {
        upsertAlarmList(prefs, name, triggerAt, title, evalWhen, lead, "");
    }

    private static void upsertAlarmList(SharedPreferences prefs, String name, long triggerAt,
                                        String title, long evalWhen, int lead, String state) throws Exception {
        JSONArray arr = readAlarmList(prefs);
        JSONArray kept = new JSONArray();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject a = arr.optJSONObject(i);
            if (a == null || name.equals(a.optString("name"))) continue;
            kept.put(a);
        }
        JSONObject entry = new JSONObject();
        entry.put("name", name);
        entry.put("time", triggerAt);
        entry.put("label", "📋 " + title);
        entry.put("endMinutes", JSONObject.NULL);
        entry.put("type", "eval");
        entry.put("evalTitle", title);
        entry.put("evalWhen", evalWhen);
        entry.put("leadMinutes", lead);
        entry.put("auto", true);
        entry.put("state", state != null ? state : "");
        entry.put("createdAt", System.currentTimeMillis());
        kept.put(entry);
        prefs.edit().putString(ALARMS_KEY, kept.toString()).apply();
    }

    private static void removeAlarmListEntry(SharedPreferences prefs, String name) throws Exception {
        JSONArray arr = readAlarmList(prefs);
        JSONArray kept = new JSONArray();
        boolean changed = false;
        for (int i = 0; i < arr.length(); i++) {
            JSONObject a = arr.optJSONObject(i);
            if (a != null && name.equals(a.optString("name"))) { changed = true; continue; }
            if (a != null) kept.put(a);
        }
        if (changed) prefs.edit().putString(ALARMS_KEY, kept.toString()).apply();
    }

    private static JSONArray readAlarmList(SharedPreferences prefs) throws Exception {
        String json = prefs.getString(ALARMS_KEY, null);
        if (json == null) return new JSONArray();
        return new JSONArray(json);
    }

    private static void cancelAuto(Context context, SharedPreferences prefs, String name) {
        try {
            AlarmPlugin.cancelExactAlarm(context, name);
            AlarmPlugin.untrackScheduled(context, name);
            // WorkManager 폴곤으로 예약된 경우도 함께 정리
            androidx.work.WorkManager.getInstance(context)
                    .cancelAllWorkByTag(AlarmPlugin.WORK_TAG_ALARM + name);
            removeAlarmListEntry(prefs, name);
        } catch (Exception ignored) { /* 무시 */ }
    }

    // ===== 유틸 =====
    private static JSONObject readJson(String raw) {
        if (raw == null) return new JSONObject();
        try {
            return new JSONObject(raw);
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static String unquoteJson(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }

    private static String ymdDot(Calendar cal) {
        return String.format(Locale.US, "%d.%02d.%02d",
                cal.get(Calendar.YEAR), cal.get(Calendar.MONTH) + 1, cal.get(Calendar.DAY_OF_MONTH));
    }

    private static String formatWhenKo(long ms) {
        return new SimpleDateFormat("M월 d일 (E) HH:mm", Locale.KOREAN).format(new Date(ms));
    }

    private static int clamp(int v, int min, int max) {
        return Math.max(min, Math.min(max, v));
    }

    private static String join(List<String> parts, String sep) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < parts.size(); i++) {
            if (i > 0) sb.append(sep);
            sb.append(parts.get(i));
        }
        return sb.toString();
    }

    private static String enc(String s) {
        try {
            return java.net.URLEncoder.encode(s, "UTF-8");
        } catch (Exception e) {
            return s;
        }
    }
}
