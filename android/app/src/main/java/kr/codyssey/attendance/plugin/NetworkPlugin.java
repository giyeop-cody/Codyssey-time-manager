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
        // S4: 본문이 없는 요청(평가 일정 POST 등)은 Content-Type을 달지 않음 — 실측 클라이언트 동작과 동일화
        if (body != null) {
            conn.setRequestProperty("Content-Type", "application/json");
        }

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
    // Q3: endsWith("codyssey.kr")는 "evilcodyssey.kr"도 통과시키므로 점(.) 경계를 강제
    private static boolean isAllowedHost(String host) {
        return host != null && (host.equals("codyssey.kr") || host.endsWith(".codyssey.kr"));
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
        // K1: 헤더명 대소문자 무관하게 수집 (소문자 set-cookie 서버 대응)
        java.util.List<String> setCookies = kr.codyssey.attendance.util.CookieManager.extractSetCookies(conn);
        if (!setCookies.isEmpty()) {
            String origin = conn.getURL().getProtocol() + "://" + conn.getURL().getHost();
            CookieManager cookieManager = CookieManager.getInstance();
            for (String cookie : setCookies) {
                cookieManager.setCookie(origin, cookie);
            }
            // L9+: Domain 속성이 없는 세션 쿠키는 "설정한 호스트에만" 묶이는데, 로그인 성공 쿠키가
            // api.ams 전용(host-only)이면 api.usr(출입/평가 API) 요청에 쿠키가 안 실려
            // 로그인 직후 NOT_LOGGED_IN이 된다 (로그인 불가 현상). Domain=.codyssey.kr 쿠키는
            // CookieManager가 이미 서브도메인 공유하므로, Domain 없는 쿠키만 api.usr에 앵커한다.
            if (!"api.usr.codyssey.kr".equals(conn.getURL().getHost()) && isAllowedHost(conn.getURL().getHost())) {
                for (String cookie : setCookies) {
                    if (!cookie.toLowerCase(java.util.Locale.ROOT).contains("domain=")) {
                        cookieManager.setCookie("https://api.usr.codyssey.kr", cookie);
                    }
                }
            }
            cookieManager.flush();
        }

        StringBuilder response = new StringBuilder();
        // 302 등 바디 없는 응답에서 getInputStream이 예외를 던지는 단말 대응 — 본문 실패가
        // 로그인 실패로 오인되지 않도록 본문 읽기는 방어적으로 (쿠키 저장은 위에서 완료)
        java.io.InputStream in = null;
        try {
            in = responseCode >= 400 ? conn.getErrorStream() : conn.getInputStream();
        } catch (Exception ignored) {
            in = null;
        }
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
        // 리다이렉트 대상 노출 — JS가 "로그인 페이지로 회귀"를 판정할 수 있게 (익스텐션 final URL 판정과 동일 목적)
        String location = conn.getHeaderField("Location");
        if (location != null && !location.isEmpty()) {
            result.put("location", location);
        }

        // JSON 파싱 시도
        try {
            JSONObject json = new JSONObject(response.toString());
            result.put("json", json);
        } catch (JSONException ignored) {}

        return result;
    }
}