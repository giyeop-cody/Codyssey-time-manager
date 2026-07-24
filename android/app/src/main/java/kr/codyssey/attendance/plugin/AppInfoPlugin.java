package kr.codyssey.attendance.plugin;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.security.MessageDigest;

/**
 * 48차 (P-6): 앱 버전 + 설치 서명 지문을 JS로 제공.
 * 설정 '앱 정보'에서 공식 배포 서명(shared-attendance EXPECTED_APK_SIGNATURE_SHA256)과
 * 비교해 비공식 설치본(재서명·모조 APK)을 사용자가 스스로 식별할 수 있게 한다.
 */
@CapacitorPlugin(name = "AppInfo")
public class AppInfoPlugin extends Plugin {

    @PluginMethod
    public void getInfo(PluginCall call) {
        try {
            Context ctx = getContext();
            PackageManager pm = ctx.getPackageManager();
            PackageInfo pi;
            if (Build.VERSION.SDK_INT >= 33) {
                pi = pm.getPackageInfo(ctx.getPackageName(),
                        PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES));
            } else {
                // noinspection deprecation
                pi = pm.getPackageInfo(ctx.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
            }

            JSObject out = new JSObject();
            out.put("versionName", pi.versionName);
            out.put("packageName", ctx.getPackageName());

            String fp = "";
            Signature[] sigs = null;
            if (Build.VERSION.SDK_INT >= 28 && pi.signingInfo != null) {
                sigs = pi.signingInfo.hasMultipleSigners()
                        ? pi.signingInfo.getApkContentsSigners()
                        : pi.signingInfo.getSigningCertificateHistory();
            }
            if ((sigs == null || sigs.length == 0) && pi.signatures != null) {
                // noinspection deprecation
                sigs = pi.signatures;
            }
            if (sigs != null && sigs.length > 0) {
                fp = sha256Colon(sigs[0].toByteArray());
            }
            out.put("signatureSha256", fp);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("app info failed: " + (e.getMessage() != null ? e.getMessage() : "unknown"));
        }
    }

    private static String sha256Colon(byte[] cert) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(cert);
        StringBuilder sb = new StringBuilder(d.length * 3 - 1);
        for (int i = 0; i < d.length; i++) {
            if (i > 0) sb.append(':');
            sb.append(String.format("%02X", d[i]));
        }
        return sb.toString();
    }
}
