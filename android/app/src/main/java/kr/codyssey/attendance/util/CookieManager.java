package kr.codyssey.attendance.util;

import android.content.Context;
import android.webkit.WebView;
// WebView 직접 생성은 메인 스레드 전용 — 백그라운드 ping은 HttpURLConnection 사용 (N7)

import java.util.HashMap;
import java.util.Map;

public class CookieManager {

    private static final String COOKIE_DOMAIN = "codyssey.kr";
    private static final String API_BASE = "https://api.usr.codyssey.kr";

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
            android.webkit.CookieManager cookieManager = android.webkit.CookieManager.getInstance();
            String cookies = cookieManager.getCookie(API_BASE);

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
        } catch (Exception ignored) {
            // CookieManager 미초기화(앱 미실행 상태) 등 — 다음 주기에 재시도
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
        HttpResult result = new HttpResult();
        java.net.HttpURLConnection conn = null;
        try {
            java.net.URL url = new java.net.URL(urlString);
            String origin = url.getProtocol() + "://" + url.getHost();
            String cookies = getCookies(context, origin);

            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(15000);
            conn.setInstanceFollowRedirects(false); // 302(세션 만료)를 status로 확인하기 위함
            conn.setRequestProperty("Accept", "application/json");
            if (cookies != null && !cookies.isEmpty()) {
                conn.setRequestProperty("Cookie", cookies);
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