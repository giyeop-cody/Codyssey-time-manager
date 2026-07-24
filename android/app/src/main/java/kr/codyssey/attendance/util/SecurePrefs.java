package kr.codyssey.attendance.util;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 48차 (V-4): AndroidKeyStore 기반 문자열 암호화 — 세션 쿠키 등 평문 영속화 제거.
 *
 * - 접두사 ENCv1: 가 붙은 값만 암호문, 없으면 레거시 평문으로 간주(읽기 호환)
 * - 쓰기는 항상 암호화 → 기존 평문 값은 첫 쓰기 때 자동 마이그레이션
 * - 키는 AndroidKeyStore에 생성·보관되어 앱 외부로 추출되지 않음
 * - 복호화 실패(키 소실·값 위변조) 시 null 반환 → 호출부는 "백업 없음"으로 처리
 */
public final class SecurePrefs {

    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "codyssey_store_aes";
    private static final String PREFIX = "ENCv1:";
    private static final int GCM_TAG_BITS = 128;
    private static final int GCM_IV_BYTES = 12;

    private SecurePrefs() { }

    /** 평문 → ENCv1:&lt;base64(iv+ct)&gt;. 키스토어 장애 시 평문 그대로 반환(기능 우선). */
    public static String encrypt(String plain) {
        if (plain == null) return null;
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[iv.length + ct.length];
            System.arraycopy(iv, 0, out, 0, iv.length);
            System.arraycopy(ct, 0, out, iv.length, ct.length);
            return PREFIX + Base64.encodeToString(out, Base64.NO_WRAP);
        } catch (Exception e) {
            return plain; // 암호화 불가 단말(드묾) — 다음 저장 때 재시도
        }
    }

    /** ENCv1: 값은 복호화, 접두사 없는 값은 레거시 평문으로 그대로 반환. 복호화 실패 시 null. */
    public static String decrypt(String stored) {
        if (stored == null || !stored.startsWith(PREFIX)) return stored; // 레거시 평문 패스스루
        try {
            byte[] raw = Base64.decode(stored.substring(PREFIX.length()), Base64.NO_WRAP);
            if (raw.length <= GCM_IV_BYTES) return null;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(),
                    new GCMParameterSpec(GCM_TAG_BITS, raw, 0, GCM_IV_BYTES));
            byte[] pt = cipher.doFinal(raw, GCM_IV_BYTES, raw.length - GCM_IV_BYTES);
            return new String(pt, StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null; // 위변조·키 소실 → 백업 없음으로 처리(세션 재로그인 유도)
        }
    }

    public static boolean isEncrypted(String stored) {
        return stored != null && stored.startsWith(PREFIX);
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);
        kg.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return kg.generateKey();
    }
}
