package kr.codyssey.attendance.plugin;

import android.content.Context;
import android.webkit.CookieManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.DataOutputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;
import java.util.Map;

@CapacitorPlugin(name = "NetworkPlugin")
public class NetworkPlugin extends Plugin {

    private static final String API_BASE = "https://api.usr.codyssey.kr";
    private static final String AMS_BASE = "https://api.ams.codyssey.kr";

    @PluginMethod
    public void fetch(PluginCall call) {
        String url = call.getString("url");
        String method = call.getString("method", "GET");
        JSObject headers = call.getObject("headers");
        JSObject body = call.getObject("body");

        if (url == null) {
            call.reject("url is required");
            return;
        }

        // 허용 도메인 화이트리스트 (세션 쿠키 유출 방지 — N5)
        try {
            String host = new URL(url).getHost();
            if (!isAllowedHost(host)) {
                call.reject("URL not allowed: " + host);
                return;
            }
        } catch (Exception e) {
            call.reject("Invalid URL");
            return;
        }

        // 백그라운드 스레드에서 네트워크 요청
        getBridge().execute(() -> {
            try {
                JSObject result = performRequest(url, method, headers, body);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Network error: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void getMemberInfo(PluginCall call) {
        String url = API_BASE + "/rest/user/info/detail";
        getBridge().execute(() -> {
            try {
                JSObject result = performRequest(url, "GET", null, null);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Failed to get member info: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void getAttendance(PluginCall call) {
        String memberId = call.getString("memberId");
        int year = call.getInt("year");
        int month = call.getInt("month");

        if (memberId == null) {
            call.reject("memberId is required");
            return;
        }

        String url = API_BASE + "/rest/secom/detail?mbrId=" + memberId + "&year=" + year + "&month=" + String.format("%02d", month);
        getBridge().execute(() -> {
            try {
                JSObject result = performRequest(url, "GET", null, null);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Failed to get attendance: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void preCheckLogin(PluginCall call) {
        String userId = call.getString("userId");
        if (userId == null) {
            call.reject("userId is required");
            return;
        }

        String url = AMS_BASE + "/rest/login/pre-check";
        JSObject body = new JSObject();
        body.put("userId", userId);

        getBridge().execute(() -> {
            try {
                JSObject result = performRequest(url, "POST", null, body);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Pre-check failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        String userId = call.getString("userId");
        String password = call.getString("password");
        String from = call.getString("from", "");

        if (userId == null || password == null) {
            call.reject("userId and password are required");
            return;
        }

        String url = AMS_BASE + "/authenticate";
        getBridge().execute(() -> {
            try {
                String formData = "userId=" + java.net.URLEncoder.encode(userId, "UTF-8") +
                        "&password=" + java.net.URLEncoder.encode(password, "UTF-8") +
                        "&from=" + java.net.URLEncoder.encode(from, "UTF-8");

                HttpURLConnection conn = createConnection(url, "POST");
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                conn.setRequestProperty("Origin", "https://ams.codyssey.kr");
                conn.setRequestProperty("Referer", "https://ams.codyssey.kr/");
                addCookies(conn);

                conn.setDoOutput(true);
                try (DataOutputStream os = new DataOutputStream(conn.getOutputStream())) {
                    os.writeBytes(formData);
                    os.flush();
                }

                JSObject result = readResponse(conn);
                call.resolve(result);
            } catch (Exception e) {
                call.reject("Authentication failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void clearCookies(PluginCall call) {
        CookieManager.getInstance().removeAllCookies(null);
        CookieManager.getInstance().flush();
        call.resolve();
    }

    @PluginMethod
    public void getCookies(PluginCall call) {
        String cookies = CookieManager.getInstance().getCookie(API_BASE);
        JSObject result = new JSObject();
        result.put("cookies", cookies != null ? cookies : "");
        call.resolve(result);
    }

    private JSObject performRequest(String urlString, String method, JSObject headers, JSObject body) throws Exception {
        HttpURLConnection conn = createConnection(urlString, method);

        // 기본 헤더
        conn.setRequestProperty("Accept", "application/json");
        conn.setRequestProperty("Content-Type", "application/json");

        // 커스텀 헤더
        if (headers != null) {
            Iterator<String> keys = headers.keys();
            while (keys.hasNext()) {
                String key = keys.next();
                conn.setRequestProperty(key, headers.getString(key));
            }
        }

        // 쿠키 추가
        addCookies(conn);

        // 바디 작성
        if (body != null && (method.equals("POST") || method.equals("PUT") || method.equals("PATCH"))) {
            conn.setDoOutput(true);
            String jsonBody = body.toString();
            try (DataOutputStream os = new DataOutputStream(conn.getOutputStream())) {
                os.writeBytes(jsonBody);
                os.flush();
            }
        }

        return readResponse(conn);
    }

    private HttpURLConnection createConnection(String urlString, String method) throws Exception {
        URL url = new URL(urlString);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(15000);
        conn.setUseCaches(false);
        // 리다이렉트 자동 추적 비활성화 — 302(세션 만료)를 직접 감지하기 위함 (N4)
        conn.setInstanceFollowRedirects(false);
        return conn;
    }

    // 세션 쿠키 첨부 허용 도메인 (codyssey 계엧만 — N5)
    private static boolean isAllowedHost(String host) {
        return host != null && host.endsWith("codyssey.kr");
    }

    private void addCookies(HttpURLConnection conn) {
        // L9: 요청 호스트와 정확히 일치하는 origin의 쿠키만 첨부
        // (codyssey 계열 전체에 API/AMS 쿠키를 병합 첨부하던 방식은 과다 공유)
        String host = conn.getURL().getHost();
        if (!isAllowedHost(host)) {
            return;
        }
        String origin = conn.getURL().getProtocol() + "://" + host;
        String cookies = CookieManager.getInstance().getCookie(origin);
        if (cookies != null && !cookies.isEmpty()) {
            conn.setRequestProperty("Cookie", cookies);
        }
    }

    private static final int MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB

    private JSObject readResponse(HttpURLConnection conn) throws Exception {
        int responseCode = conn.getResponseCode();

        // L9: Set-Cookie 헤더 전체 순회 (첫 헤더만 읽으면 다중 쿠키 설정 시 손실)
        java.util.List<String> setCookies = conn.getHeaderFields().get("Set-Cookie");
        if (setCookies != null) {
            String origin = conn.getURL().getProtocol() + "://" + conn.getURL().getHost();
            CookieManager cookieManager = CookieManager.getInstance();
            for (String cookie : setCookies) {
                cookieManager.setCookie(origin, cookie);
            }
            cookieManager.flush();
        }

        StringBuilder response = new StringBuilder();
        java.io.InputStream in = responseCode >= 400 ? conn.getErrorStream() : conn.getInputStream();
        if (in != null) {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(in))) {
                char[] buffer = new char[4096];
                int total = 0;
                int read;
                while ((read = reader.read(buffer)) != -1) {
                    total += read;
                    if (total > MAX_RESPONSE_BYTES) {
                        throw new java.io.IOException("Response body too large");
                    }
                    response.append(buffer, 0, read);
                }
            }
        }

        JSObject result = new JSObject();
        result.put("status", responseCode);
        result.put("data", response.toString());

        // JSON 파싱 시도
        try {
            JSONObject json = new JSONObject(response.toString());
            result.put("json", json);
        } catch (JSONException ignored) {}

        return result;
    }
}