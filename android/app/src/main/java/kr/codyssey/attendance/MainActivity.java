package kr.codyssey.attendance;

import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import kr.codyssey.attendance.plugin.AlarmPlugin;
import kr.codyssey.attendance.plugin.NetworkPlugin;
import kr.codyssey.attendance.plugin.NotificationPlugin;
import kr.codyssey.attendance.plugin.StoragePlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 커스텀 Capacitor 플러그인 등록 (반드시 super.onCreate 전에 호출)
        registerPlugin(NetworkPlugin.class);
        registerPlugin(StoragePlugin.class);
        registerPlugin(AlarmPlugin.class);
        registerPlugin(NotificationPlugin.class);

        super.onCreate(savedInstanceState);

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
    public void onPause() {
        super.onPause();
        // 세션 쿠키 영속화 (브리지 클라이언트를 교체하지 않고도 쿠키 플러시)
        CookieManager.getInstance().flush();
    }
}
