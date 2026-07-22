package kr.codyssey.attendance.util;

import android.content.Context;
import android.webkit.WebView;
// WebView 직접 생성은 메인 스레드 전용 — 백그라운드 ping은 HttpURLConnection 사용 (N7)

import java.util.HashMap;
import java.util.Map;

public class CookieManager {

    private static final String COOKIE_DOMAIN = "codyssey.kr";
    private static final String API_BASE = "https://api.usr.codyssey.kr";
    private static final String PREFS_NAME = "codyssey_prefs";
    private static final String SESSION_BACKUP_KEY = "session_jsessionid";

    // ===== 21차: 세션 쿠키(JSESSIONID) 영속화 =====
    // 서버 JSESSIONID는 만료일 없는 "세션 쿠키"라 WebView 쿠키 저장소에서도
    // 프로세스가 죽으면 디스크에 남지 않는다. 그래서 "창 스와이프 종료 → 시간 경과 →
    // 재실행"이면 쿠키가 증발해 302 → 로그인 폼 회귀가 발생했다.
    // → 인증이 확인된 응답에서 값을 SharedPreferences에 백업하고,
    //   저장소에 쿠키가 없을 때(프로세스 재시작) 백업값을 재주입한다.
    // 서버 TTL 만료로 무효화된 세션은 복원핟도 302이므로 종국엔 재로그인 — 이 경우는
    // 서버 정책이며 코드로는 제거 불가(진단 로그로 구분 가능).

    // 인증 확인 응답 직후 호출 — 현재 저장소의 JSESSIONID를 백업
    public static void persistSessionCookie(Context context) {
        try {
            String sid = getSessionId(context);
            if (sid == null || sid.isEmpty()) return;
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit().putString(SESSION_BACKUP_KEY, sid).apply();
        } catch (Exception e) { /* 백업 실패는 치명 아님 — 다음 기회에 */ }
    }

    // 요청/틱 시작 시 호출 — 저장소에 쿠키가 없고 백업이 있으면 재주입 (있으면 no-op)
    public static void restoreSessionCookie(Context context) {
        try {
            if (hasSessionCookie(context)) return;
            String sid = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(SESSION_BACKUP_KEY, null);
            if (sid == null || sid.isEmpty()) return;
            android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
            cm.setAcceptCookie(true);
            cm.setCookie(API_BASE,
                    "JSESSIONID=" + sid + "; domain=" + COOKIE_DOMAIN + "; path=/; Secure; SameSite=None");
            cm.flush();
            DiagLog.add(context, "COOKIE",
                    "세션 쿠키 백업에서 복원 (프로세스 재시작으로 소실됐던 것 복구)");
        } catch (Exception e) { /* 복원 실패 — 다음 기회에 재시도 */ }
    }

    // 로그아웃/세션 폐기 확정 시 호출 — 백업도 함께 삭제 (죽은 세션 부활 방지)
    public static void clearPersistedSession(Context context) {
        try {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .edit().remove(SESSION_BACKUP_KEY).apply();
        } catch (Exception e) { /* 무시 */ }
    }

    // 41차: 백업 세션 값 그대로 (없으면 null) — 헤드리스 프로세스에서 WebView 저장소를 못 쓸 때 직접 헤더 주입용
    public static String backupSessionId(Context context) {
        try {
            String sid = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                    .getString(SESSION_BACKUP_KEY, null);
            return (sid == null || sid.isEmpty()) ? null : sid;
        } catch (Exception e) {
            return null;
        }
    }

    // 41차: 서버 조회 인증이 가능한가 — WebView 저장소의 쿠키 또는 백업 중 하나라도 있으면 true
    public static boolean hasUsableSession(Context context) {
        return hasSessionCookie(context) || backupSessionId(context) != null;
    }

    // 41차: JSESSIONID를 확실히 담은 Cookie 헤더 문자열 — 저장소 쿠키가 있으면 그대로,
    // 없으면 백업 세션을 직접 주입 (백그라운드 헤드리스 프로세스에서 WebView 저장소
    // 복원이 조용히 실패하는 경로 우회 — 40차 제보 로그에서 백그라운드 복원 로그 부재로 확인)
    private static String effectiveCookieHeader(Context context, String origin) {
        String cookies = getCookies(context, origin);
        boolean jarHas = cookies != null && cookies.contains("JSESSIONID");
        if (jarHas) {
            DiagLog.addOnChange(context, "COOKIE", "src", "jar",
                    "세션 쿠키 WebView 저장소에서 확보");
            return cookies;
        }
        String sid = backupSessionId(context);
        if (sid != null) {
            String merged = "JSESSIONID=" + sid + (cookies != null && !cookies.isEmpty() ? "; " + cookies : "");
            DiagLog.addOnChange(context, "COOKIE", "src", "direct",
                    "백업 세션을 요청 헤더에 직접 주입 — 헤드리스 프로세스라 WebView 저장소를 못 쓰는 경로 우회");
            return merged;
        }
        DiagLog.addOnChange(context, "COOKIE", "src", "none",
                "⚠️ 세션 쿠키·백업 모두 없음 — 이후 서버 조회는 302로 실패 → 재로그인 필요");
        return cookies;
    }

    // K1: Set-Cookie 헤더명은 대소문자 무관하게 수집 (서버가 "set-cookie" 소문자로
    // 전송하면 getHeaderFields().get("Set-Cookie")가 null을 반환해 쿠키가 유실됨)
    public static java.util.List<String> extractSetCookies(java.net.HttpURLConnection conn) {
        java.util.List<String> out = new java.util.ArrayList<>();
        java.util.Map<String, java.util.List<String>> fields = conn.getHeaderFields();
        if (fields == null) return out;
        for (java.util.Map.Entry<String, java.util.List<String>> entry : fields.entrySet()) {
            String name = entry.getKey();
            if (name != null && name.equalsIgnoreCase("set-cookie") && entry.getValue() != null) {
                out.addAll(entry.getValue());
            }
        }
        return out;
    }

    // 세션 유지 핑 (네이티브 HTTP — 백그라운드 스레드에서 WebView 생성하던 크래시 위험 제거, N7)
    public static void pingKeepAlive(Context context) {
        try {
            restoreSessionCookie(context); // 21차: 프로세스 재시작 시 백업 세션 복원 (best-effort)
            android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
            String cookies = effectiveCookieHeader(context, API_BASE); // 41차: 헤드리스 경로용 백업 직접 주입 포함

            java.net.HttpURLConnection conn = (java.net.HttpURLConnection)
                    new java.net.URL(API_BASE + "/rest/user/info/detail").openConnection();
            try {
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(10000);
                conn.setReadTimeout(10000);
                conn.setInstanceFollowRedirects(false);
                conn.setRequestProperty("Accept", "application/json");
                if (cookies != null && !cookies.isEmpty()) {
                    conn.setRequestProperty("Cookie", cookies);
                }
                int responseCode = conn.getResponseCode(); // 응답 본문은 불필요

                // 19차: keep-alive 응답 전이 기록 (세션 유지 실패가 로그인 폼 회귀의 직접 단서)
                if (responseCode == 200) {
                    DiagLog.addOnChange(context, "PING", "ok", "로그인 유지 핑 정상 (HTTP 200)");
                    persistSessionCookie(context); // 21차: 인증 확인 — 백업 최신화 (서버 회전 대응)
                } else {
                    DiagLog.addOnChange(context, "PING", "http_" + responseCode,
                            "로그인 유지 핑 HTTP " + responseCode
                            + (responseCode >= 300 && responseCode < 400
                                ? " — 서버 리다이렉트 (세션 만료 신호)" : " — 예상 밖 응답"));
                }

                // Set-Cookie 전체 순회 — 다중 쿠키 손실 방지 (L9 연계) + 대소문자 무관 (K1)
                java.util.List<String> setCookies = extractSetCookies(conn);
                if (!setCookies.isEmpty()) {
                    for (String cookie : setCookies) {
                        cookieManager.setCookie(API_BASE, cookie);
                    }
                    cookieManager.flush();
                }
            } finally {
                conn.disconnect();
            }
        } catch (Exception e) {
            // CookieManager 미초기화(앱 미실행 상태) 등 — 다음 주기에 재시도
            DiagLog.addOnChange(context, "PING", "net",
                    "로그인 유지 핑 네트워크 오류: " + (e.getMessage() != null ? e.getMessage() : "unknown"));
        }
    }

    // 쿠키 가져오기
    public static String getCookies(Context context, String url) {
        android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
        return cookieManager.getCookie(url);
    }

    // 간단한 네이티브 GET 결과 (G1: 백그라운드 출입 조회용 — NetworkPlugin은 JS 브릿지 전용이라 재사용 불가)
    public static class HttpResult {
        public int status = -1;
        public String body = "";
    }

    // 세션 쿠키를 포함한 GET 요청 (응답 Set-Cookie는 WebView 쿠키 저장소에 반영)
    // pingKeepAlive(N7)와 동일 패턴. 실패 시 status=-1 반환, 예외는 밖으로 던지지 않음.
    public static HttpResult httpGet(Context context, String urlString) {
        return httpRequest(context, urlString, "GET", null);
    }

    // 세션 쿠키를 포함한 요청 (E2: 평가 일정 API는 POST+본문 "null")
    public static HttpResult httpRequest(Context context, String urlString, String method, String bodyString) {
        HttpResult result = new HttpResult();
        java.net.HttpURLConnection conn = null;
        try {
            restoreSessionCookie(context); // 21차 (best-effort — 헤드리스에선 저장소 복원이 실패할 수 있음)
            java.net.URL url = new java.net.URL(urlString);
            String origin = url.getProtocol() + "://" + url.getHost();
            String cookies = effectiveCookieHeader(context, origin); // 41차: 저장소 미비 시 백업 직접 주입

            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);
            conn.setInstanceFollowRedirects(false); // 302(세션 만료)를 status로 확인하기 위함
            conn.setRequestProperty("Accept", "application/json");
            // S4: 본문이 없는 요청(scheduleAllList 등)은 Content-Type 생략 — 실측 동작과 동일화
            if (bodyString != null) {
                conn.setRequestProperty("Content-Type", "application/json");
            }
            if (cookies != null && !cookies.isEmpty()) {
                conn.setRequestProperty("Cookie", cookies);
            }

            if (bodyString != null && !"GET".equals(method)) {
                conn.setDoOutput(true);
                try (java.io.DataOutputStream os = new java.io.DataOutputStream(conn.getOutputStream())) {
                    os.write(bodyString.getBytes("UTF-8"));
                    os.flush();
                }
            }

            result.status = conn.getResponseCode();

            // Set-Cookie 전체 순회 — 다중 쿠키 손실 방지 (L9 연계) + 대소문자 무관 (K1)
            java.util.List<String> setCookies = extractSetCookies(conn);
            if (!setCookies.isEmpty()) {
                android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
                for (String cookie : setCookies) {
                    cookieManager.setCookie(origin, cookie);
                }
                cookieManager.flush();
            }
            if (result.status == 200) {
                persistSessionCookie(context); // 21차: 인증 확인 응답에서만 백업 (비인증 302 세션 덮어쓰기 방지)
            }

            java.io.InputStream in = result.status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (in != null) {
                StringBuilder sb = new StringBuilder();
                try (java.io.BufferedReader reader = new java.io.BufferedReader(
                        new java.io.InputStreamReader(in, "UTF-8"))) {
                    char[] buf = new char[4096];
                    int total = 0;
                    int read;
                    while ((read = reader.read(buf)) != -1) {
                        total += read;
                        if (total > 2 * 1024 * 1024) break; // NetworkPlugin과 동일 상한
                        sb.append(buf, 0, read);
                    }
                }
                result.body = sb.toString();
            }
        } catch (Exception e) {
            result.status = -1;
            result.body = "";
        } finally {
            if (conn != null) conn.disconnect();
        }
        return result;
    }

    // 쿠키 설정
    public static void setCookie(Context context, String url, String name, String value) {
        android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        String cookie = name + "=" + value + "; domain=" + COOKIE_DOMAIN + "; path=/; Secure; SameSite=None";
        cookieManager.setCookie(url, cookie);
        cookieManager.flush();
    }

    // 모든 쿠키 가져오기
    public static Map<String, String> getAllCookies(Context context) {
        Map<String, String> cookies = new HashMap<>();
        String cookieString = getCookies(context, API_BASE);
        if (cookieString != null) {
            for (String cookie : cookieString.split(";")) {
                String[] parts = cookie.trim().split("=", 2);
                if (parts.length == 2) {
                    cookies.put(parts[0], parts[1]);
                }
            }
        }
        return cookies;
    }

    // 세션 쿠키 확인
    public static boolean hasSessionCookie(Context context) {
        String cookies = getCookies(context, API_BASE);
        return cookies != null && cookies.contains("JSESSIONID");
    }

    // 세션 쿠키 값 가져오기
    public static String getSessionId(Context context) {
        String cookies = getCookies(context, API_BASE);
        if (cookies != null) {
            for (String cookie : cookies.split(";")) {
                String[] parts = cookie.trim().split("=", 2);
                if (parts.length == 2 && parts[0].trim().equals("JSESSIONID")) {
                    return parts[1];
                }
            }
        }
        return null;
    }

    // 쿠키 동기화 (WebView용)
    public static void syncCookies(Context context, WebView webView) {
        android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);
        cookieManager.flush();
    }
}