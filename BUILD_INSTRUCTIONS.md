# 코디세이 출입 현황 알리미 - Android APK 빌드 가이드

## 📦 빌드 패키지
- **파일**: `codyssey-capacitor-build.tar.gz` (1.8MB)
- **위치**: `/home/user/codyssey-capacitor-build.tar.gz`

---

## 🖥️ 로컬 빌드 환경 요구사항

| 도구 | 버전 | 설치 방법 |
|------|------|-----------|
| **JDK** | 17 (필수) | `brew install openjdk@17` (Mac) / `sudo apt install openjdk-17-jdk` (Ubuntu) |
| **Android Studio** | 최신 | https://developer.android.com/studio |
| **Gradle** | wrapper 사용 | 프로젝트에 포함됨 |

---

## 🚀 빌드 단계

### 1. 패키지 압축 해제
```bash
tar -xzf codyssey-capacitor-build.tar.gz
cd codyssey-capacitor
```

### 2. Android Studio에서 열기 (권장)
```bash
# Android Studio 실행 후
# File → Open → codyssey-capacitor/android 폴더 선택
# Gradle 동기화 완료 대기 (자동으로 wrapper 생성 및 의존성 다운로드)
```

### 3. APK 빌드

#### 방법 A: Android Studio GUI (초보자 권장)
1. **Build** → **Build Bundle(s) / APK(s)** → **Build APK(s)**
2. 완료 시 우측 하단 알림 클릭 → **locate** → `app/build/outputs/apk/debug/app-debug.apk`

#### 방법 B: 명령줄 (CI/CD용)
```bash
cd android
./gradlew assembleDebug
# 출력: app/build/outputs/apk/debug/app-debug.apk
```

#### 방법 C: 릴리즈 빌드 (Play Store용)
```bash
# keystore 생성 (최초 1회)
keytool -genkey -v -keystore keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias codyssey

# gradle.properties에 서명 설정 추가 후
./gradlew bundleRelease
# 출력: app/build/outputs/bundle/release/app-release.aab
```

---

## ⚙️ 서명 설정 (릴리즈용)

`android/app/build.gradle`에 추가:
```gradle
android {
    signingConfigs {
        release {
            storeFile file("keystore.jks")
            storePassword "store_password"
            keyAlias "codyssey"
            keyPassword "key_password"
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            minifyEnabled true
            proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
        }
    }
}
```

---

## 🔧 주요 기능 체크리스트 (빌드 후 확인)

| 기능 | 테스트 방법 |
|------|-------------|
| **자동 로그인 감지** | codyssey.kr 로그인 후 앱 실행 → 바로 대시보드 표시 |
| **실시간 인정 시간** | 입실 중일 때 '오늘 실시간 인정' 1초마다 증가 |
| **캘린더 과거 달** | ◀ ▶ 버튼으로 월 이동 → 해당 월 기록 로딩 |
| **퇴실/목표 토글** | 스위치로 모드 전환 + 입력 박스 표시 |
| **알람 설정/해제** | 계산 후 '알람 설정' → 알림 수신 확인 |
| **로그인 유지** | 25~28분마다 백그라운드 핑 → 세션 유지 |
| **백그라운드 동기화** | 앱 종료 후 30분마다 WorkManager 동기화 |
| **부팅 시 자동 시작** | 재부팅 후 알람/동기화 자동 재등록 |

---

## 🐛 트러블슈팅

| 문제 | 해결 |
|------|------|
| **Gradle sync 실패** | File → Invalidate Caches / Restart |
| **Java 17 필요 에러** | JDK 17 설치 및 JAVA_HOME 설정 |
| **TLS 핸드셰이크 실패** | gradle.properties에 TLS 설정 추가 (이미 포함됨) |
| **SDK 라이선스 미동의** | `sdkmanager --licenses` 실행 후 y 입력 |
| **에뮬레이터에서 네트워크 안됨** | `10.0.2.2` 대신 실제 IP 사용 또는 실제 기기 테스트 |

---

## 📱 테스트 권장사항

1. **실제 기기 테스트 필수** (에뮬레이터에서 네트워크/알림 제한 있음)
2. **코디세이 로그인 상태에서** 앱 실행
3. **알림 권한 허용** 필수 (Android 13+ 런타임 권한)
4. **배터리 최적화 해제** 필요 (백그라운드 동기화용)

---

## 📂 출력 파일 위치

| 빌드 타입 | 경로 |
|-----------|------|
| **Debug APK** | `android/app/build/outputs/apk/debug/app-debug.apk` |
| **Release AAB** | `android/app/build/outputs/bundle/release/app-release.aab` |
| **Release APK** | `android/app/build/outputs/apk/release/app-release.apk` |

---

## 📞 지원

빌드 관련 문의사항이 있으면 프로젝트 이슈로 등록해주세요.

---

> **참고**: 이 프로젝트는 Capacitor v6 + Android Gradle Plugin 7.4.2 + JDK 17 기반으로 구성되어 있습니다. sandbox 환경의 네트워크/자바 버전 제약으로 로컬 빌드가 필수입니다.