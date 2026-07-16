package kr.codyssey.attendance.util;

import android.content.Context;
import android.webkit.WebView;
// WebView 직접 생성은 메인 스레드 전용 — 백그라운드 ping은 HttpURLConnection 사용 (N7)

import java.util.HashMap;
import java.util.Map;

public class CookieManager {

    private static final String COOKIE_DOMAIN = "codyssey.kr";
    private static final String API_BASE = "https://api.usr.codyssey.kr";

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

                // Set-Cookie가 오면 세션 갱신으로 간주하고 저장
                String setCookie = conn.getHeaderField("Set-Cookie");
                if (setCookie != null) {
                    cookieManager.setCookie(API_BASE, setCookie);
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