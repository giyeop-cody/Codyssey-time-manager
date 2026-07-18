# Codyssey Time Manager

크래프톤 정글(코디세이) 출입 시간 관리 — 크롬 익스텐션 + Capacitor 안드로이드 앱.

## 리포지토리 구조 (중요: 유일 원본 규칙)

- **`web/`** — 확장/앱 공통 소스. **유일한 원본.** 여기만 수정한다.
- `android/app/src/main/assets/public/` — `npx cap sync android`의 생성물. **커밋 금지** (.gitignore 등록, CI 가드가 차단).
- `android/app/src/main/assets/capacitor.config.json`, `capacitor.plugins.json` — cap 설정 파일로 리포에 포함 (web/와 무관).
- `tests/`, `sandbox/` — JS 단위/e2e 테스트
- `scripts/` — check-js(문법), build-sandbox, check-phy(판정 상수 미러 검증, N31-12)
- `docs/` — 베타 수집 가이드 등 이용자 문서

## 로컬 빌드 (안드로이드)

```bash
npm ci                      # 의존성 설치
npm run check:js            # JS 문법 검사
npm run check:phy           # 네이티브↔JS 판정 상수 일치 검사
npm run test:js             # 단위 테스트
npx cap sync android        # web/ → android/assets/public 복사 (필수 — 리포에는 없음)
cd android && ./gradlew assembleDebug   # app-debug.apk 생성
```

> 주의: `npx cap sync android` 없이 바로 gradle을 돌리면 assets/public이 없어 빌드가 실패한다.

## CI/CD (GitHub Actions)

- `main` 푸시/PR: JS 검사 → cap sync → 디버그 APK 빌드 → 아티팩트 2건(APK, 익스텐션 ZIP)
- 태그 `v*` 푸시: 위 + AAB 빌드 + GitHub Release 자동 생성 (APK·AAB·ZIP 3종 첨부)

배포 요령: `git tag v1.x.y && git push origin v1.x.y`

## 주요 동작

- 백그라운드 감지: 5분 정확 알람 틱 체인(주) + WorkManager 15분(백업)
- 자정 롤오버: 미퇴실 세션을 임시 처리하고 밤샘/퇴실 누락 확인 (29차)
- 물리 탐지(베타): 연결 Wi-Fi·기지국·지오펜스로 입/퇴실 누락 의심 알림 + 수집 모드 (31~32차, `docs/beta-phy-collection.md`)
