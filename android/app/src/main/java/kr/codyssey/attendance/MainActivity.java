package kr.codyssey.attendance;

import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import kr.codyssey.attendance.plugin.AlarmPlugin;
import kr.codyssey.attendance.plugin.AppInfoPlugin;
import kr.codyssey.attendance.plugin.NetworkPlugin;
import kr.codyssey.attendance.plugin.PhyPlugin;
import kr.codyssey.attendance.plugin.PollingPlugin;

public class MainActivity extends BridgeActivity {

    // 알림 발화 등 네이티브 → JS 브릿지용 현재 활성 인스턴스
    private static MainActivity instance;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        instance = this;

        // 커스텀 Capacitor 플러그인 등록 (반드시 super.onCreate 전에 호출)
        // Q8: NotificationPlugin은 JS 미사용 데드 브리지였기에 util.NotificationHelper로 대체
        registerPlugin(NetworkPlugin.class);
        registerPlugin(AlarmPlugin.class);
        registerPlugin(PollingPlugin.class);
        registerPlugin(PhyPlugin.class); // 31차: 물리 탐지 JS 브릿지
        registerPlugin(AppInfoPlugin.class); // 48차: 버전·서명 지문 조회 (설치본 진위 확인)

        super.onCreate(savedInstanceState);

        // 28차 마이그레이션 (1회): 폐기된 1분 상시 감지 FGS/PollingService·TickReceiver 잔재 정리.
        // 업데이트 전 버전이 남긴 실행 서비스 정지 + 부활 알람(PendingIntent) 취소 + 상시 알림 채널 삭제.
        migrateLegacyForegroundMonitor(getApplicationContext());

        // 30차: 백그라운드 감지(dash)가 켜져 있으면 5분 틱 체인 + 15분 백업 동기화 보장
        if (PollingPlugin.isEnabled(getApplicationContext())) {
            try {
                kr.codyssey.attendance.receiver.SyncTickReceiver.ensureChain(getApplicationContext());
            } catch (Exception e) { /* 다음 앱 실행에서 재시도 */ }
            try {
                PollingPlugin.ensurePeriodicSync(getApplicationContext());
            } catch (Exception e) { /* 다음 앱 실행에서 재시도 */ }
        }

        // L7+K6: 알림 탭으로 앱이 열린 경우 alarmId를 보관 —
        // JS 리스너(adapter) 준비를 폴링한 뒤 이벤트 전달 (고정 지연은 느린 기기에서 이벤트 유실)
        String alarmId = getIntent() != null ? getIntent().getStringExtra("alarmId") : null;
        if (alarmId != null) {
            emitAlarmEventWhenAdapterReady(alarmId, 30); // 300ms × 30 = 최대 9초 대기
        }
        // 25차: 울림 알림을 탭해서 열린 경우 알람 울림 정지
        if (getIntent() != null && getIntent().getBooleanExtra(
                kr.codyssey.attendance.service.AlarmSoundService.EXTRA_STOP_ALARM_SOUND, false)) {
            kr.codyssey.attendance.service.AlarmSoundService.stopSound(this);
        }

        // WebView 디버깅은 디버그 빌드에서만 허용
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        // 쿠키 수용 (세션 유지용)
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);

        // 21차: 스와이프 종료→재실행으로 세션 쿠키가 소실된 경우 백업에서 복원
        // (JSESSIONID가 만료일 없는 세션 쿠키라 프로세스 사망 시 날아가는 문제의 핵심 조치)
        kr.codyssey.attendance.util.CookieManager.restoreSessionCookie(getApplicationContext());

        // WebView 세부 설정 (Capacitor의 BridgeWebViewClient/WebChromeClient는 덮어쓰지 않음 —
        // 덮어쓰면 JS ↔ 네이티브 브리지가 파괴 되어 모든 플러그인 호출이 실패함)
        applyWebViewSettings();
    }

    // 28차: 폐기된 1분 FGS 잔재 정리 (1회 실행). 컴포넌트(PollingService/TickReceiver)는
    // 코드에서 삭제됐으므로, 구버전이 예약해 둔 OS측 리소스만 클래스명 문자열로 해제한다.
    private void migrateLegacyForegroundMonitor(android.content.Context ctx) {
        android.content.SharedPreferences prefs =
                ctx.getSharedPreferences("codyssey_prefs", android.content.Context.MODE_PRIVATE);
        if (prefs.getBoolean("migrated_28_fgmonitor", false)) return;
        try {
            // 1) 실행 중인 구 서비스 정지 (미실행이면 무해)
            android.content.Intent stopSvc = new android.content.Intent().setClassName(
                    ctx.getPackageName(), "kr.codyssey.attendance.service.PollingService");
            ctx.stopService(stopSvc);
            // 2) 구 부활 알람 PendingIntent 취소 (TickReceiver + ACTION_TICK + requestCode 0 서명 일치)
            android.content.Intent tick = new android.content.Intent().setClassName(
                    ctx.getPackageName(), "kr.codyssey.attendance.receiver.TickReceiver")
                    .setAction("kr.codyssey.attendance.action.POLL_TICK");
            android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(ctx, 0, tick,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
            android.app.AlarmManager am = (android.app.AlarmManager) ctx.getSystemService(ALARM_SERVICE);
            if (am != null) am.cancel(pi);
            // 3) "상시 감지" 전용 알림 채널 삭제 (더 이상 사용하지 않음)
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                android.app.NotificationManager nm = ctx.getSystemService(android.app.NotificationManager.class);
                if (nm != null) nm.deleteNotificationChannel("codyssey_monitor");
            }
            kr.codyssey.attendance.util.DiagLog.add(ctx, "SVC",
                    "28차 전환: 1분 상시 감지 FGS 폐기 — 백그라운드 감지는 5분 틱 + 15분 백업으로 통합, 상시 알림 없음");
        } catch (Exception e) { /* 정리 실패는 치명 아님 — 잔존 PI는 수신자 없이 소멸 */ }
        prefs.edit().putBoolean("migrated_28_fgmonitor", true).apply();
    }

    private void applyWebViewSettings() {
        WebView webView = getBridge().getWebView();
        if (webView == null) return;

        WebSettings settings = webView.getSettings();
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        // Mixed content / 임의 권한 허용은 보안상 설정하지 않음(기본값 유지)
    }

    // K6: WebView의 JS 리스너(capacitor-adapter)가 준비될 때까지 폴링한 뒤 알람 이벤트 전달.
    // index.html → popup.html 리다이렉트 + 모듈 로딩이 끝나야 리스너가 등록되므로
    // 고정 지연(1.5초)은 느린 기기에서 이벤트가 유실 될 수 있다.
    private void emitAlarmEventWhenAdapterReady(final String alarmId, final int attemptsLeft) {
        if (attemptsLeft <= 0 || getBridge() == null || getBridge().getWebView() == null) {
            return; // 준비 실패 시 네이티브 알림만으로 충분
        }
        getBridge().getWebView().evaluateJavascript(
                "window.__codysseyAdapterReady === true ? 'yes' : 'no'",
                value -> {
                    if ("\"yes\"".equals(value) || "yes".equals(value)) {
                        emitNativeEvent("ALARM_TRIGGERED", "알림에서 열기", alarmId);
                    } else {
                        getBridge().getWebView().postDelayed(
                                () -> emitAlarmEventWhenAdapterReady(alarmId, attemptsLeft - 1), 300);
                    }
                }
        );
    }

    // 32차 N31-9: 물리 탐지 권한 요청 결과를 팝업에 즉시 전달 — 수락/거절 후 상태 줄이
    // 다음 갱신 시점까지 낡은 문구로 남는 문제 해소
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == kr.codyssey.attendance.plugin.PhyPlugin.REQ_PHY_PERMS) {
            boolean anyGranted = false;
            for (int r : grantResults) {
                if (r == android.content.pm.PackageManager.PERMISSION_GRANTED) anyGranted = true;
            }
            emitNativeEvent("PHY_PERMISSION_RESULT", anyGranted ? "granted" : "denied", "");
        }
    }

    @Override
    public void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        // L7: singleTask이므로 백그라운드 복귀(onNewIntent) 경로의 알림 탭도 처리
        if (intent != null && intent.getStringExtra("alarmId") != null) {
            emitNativeEvent("ALARM_TRIGGERED", "알림에서 열기", intent.getStringExtra("alarmId"));
        }
        // 25차: 울림 알림 탭으로 복귀 — 알람 울림 정지
        if (intent != null && intent.getBooleanExtra(
                kr.codyssey.attendance.service.AlarmSoundService.EXTRA_STOP_ALARM_SOUND, false)) {
            kr.codyssey.attendance.service.AlarmSoundService.stopSound(this);
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        // 31차 ②: 포그그라운드 Wi-Fi 스캔 1회 — 백그라운드 스캔 쓰로틀(30분/회)을 우회하는 교차 확인
        try {
            kr.codyssey.attendance.util.PhysicalCheck.foregroundScanIfEnabled(getApplicationContext());
        } catch (Exception e) { /* 스캔 실패는 치명 아님 */ }
        // 31차: 앱을 열 때 지오펜스 등록 상태도 보장 (OS 정리/기기 마이그레이션 대비)
        try {
            kr.codyssey.attendance.util.PhyGeofence.startIfEnabled(getApplicationContext());
        } catch (Exception e) { /* 다음 실행에서 재시도 */ }
        // 40차: 포그라운드 복귀 시 감지 체인 자가치유 + 권한 상태 진단
        try {
            selfHealDetectionChain(getApplicationContext());
        } catch (Exception e) { /* 치명 아님 */ }
    }

    // 40차: 앱이 열릴 때마다 감지(dash) 체인을 검사·복구.
    // 배경: "백그라운드에서 알림이 안 오고 앱을 열 때 한꺼번에 도착" 제보(37차) — 원인 3갈래 중
    // OS 절전 지연/앱 제한/스와이프 강제종료로 5분 틱 체인이 죽은 경우를 여기서 치유한다.
    //  - 마지막 동기화가 15분 이상 정체 = 체인이 끊겼던 것 → 진단 로그로 원인 판별 근거를 남김
    //  - 5분 틱 체인 + 15분 백업 주기를 재예약 (이미 예약돼 있으면 덮어쓰기라 멱등)
    //  - 배터리 최적화 예외 / 정확한 알람 권한 상태를 전이 시에만 로그 (설정 안내 근거)
    //  - 동기화가 4분 이상 정체되면 즉시 1회 실행 — 앱을 열 때 네이티브 경로도 바로 깨어남
    private void selfHealDetectionChain(android.content.Context ctx) {
        if (!PollingPlugin.isEnabled(ctx)) return; // 사용자가 설정에서 끈 상태는 존중
        android.content.SharedPreferences prefs =
                ctx.getSharedPreferences("codyssey_prefs", MODE_PRIVATE);
        long now = System.currentTimeMillis();
        long lastTick = prefs.getLong("tick_last_fire", 0);
        long lastSync = prefs.getLong("dash_last_tick", 0);
        long staleBase = Math.max(lastTick, lastSync);
        if (staleBase > 0 && now - staleBase > 15 * 60 * 1000) {
            kr.codyssey.attendance.util.DiagLog.add(ctx, "TICK",
                    "⚠️ 감지 체인 끊김 복구 — 마지막 동기화 " + ((now - staleBase) / 60000)
                            + "분 전 (OS 절전 지연/앱 제한/강제종료 중 하나. 반복되면 설정 → 절전모드 예외 해제 필요)");
        }
        kr.codyssey.attendance.receiver.SyncTickReceiver.ensureChain(ctx);
        PollingPlugin.ensurePeriodicSync(ctx);

        android.os.PowerManager pm = (android.os.PowerManager) ctx.getSystemService(POWER_SERVICE);
        boolean exempt = pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName());
        kr.codyssey.attendance.util.DiagLog.addOnChange(ctx, "PERM", "batt", exempt ? "batt_ok" : "batt_limited",
                exempt ? "배터리 최적화 예외 해제 상태"
                        : "⚠️ 배터리 최적화 예외 아님 — 절전 중 감지·알림이 지연될 수 있음 (설정 → 절전모드 예외에서 해제)");
        android.app.AlarmManager am = (android.app.AlarmManager) ctx.getSystemService(ALARM_SERVICE);
        boolean exact = am == null
                || android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S
                || am.canScheduleExactAlarms();
        kr.codyssey.attendance.util.DiagLog.addOnChange(ctx, "PERM", "alarm", exact ? "alarm_ok" : "alarm_limited",
                exact ? "정확한 알람 허용 상태"
                        : "⚠️ 정확한 알람 권한 꺼짐 — OS가 알람 발화를 늦출 수 있음 (설정에서 허용 필요)");

        if (now - lastSync > 4 * 60 * 1000) {
            final android.content.Context appCtx = ctx.getApplicationContext();
            new Thread(() -> kr.codyssey.attendance.util.SyncTasks.run(appCtx),
                    "codyssey-foreground-heal").start();
        }
    }

    @Override
    public void onPause() {
        super.onPause();
        // 세션 쿠키 영속화 (브리지 클라이언트를 교체하지 않고도 쿠키 플러시)
        CookieManager.getInstance().flush();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        if (instance == this) {
            instance = null;
        }
    }

    /**
     * 네이티브 이벤트를 WebView JS로 전달 (R8: 알림 발화 시 화면 자동 갱신).
     * capacitor-adapter.js가 'CodysseyNativeEvent'를 수신해 chrome.runtime.onMessage 리스너로 디스패치한다.
     */
    public static void emitNativeEvent(String type, String label, String id) {
        final MainActivity activity = instance;
        if (activity == null || activity.getBridge() == null || activity.getBridge().getWebView() == null) {
            return; // 앱이 백그라운드/종료 상태면 네이티브 알림만으로 충분
        }
        activity.getBridge().getWebView().post(() -> {
            String js = "window.dispatchEvent(new CustomEvent('CodysseyNativeEvent', { detail: {"
                    + "type: " + jsQuote(type) + ","
                    + "label: " + jsQuote(label) + ","
                    + "id: " + jsQuote(id)
                    + " } }))";
            activity.getBridge().getWebView().evaluateJavascript(js, null);
        });
    }

    private static String jsQuote(String s) {
        if (s == null) return "null";
        // Q6: 개행/라인 구분자 미이스케이프 시 evaluateJavascript의 JS 파싱이 깨져 이벤트가 유실됨
        return "'" + s
                .replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\u2028", "\\u2028")
                .replace("\u2029", "\\u2029")
                + "'";
    }
}
