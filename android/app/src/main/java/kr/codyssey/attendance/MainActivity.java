package kr.codyssey.attendance;

import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import kr.codyssey.attendance.plugin.AlarmPlugin;
import kr.codyssey.attendance.plugin.NetworkPlugin;
import kr.codyssey.attendance.plugin.NotificationPlugin;

public class MainActivity extends BridgeActivity {

    // 알림 발화 등 네이티브 → JS 브릿지용 현재 활성 인스턴스
    private static MainActivity instance;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        instance = this;

        // 커스텀 Capacitor 플러그인 등록 (반드시 super.onCreate 전에 호출)
        registerPlugin(NetworkPlugin.class);
        registerPlugin(AlarmPlugin.class);
        registerPlugin(NotificationPlugin.class);

        super.onCreate(savedInstanceState);

        // L7: 알림 탭으로 앱이 열린 경우 alarmId를 보관 — WebView 로드 후 JS로 전달
        String alarmId = getIntent() != null ? getIntent().getStringExtra("alarmId") : null;
        if (alarmId != null) {
            final String id = alarmId;
            // 브리지 초기화를 기다려 이벤트 전달 (약간의 지연 후 전송)
            getBridge().getWebView().postDelayed(
                    () -> emitNativeEvent("ALARM_TRIGGERED", "알림에서 열기", id), 1500);
        }

        // WebView 디버깅은 디버그 빌드에서만 허용
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);

        // 쿠키 수용 (세션 유지용)
        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);

        // WebView 세부 설정 (Capacitor의 BridgeWebViewClient/WebChromeClient는 덮어쓰지 않음 —
        // 덮어쓰면 JS ↔ 네이티브 브리지가 파괴 되어 모든 플러그인 호출이 실패함)
        applyWebViewSettings();
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

    @Override
    public void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        // L7: singleTask이므로 백그라운드 복귀(onNewIntent) 경로의 알림 탭도 처리
        if (intent != null && intent.getStringExtra("alarmId") != null) {
            emitNativeEvent("ALARM_TRIGGERED", "알림에서 열기", intent.getStringExtra("alarmId"));
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
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
    }
}
