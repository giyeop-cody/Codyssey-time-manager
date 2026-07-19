package kr.codyssey.attendance.util;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.wifi.ScanResult;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.telephony.CellInfo;
import android.telephony.CellInfoGsm;
import android.telephony.CellInfoLte;
import android.telephony.CellInfoNr;
import android.telephony.CellInfoWcdma;
import android.telephony.TelephonyManager;

import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 31차(C안): 입퇴실 누락 물리 탐지 — 신호 샘플링 + 학습 + 판정 + 수집.
 *
 * 구성(문서 Codyssey-물리탐지-비교.md의 A/B/C 레벨을 하나로):
 *  ①  연결 Wi-Fi SSID/BSSID (주력, 배터리 0)
 *  ③  기지국 Cell ID (Wi-Fi 꺼진 사용자 보조, 배터리 0)
 *  ⑤  지오펜스 힌트 (PhyGeofence 등록 시 — 반응속도 개선)
 *  ⑥  활동 인식은 보조 기록 (ActivityReceiver가 phy_activity에 저장)
 *  ②  포그라운드 스캔 = 앱을 열 때 1회 교차 확인 (백그라운드 스캔 쓰로틀 우회)
 *
 * 판정 엔진은 web/js/shared-attendance.js의 physicalDecision과 동일 규칙(미러).
 * 값에 바뀌면 양쪽을 항상 같이 고칠 것 — 가중치/임계값 불일치가 생기면
 * 팝업 표시와 네이티브 알림이 어긋난다.
 *
 * 프라이버시: 신호(SSID/BSSID/셀/좌표)는 기기 안 저장소에만 있고 자동 전송 없음.
 *            베타 수집 내보내기은 사용자가 직접 "내보내기" 버튼으로 공유할 때만 이동.
 */
public final class PhysicalCheck {

    private static final String PREFS_NAME = "codyssey_prefs";

    // ===== 판정 상수 (shared-attendance.js 미러 — 동일 값 유지 필수) =====
    public static final int WEIGHT_SSID = 2;
    public static final int WEIGHT_BSSID = 3;
    public static final int WEIGHT_CELL = 1;
    public static final int THRESHOLD_INSIDE = 3;
    public static final int STREAK_FLIP = 2;   // inside 전환에 필요한 연속 평가 수
    public static final int STREAK_ALERT = 2;  // 오탐 방지 지연 — 5분 틱 × 2 = 최소 10분 후 알림

    private static final int LOCATIONS_CAP = 300;
    private static final long SNAPSHOT_FRESH_MS = 30L * 60 * 1000; // 게이트 스냅샷 신선도 하한
    private static final long HINT_TTL_MS = 6L * 60 * 60 * 1000; // 32차 N31-3: 지오펜스 힌트 유효시간
    private static final long LEARN_GEO_FRESH_MS = 2L * 60 * 1000; // 32차 N31-4: 학습 좌표 신선도 요구
    private static final float LEARN_GEO_MAX_ACCURACY_M = 100f; // 32차 N31-4: 학습 좌표 정확도 상한

    private PhysicalCheck() {}

    // ===== SyncTasks 진입점: 매 5분 틱 =====
    public static void sampleAndEvaluate(Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            if (!prefs.getBoolean("phy_enabled", false)) return;

            boolean fine = ContextCompat.checkSelfPermission(context,
                    Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            if (!fine) {
                DiagLog.addOnChange(context, "PHY", "noperm",
                        "⚠️ 물리 탐지 켜짐이지만 위치 권한 없음 — SSID/셀을 읽을 수 없음 (설정에서 권한 허용 필요)");
                return;
            }

            long now = System.currentTimeMillis();
            SignalBundle sig = readSignals(context);

            JSONArray locations;
            try {
                locations = new JSONArray(prefs.getString("phy_locations", "[]"));
            } catch (Exception e) {
                locations = new JSONArray();
            }

            // 학습: 서버가 입실을 확인한 상태(세션 열림)면 현재 신호 = 학원 신호로 축적
            Boolean sessionOpen = readSessionOpen(prefs);
            if (Boolean.TRUE.equals(sessionOpen) && sig.hasSignal) {
                learnFromSignals(prefs, locations, sig, now);
                // 방금 학습한 내용이 즉시 점수에 반영되도록 저장소에서 다시 읽음
                try {
                    locations = new JSONArray(prefs.getString("phy_locations", "[]"));
                } catch (Exception e) {
                    locations = new JSONArray();
                }
            }

            int score = scoreSignals(locations, sig);

            // 지오펜스 힌트 반영 (ENTER=1 / EXIT=-1 / 없음=0) — ⑤ 반응속도 경로
            // 32차 N31-3: 힌트는 이벤트 수신 시각 기준 6시간만 유효. 이벤트가 멈춰도
            // 마지막 값이 영구 고정돼 S1/S2 허위 판정을 유발하지 않도록 만료 처리.
            int hint = prefs.getInt("phy_geo_hint", 0);
            if (hint != 0) {
                long hintAt = prefs.getLong("phy_geo_hint_at", 0);
                if (hintAt > 0 && now - hintAt <= HINT_TTL_MS) {
                    if (hint == 1) score = Math.max(score, THRESHOLD_INSIDE);
                    else if (hint == -1) score = 0;
                } else {
                    prefs.edit().putInt("phy_geo_hint", 0).apply();
                    DiagLog.addOnChange(context, "PHY", "hint_expired",
                            "지오펜스 힌트 만료(6시간 무갱신) — 이후 판정은 신호 점수만 사용");
                }
            }

            Decision prev = readState(prefs);
            Decision next = decide(prev, sessionOpen, sig.hasSignal, locations.length() > 0, score);
            writeState(prefs, next, now);

            maybeAlert(context, prefs, next, sig);


            // 32차 N31-8: 로그 키에서 점수 제외 — 셀 환경 누화로 점수가 출렁일 때마다
            // 새 키가 만들어지며 진단 링버퍼가 씻기는 것을 방지 (점수는 메시지에만)
            DiagLog.addOnChange(context, "PHY", "state_" + insideName(next.inside),
                    "물리 판정: " + insideName(next.inside) + " (점수 " + score
                            + (sessionOpen != null ? ", 서버세션 " + (sessionOpen ? "열림" : "닫힘") : ", 서버세션 불명") + ")");
        } catch (Exception e) { /* 틱 실패는 다음 틱으로 */ }
    }

    // ===== 신호 읽기 =====
    static class SignalBundle {
        String ssid;
        String bssid;
        List<String> cells = new ArrayList<>();
        boolean hasSignal;
    }

    static SignalBundle readSignals(Context context) {
        SignalBundle out = new SignalBundle();
        try {
            WifiManager wm = (WifiManager) context.getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            WifiInfo info = wm != null ? wm.getConnectionInfo() : null;
            if (info != null) {
                String ssid = info.getSSID();
                if (ssid != null && !ssid.equals(WifiManager.UNKNOWN_SSID) && !"<unknown ssid>".equals(ssid)) {
                    out.ssid = ssid.replace("\"", "");
                }
                String bssid = info.getBSSID();
                if (bssid != null && !"02:00:00:00:00:00".equals(bssid)) {
                    out.bssid = bssid;
                }
            }
        } catch (SecurityException se) {
            DiagLog.addOnChange(context, "PHY", "wifideny", "⚠️ 연결 Wi-Fi 읽기 거부 (권한)");
        } catch (Exception ignored) { }

        try {
            TelephonyManager tm = (TelephonyManager) context.getSystemService(Context.TELEPHONY_SERVICE);
            List<CellInfo> infos = tm != null ? tm.getAllCellInfo() : null;
            if (infos != null) {
                for (CellInfo ci : infos) {
                    String key = cellKey(ci);
                    if (key != null) out.cells.add(key);
                }
            }
        } catch (SecurityException se) {
            DiagLog.addOnChange(context, "PHY", "celldeny", "⚠️ 기지국 읽기 거부 (권한)");
        } catch (Exception ignored) { }

        out.hasSignal = out.ssid != null || out.bssid != null || !out.cells.isEmpty();
        return out;
    }

    private static String cellKey(CellInfo ci) {
        try {
            if (ci instanceof CellInfoLte) {
                android.telephony.CellIdentityLte id = ((CellInfoLte) ci).getCellIdentity();
                return "lte:" + id.getCi() + "-" + id.getTac();
            }
            if (Build.VERSION.SDK_INT >= 29 && ci instanceof CellInfoNr) {
                android.telephony.CellIdentityNr id = (android.telephony.CellIdentityNr)
                        ((CellInfoNr) ci).getCellIdentity();
                return "nr:" + id.getNci() + "-" + id.getTac();
            }
            if (ci instanceof CellInfoGsm) {
                android.telephony.CellIdentityGsm id = ((CellInfoGsm) ci).getCellIdentity();
                return "gsm:" + id.getCid() + "-" + id.getLac();
            }
            if (ci instanceof CellInfoWcdma) {
                android.telephony.CellIdentityWcdma id = ((CellInfoWcdma) ci).getCellIdentity();
                return "wcdma:" + id.getCid() + "-" + id.getLac();
            }
        } catch (Exception ignored) { }
        return null;
    }

    // ===== 서버 세션 상태 (게이트 스냅샷 기반) =====
    // false=오늘 세션 없거나 모두 퇴실, true=오늘 열린 세션 있음, null=불명(스냅샷 없음/낡음)
    private static Boolean readSessionOpen(SharedPreferences prefs) {
        try {
            String memberId = unquoteJson(prefs.getString("member_id", null));
            if (memberId == null || memberId.isEmpty()) return null;
            String raw = prefs.getString("gate_snapshot_" + memberId, null);
            if (raw == null) return null;
            JSONObject snap = new JSONObject(raw);
            long updatedAt = snap.optLong("updatedAt", 0);
            if (updatedAt <= 0 || System.currentTimeMillis() - updatedAt > SNAPSHOT_FRESH_MS) return null;
            JSONObject dates = snap.optJSONObject("dates");
            if (dates == null) return null;
            String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
            JSONArray sessions = dates.optJSONArray(today);
            if (sessions == null) return Boolean.FALSE;
            for (int i = 0; i < sessions.length(); i++) {
                JSONArray pair = sessions.optJSONArray(i);
                if (pair != null && pair.length() >= 2 && pair.isNull(1)) return Boolean.TRUE;
            }
            return Boolean.FALSE;
        } catch (Exception e) {
            return null;
        }
    }

    // ===== 점수 (JS mirror: shared-attendance.js scorePhySignals) =====
    static int scoreSignals(JSONArray locations, SignalBundle sig) {
        int score = 0;
        try {
            for (int i = 0; i < locations.length(); i++) {
                JSONObject loc = locations.optJSONObject(i);
                if (loc == null) continue;
                String kind = loc.optString("kind", "");
                String value = loc.optString("value", "");
                if ("ssid".equals(kind) && sig.ssid != null && sig.ssid.equals(value)) {
                    score += WEIGHT_SSID;
                } else if ("bssid".equals(kind) && sig.bssid != null && sig.bssid.equalsIgnoreCase(value)) {
                    score += WEIGHT_BSSID;
                } else if ("cell".equals(kind) && sig.cells.contains(value)) {
                    score += WEIGHT_CELL;
                }
            }
        } catch (Exception ignored) { }
        return Math.min(score, 6); // 상한 — 셀 다수 적중 과대평가 방지
    }

    // ===== 결정 (JS mirror: shared-attendance.js physicalDecision) =====
    static class Decision {
        Integer inside; // true/false/null — null=판정 불가
        int streakIn;
        int streakOut;
        String alert;   // "S1" | "S2" | null
    }

    static Decision decide(Decision prev, Boolean sessionOpen, boolean hasSignal,
                           boolean hasLearned, int score) {
        Decision out = new Decision();
        Boolean cand; // true=학원 근처 후보 / false=학원 밖 후보 / null=판정 보류
        if (!hasSignal || !hasLearned) {
            cand = null; // 판정 근거 부족
        } else {
            cand = score >= THRESHOLD_INSIDE;
        }
        out.inside = prev.inside;
        out.streakIn = prev.streakIn;
        out.streakOut = prev.streakOut;
        out.alert = null;

        if (cand == null) {
            out.streakIn = 0;
            out.streakOut = 0;
        } else if (cand) {
            out.streakIn = prev.streakIn + 1;
            out.streakOut = 0;
            if (out.streakIn >= STREAK_FLIP) out.inside = 1;
        } else {
            out.streakOut = prev.streakOut + 1;
            out.streakIn = 0;
            if (out.streakOut >= STREAK_FLIP) out.inside = 0;
        }

        if (Boolean.TRUE.equals(sessionOpen) && Integer.valueOf(0).equals(out.inside)
                && out.streakOut >= STREAK_ALERT) {
            out.alert = "S2"; // 건물 밖인데 퇴실 기록 없음
        } else if (Boolean.FALSE.equals(sessionOpen) && Integer.valueOf(1).equals(out.inside)
                && out.streakIn >= STREAK_ALERT) {
            out.alert = "S1"; // 건물 안인데 입실 기록 없음
        }
        return out;
    }

    private static Decision readState(SharedPreferences prefs) {
        Decision d = new Decision();
        try {
            JSONObject st = new JSONObject(prefs.getString("phy_state", "{}"));
            d.inside = st.isNull("inside") ? null : (st.optBoolean("inside") ? 1 : 0);
            d.streakIn = st.optInt("streakIn", 0);
            d.streakOut = st.optInt("streakOut", 0);
        } catch (Exception ignored) { }
        return d;
    }

    private static void writeState(SharedPreferences prefs, Decision d, long now) {
        try {
            JSONObject st = new JSONObject();
            if (d.inside == null) st.put("inside", JSONObject.NULL);
            else st.put("inside", d.inside == 1);
            st.put("streakIn", d.streakIn);
            st.put("streakOut", d.streakOut);
            st.put("lastCheck", now);
            prefs.edit().putString("phy_state", st.toString()).apply();
        } catch (Exception ignored) { }
    }

    // ===== 알림 (당일 유형별 1회) =====
    private static void maybeAlert(Context context, SharedPreferences prefs, Decision d, SignalBundle sig) {
        if (d.alert == null) return;
        try {
            boolean notifEnabled = true;
            try {
                notifEnabled = new JSONObject(prefs.getString("settings", "{}"))
                        .optBoolean("notificationsEnabled", true);
            } catch (Exception ignored) { }
            if (!notifEnabled) return;

            String today = new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
            JSONObject alerts = new JSONObject(prefs.getString("phy_alerts", "{}"));
            if (today.equals(alerts.optString("date", "")) && alerts.optBoolean(d.alert, false)) return;

            JSONObject next = new JSONObject().put("date", today);
            if (today.equals(alerts.optString("date", ""))) {
                next.put("S1", alerts.optBoolean("S1", false));
                next.put("S2", alerts.optBoolean("S2", false));
            }
            next.put(d.alert, true);
            prefs.edit().putString("phy_alerts", next.toString()).apply();

            String title;
            String body;
            if ("S1".equals(d.alert)) {
                title = "🚪 입실 처리 확인 필요";
                body = "학원 신호가 감지되지만 입실 기록이 없습니다. 입실 처리가 안 된 것 같다면 포털 기록을 확인해 주세요.";
            } else {
                title = "🚗 퇴실 처리 확인 필요";
                body = "학원 신호에서 벗어났는데 퇴실 기록이 아직 없습니다. 퇴실 처리 누락이라면 포털 기록을 확인해 주세요.";
            }
            NotificationHelper.showNotification(context, title, body, "phy_" + d.alert.toLowerCase(Locale.US));
            DiagLog.add(context, "PHY", "의심 알림 " + d.alert + " (학원 신호 " + (sig.ssid != null ? sig.ssid : "셀") + " 기준)");
        } catch (Exception ignored) { }
    }

    // ===== 학습 =====
    private static void learnFromSignals(SharedPreferences prefs, JSONArray locations,
                                         SignalBundle sig, long now) {
        try {
            JSONArray next = new JSONArray();
            boolean ssidSeen = sig.ssid == null;
            boolean bssidSeen = sig.bssid == null;
            List<String> newCells = new ArrayList<>(sig.cells);

            for (int i = 0; i < locations.length(); i++) {
                JSONObject loc = locations.optJSONObject(i);
                if (loc == null) continue;
                String kind = loc.optString("kind", "");
                String value = loc.optString("value", "");
                if ("ssid".equals(kind) && value.equals(sig.ssid)) {
                    loc.put("hits", loc.optInt("hits", 0) + 1);
                    loc.put("lastSeen", now);
                    ssidSeen = true;
                } else if ("bssid".equals(kind) && sig.bssid != null && value.equalsIgnoreCase(sig.bssid)) {
                    loc.put("hits", loc.optInt("hits", 0) + 1);
                    loc.put("lastSeen", now);
                    bssidSeen = true;
                } else if ("cell".equals(kind)) {
                    newCells.remove(value);
                }
                next.put(loc);
            }
            if (!ssidSeen) next.put(newLoc("ssid", sig.ssid, now));
            if (!bssidSeen) next.put(newLoc("bssid", sig.bssid, now));
            for (String c : newCells) next.put(newLoc("cell", c, now));

            prefs.edit().putString("phy_locations", pruneLocations(next).toString()).apply();
        } catch (Exception ignored) { }
    }

    private static JSONObject newLoc(String kind, String value, long now) throws Exception {
        return new JSONObject()
                .put("kind", kind)
                .put("value", value)
                .put("hits", 1)
                .put("lastSeen", now);
    }

    // hits 상위 N걸만 유지 (과적합/용량 방지)
    private static JSONArray pruneLocations(JSONArray arr) {
        if (arr.length() <= LOCATIONS_CAP) return arr;
        try {
            List<JSONObject> list = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) list.add(arr.getJSONObject(i));
            list.sort((a, b) -> Integer.compare(b.optInt("hits", 0), a.optInt("hits", 0)));
            JSONArray out = new JSONArray();
            for (int i = 0; i < LOCATIONS_CAP; i++) out.put(list.get(i));
            return out;
        } catch (Exception e) {
            return arr;
        }
    }

    // 설정 버튼 "지금 위치를 학원으로 학습" — 신호 즉시 강화(+5) + 가능하면 좌표도 1건
    public static String learnNow(Context context) {
        try {
            boolean fine = ContextCompat.checkSelfPermission(context,
                    Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            if (!fine) return "위치 권한이 없습니다";
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            SignalBundle sig = readSignals(context);
            long now = System.currentTimeMillis();
            JSONArray locations;
            try {
                locations = new JSONArray(prefs.getString("phy_locations", "[]"));
            } catch (Exception e) {
                locations = new JSONArray();
            }
            int added = 0;
            if (sig.ssid != null) { boost(locations, "ssid", sig.ssid, now); added++; }
            if (sig.bssid != null) { boost(locations, "bssid", sig.bssid, now); added++; }
            for (String c : sig.cells) { boost(locations, "cell", c, now); added++; }

            // 지오펜스용 좌표 (⑤ 토글의 시드)
            // 32차 N31-4: 마지막 잡힌 위치는 수 시간 전 전혀 다른 장소일 수 있음 —
            // 신선도(2분 이내)와 정확도(100m 이내) 검사를 통과한 좌표만 반영.
            // 32차 N31-11: 검증된 신선 좌표가 있으면 기존 좌표도 최신 바닥으로 교체
            // (처음 1걸만 학습하고 멈추던 규칙의 정체 문제 해결)
            Location last = lastKnownLocation(context);
            boolean geoFresh = isFreshUsableLocation(last, now);
            if (geoFresh) {
                String geoValue = last.getLatitude() + "," + last.getLongitude();
                boolean geoUpdated = false;
                for (int i = 0; i < locations.length(); i++) {
                    JSONObject loc = locations.optJSONObject(i);
                    if (loc == null || !"geo".equals(loc.optString("kind"))) continue;
                    loc.put("value", geoValue);
                    loc.put("hits", loc.optInt("hits", 0) + 5);
                    loc.put("lastSeen", now);
                    geoUpdated = true;
                    break;
                }
                if (!geoUpdated) {
                    locations.put(new JSONObject()
                            .put("kind", "geo")
                            .put("value", geoValue)
                            .put("hits", 5)
                            .put("lastSeen", now));
                }
                added++;
            }

            prefs.edit().putString("phy_locations", pruneLocations(locations).toString()).apply();
            DiagLog.add(context, "PHY", "수동 학습 완료 — " + added + "건 (SSID/셀"
                    + (geoFresh ? "+좌표" : ", 좌표 미갱신") + ")");
            return "학습 " + added + "건 반영"
                    + (geoFresh ? " (좌표 포함)" : " (좌표 미갱신 — 최근 잡힌 위치가 오래됐거나 부정확함. 지도 앱을 한 번 열고 다시 시도)");
        } catch (Exception e) {
            return "학습 실패: " + e.getMessage();
        }
    }

    private static void boost(JSONArray arr, String kind, String value, long now) throws Exception {
        for (int i = 0; i < arr.length(); i++) {
            JSONObject loc = arr.optJSONObject(i);
            if (loc == null) continue;
            if (kind.equals(loc.optString("kind")) && value.equalsIgnoreCase(loc.optString("value"))) {
                loc.put("hits", loc.optInt("hits", 0) + 5);
                loc.put("lastSeen", now);
                return;
            }
        }
        arr.put(new JSONObject().put("kind", kind).put("value", value).put("hits", 5).put("lastSeen", now));
    }

    // 32차 N31-4: 학습에 쓸 수 있는 신선한 좌표인지 (2분 이내 + 정확도 100m 이내)
    private static boolean isFreshUsableLocation(Location l, long now) {
        if (l == null) return false;
        if (now - l.getTime() > LEARN_GEO_FRESH_MS) return false;
        return !l.hasAccuracy() || l.getAccuracy() <= LEARN_GEO_MAX_ACCURACY_M;
    }

    private static Location lastKnownLocation(Context context) {
        try {
            LocationManager lm = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return null;
            Location best = null;
            for (String provider : new String[] {"gps", "network", "passive"}) {
                try {
                    Location l = lm.getLastKnownLocation(provider);
                    if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
                } catch (SecurityException ignored) { }
            }
            return best;
        } catch (Exception e) {
            return null;
        }
    }

    // ===== ② 포그라운드 스캔 (앱을 열 때 1회 교차 확인 — 백그라운드 쓰로틀 무관) =====
    @SuppressLint("MissingPermission")
    public static void foregroundScanIfEnabled(final Context context) {
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            if (!prefs.getBoolean("phy_enabled", false)) return;
            // 32차 N31-8: 앱을 자주 열어도 스캔은 30분 간격으로 제한 (OS 쓰로틀 + 로그 노이즈 절감)
            long lastScan = prefs.getLong("phy_scan_at", 0);
            if (System.currentTimeMillis() - lastScan < 30L * 60 * 1000) return;
            prefs.edit().putLong("phy_scan_at", System.currentTimeMillis()).apply();
            boolean fine = ContextCompat.checkSelfPermission(context,
                    Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
            boolean nearbyOk = Build.VERSION.SDK_INT < 33
                    || ContextCompat.checkSelfPermission(context, Manifest.permission.NEARBY_WIFI_DEVICES)
                        == PackageManager.PERMISSION_GRANTED;
            if (!fine && !nearbyOk) return;

            final WifiManager wm = (WifiManager) context.getApplicationContext()
                    .getSystemService(Context.WIFI_SERVICE);
            if (wm == null || !wm.isWifiEnabled()) return;
            wm.startScan();
            new Handler(Looper.getMainLooper()).postDelayed(() -> {
                try {
                    List<ScanResult> results = wm.getScanResults();
                    JSONArray locations = new JSONArray(prefs.getString("phy_locations", "[]"));
                    int matched = 0;
                    for (ScanResult r : results) {
                        for (int i = 0; i < locations.length(); i++) {
                            JSONObject loc = locations.optJSONObject(i);
                            if (loc == null) continue;
                            String kind = loc.optString("kind", "");
                            String value = loc.optString("value", "");
                            if (("ssid".equals(kind) && value.equals(r.SSID))
                                    || ("bssid".equals(kind) && value.equalsIgnoreCase(r.BSSID))) {
                                matched++;
                                break;
                            }
                        }
                    }
                    // 32차 N31-8: 결과 수가 바뀔 때만 기록 (앱을 자주 열어도 로그 씻김 방지)
                    DiagLog.addOnChange(context, "PHY", "scan_" + matched,
                            "포그라운드 스캔: 학원 등록 신호 " + matched + "건 보임 (주변 AP " + results.size() + "개 중)");
                } catch (SecurityException se) {
                    DiagLog.addOnChange(context, "PHY", "scandeny", "⚠️ Wi-Fi 스캔 거부 (권한)");
                } catch (Exception ignored) { }
            }, 3500);
        } catch (Exception ignored) { }
    }

    // ===== 상태 요약 (팝업 표시용) =====
    public static JSONObject statusSummary(Context context) {
        JSONObject out = new JSONObject();
        try {
            SharedPreferences prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            Decision d = readState(prefs);
            out.put("enabled", prefs.getBoolean("phy_enabled", false));
            out.put("geofence", prefs.getBoolean("phy_geofence", false));
            if (d.inside == null) out.put("inside", JSONObject.NULL);
            else out.put("inside", d.inside == 1);
            out.put("locations", new JSONArray(prefs.getString("phy_locations", "[]")).length());
            out.put("lastCheck", prefs.getString("phy_state", "{}").contains("lastCheck")
                    ? new JSONObject(prefs.getString("phy_state", "{}")).optLong("lastCheck", 0) : 0);
            out.put("activity", prefs.getString("phy_activity", "unknown"));
            out.put("fine", ContextCompat.checkSelfPermission(context,
                    Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED);
            out.put("backgroundLocation", Build.VERSION.SDK_INT < 29
                    || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                        == PackageManager.PERMISSION_GRANTED);
        } catch (Exception ignored) { }
        return out;
    }

    private static String insideName(Integer inside) {
        if (inside == null) return "판정중";
        return inside == 1 ? "학원근처" : "학원밖";
    }

    private static String unquoteJson(String raw) {
        if (raw == null) return null;
        String s = raw.trim();
        if (s.length() >= 2 && s.startsWith("\"") && s.endsWith("\"")) {
            return s.substring(1, s.length() - 1);
        }
        return s;
    }
}
