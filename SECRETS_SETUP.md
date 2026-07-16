# GitHub Repository Secrets 설정 가이드

## 📋 릴리즈 빌드용 필수 시크릿 (Settings → Secrets and variables → Actions)

| 시크릿명 | 값 | 설명 |
|----------|-----|------|
| `KEYSTORE_BASE64` | `base64 -w0 keystore.jks` 출력값 | 키스토어 파일 Base64 인코딩 |
| `STORE_PASSWORD` | 키스토어 스토어 비밀번호 | 키스토어 생성 시 설정한 비밀번호 |
| `KEY_PASSWORD` | 키 비밀번호 | 키 생성 시 설정한 비밀번호 |
| `KEY_ALIAS` | 키 별칭 (예: `codyssey`) | `keytool -genkey` 시 `-alias` 값 |

---

## 🔐 키스토어 생성 방법 (최초 1회)

```bash
# 키스토어 생성
keytool -genkey -v -keystore keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias codyssey

# Base64 인코딩 (GitHub Secrets에 넣을 값)
base64 -w0 keystore.jks
# 출력 예: U0tPQVNFUlRf...
```

---

## ⚙️ GitHub Secrets 등록 방법

1. GitHub 저장소 → **Settings** 탭
2. 좌측 메뉴 **Secrets and variables** → **Actions**
3. **New repository secret** 클릭 → 4개 모두 등록

| Name | Secret |
|------|--------|
| `KEYSTORE_BASE64` | base64 인코딩된 키스토어 |
| `STORE_PASSWORD` | 스토어 비밀번호 |
| `KEY_PASSWORD` | 키 비밀번호 |
| `KEY_ALIAS` | `codyssey` |

---

## 🚀 릴리즈 빌드 트리거

```bash
# 버전 태그 생성 후 푸시
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

자동으로:
1. Release AAB 빌드 (`bundleRelease`)
2. GitHub Release 생성
3. AAB 파일을 Release Assets에 첨부

---

## 🔧 로컬에서 키스토어 설정 (개발용)

```bash
# android/app/build.gradle에 추가 (이미 설정됨)
android {
    signingConfigs {
        release {
            storeFile file("keystore.jks")
            storePassword "STORE_PASSWORD"
            keyAlias "KEY_ALIAS"
            keyPassword "KEY_PASSWORD"
        }
    }
}
```

> **주의**: 로컬 개발 시 `keystore.jks` 파일을 `android/app/` 폴더에 복사해야 함