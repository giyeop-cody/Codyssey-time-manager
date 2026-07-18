# Codyssey Time Manager

코디세이(크래프톤 정글) **출입 시간 관리** — 크롬 익스텐션 + Capacitor 안드로이드 앱.
월 필수 출입 시간(기본 80시간)·일 최대 인정 시간(12시간)을 실시간으로 계산해 보여주고,
퇴실/목표 알람·입퇴실 누락 감지·평가 일정 알림까지 자동화한다.

| 항목 | 내용 |
|---|---|
| 최신 버전 | **v1.8.2** (2026-07-19) |
| 플랫폼 | Android 앱 (minSdk 23 / targetSdk 34, Capacitor), Chrome 익스텐션 (MV3) |
| 서버 | `api.usr.codyssey.kr` (공식 프론트와 동일 API) |
| 저장 방식 | 전부 기기 안(온디바이스) — 자체 서버/분석 툴 없음 |

---

## 1. 기획 (왜 만들었고, 뭘 해결하나)

### 배경
코디세이는 **월 필수 출입 시간**이 있고, 서버는 **하루 최대 12시간까지만** 출입으로 인정한다.
하지만 공식 페이지는 "지금 얼마나 채웠는지", "몇 시에 나가야 목표인지"를 알려주지 않는다.
또 태그를 찍는 걸 잊으면 그 시간이 통째로 날아간다.

### 문제 → 기능 매핑
| 문제 | 기능 |
|---|---|
| 이번 달 얼마나 채웠는지 모름 | 대시보드: 오늘 인정·월 누적·월 잔여(진행률 바), 월간 캘린더 |
| 몇 시에 퇴실해야 오늘 목표인지 모름 | **계산기**: 퇴실 시간→인정 시간 계산 / 목표 시간→예상 퇴실 시각 계산 + 알람 자동 등록 |
| 퇴실 태그 찍는 걸 깜빡함 (12시간 초과분 증발) | 퇴실/목표 **정확 알람**(소리+알림), 게이트 이벤트 감지 알림, 자정 롤오버 시 밤샘/누락 확인 |
| 입·퇴실 처리가 됐는지 매번 확인 귀찮음 | **게이트 감지**: 서버 세션이 열리고 닫힐 때 "입실 처리됨/퇴실 처리됨" 알림 |
| 시험(평가) 일정을 놓침 | **평가 일정 자동 연동**: 서버 평가 목록을 긁어 N분 전 알람 자동 등록 (기본 30분 전) |
| 앱을 꺼도 감지하고 싶음 | 네이티브 **5분 틱** + WorkManager 백업 — WebView를 닫아도 계산·알림 지속 |
| 태그 누락을 습관적으로 놓침 | **물리 탐지(베타)**: Wi-Fi·기지국·지오펜스로 "학원에 있는데 세션이 없음"을 의심 알림 |

### 설계 원칙
1. **프라이버시 우선** — 계정·위치·Wi-Fi 정보는 전부 기기 안에서만 처리. 외부 전송은 공식 API 호출뿐이며, 수집(베타)도 사용자가 직접 공유할 때만.
2. **단일 소스** — 출입 계산 로직은 `web/js/shared-attendance.js` 한 곳에. 익스텐션·앱·테스트·샌드박스가 같은 파일을 쓴다.
3. **네이티브 권위** — 백그라운드 판정(틱·알람·물리 탐지)은 WebView가 죽어도 살아 있어야 해서 네이티브가 권위. JS는 UI/보조.
4. **경계에서만 조용해지기** — 알림이 필요한 순간(목표 달성 직전, 처리 누락)엔 확실하게, 그 외엔 침묵.

---

## 2. 코드 구조

```
Codyssey-time-manager/
├── web/                      ← 유일 원본 (익스텐션 그대로 = 앱 WebView 내용물)
│   ├── manifest.json           확장 선언 (MV3, service_worker module)
│   ├── popup.html / popup.js / css/popup.css   메인 UI (대시보드·계산기·설정)
│   ├── calendar.html / js/calendar.js          독립 캘린더 페이지 (팝업 미니 캘린더와는 별개, 직접 진입 링크는 없음)
│   ├── js/shared-attendance.js 출입 계산 단일 소스 (순수 함수 위주, 직접 테스트됨)
│   ├── js/background.js        익스텐션 서비스 워커 (동기화·게이트·평가·알림)
│   ├── js/capacitor-adapter.js 앱용 API 브리지 (chrome.* 호환 → Capacitor 플러그인)
│   ├── js/content.js           코디세이 페이지에서 memberId 감지
│   └── js/index-redirect.js    앱 시작 시 popup으로 이동
├── android/app/src/main/java/kr/codyssey/attendance/
│   ├── MainActivity.java       WebView 호스트 (설정 화면·권한·플러그인 등록)
│   ├── plugin/                 AlarmPlugin(RTC_WAKEUP 정확 알람), NetworkPlugin(네이티브 HTTP),
│   │                           PollingPlugin(WorkManager 등록), PhyPlugin(물리 탐지 JS↔네이티브)
│   ├── receiver/               SyncTickReceiver(5분 틱 본체), BootReceiver(부팅 복구),
│   │                           GeofenceReceiver, ActivityReceiver, AlarmReceiver
│   ├── service/AlarmSoundService  알람음 FGS (USAGE_ALARM, 최대 60초, 탭/끄기로 해제)
│   ├── util/                   SyncTasks(틱 작업 오케스트라), GateCheck(게이트/스냅샷/롤오버),
│   │                           EvalSync(평가 동기화), PhysicalCheck(물리 판정 authoritative),
│   │                           PhyGeofence, CookieManager(세션 저장), DiagLog(링버퍼 80),
│   │                           NotificationHelper
│   └── worker/                 SyncWorker(15분 백업), AlarmWorker
├── tests/attendance.test.mjs   단위 테스트 98건 (node --test)
├── sandbox/                    로컬 서버+하니스 e2e 29건 (리얼 HTTP 시뮬레이션)
├── scripts/                    check-js(문법) · check-phy(네이티브↔JS 상수 미러 검증) · build-sandbox
└── docs/beta-phy-collection.md 베타 수집 가이드
```

**유일 원본 규칙**: `android/app/src/main/assets/public/`은 `npx cap sync` 생성물로 **커밋 금지**(CI 가드가 차단). web/만 수정한다.

---

## 3. 구현 내용

### 3-1. 데이터 흐름
1. **로그인**: 사용자가 입력한 코디세이 계정으로 직접 로그인 → 세션 쿠키 취득 (익스텐션: chrome.storage / 앱: Preferences+CookieManager에 계정·쿠키 보관, 모두 기기 내부)
2. **memberId 확정**: content script가 코디세이 페이지에서 감지하거나 `/rest/user/info/detail`로 조회
3. **출입 기록**: `/rest/secom/detail?mbrId&year&month` → 세션 배열(raw)
4. **계산**: `shared-attendance.parseAttendance` — 오늘 인정·월 누적·입실 중 여부 산출
   - 규칙: 일 12시간 상한(서버 고정), 개방(미퇴실) 세션은 **입실 후 13시간**까지가 유효 한도(그 이상은 낡은 기록으로 제외), 자정 넘김 세션은 전월/당월 양쪽에 배분
5. **표시**: 팝업 대시보드·미니 캘린더(오늘은 실시간 값), 계산기에서 즉시 사용
6. **감지**: 5분 틱에서 게이트 변화·자정 롤오버·평가·물리 판정을 네이티브가 수행

### 3-2. 백그라운드 감지 (앱)
- **5분 정확 틱**: `SyncTickReceiver`(TICK_MS=5분, AlarmManager 체인) → `SyncTasks` 실행. **WorkManager 15분**은 틱이 죽었을 때 백업.
- 틱이 하는 일: ① 게이트 감지(세션 열림/닫힘 변화 → 알림) ② `gate_snapshot_{memberId}` 갱신(신선도 30분) ③ **자정 롤오버**: 어제 미퇴실 세션 확인(밤샘/퇴실 누락 선택 → 물리 근거 문구 첨부) ④ 평가 동기화 ⑤ 물리 탐지 판정 ⑥ 로그인 유지(선택 시)
- 게이트 OFF + 물리 ON 조합이면 최소 틱만 유지(스냅샷·롤오버는 계속) — 32차 phyOn 게이트.
- 부팅 시 `BootReceiver`가 틱·지오펜스 복구.

### 3-3. 알람 파이프라인
- 계산기 "계산" 시 알람 **자동 등록**(종료 시각 기준, '해제' 또는 알람 목록에서 삭제 가능).
- `buildAlarmName(memberId, type, endMinutes)` 규격으로 명명 → 24시간이 넘으면 "N일 후 HH:MM" 표기.
- 발화: `AlarmPlugin`(RTC_WAKEUP 정확) → `AlarmReceiver` → `AlarmSoundService`(mediaPlayback FGS, 최대 60초, 만료/스킵·탭으로 해제) + 채널 `codyssey_alarms`(CATEGORY_ALARM).
  - 15분 이상 지연 발화한 알람은 표시하지 않음(stale 방지).

### 3-4. 평가 일정 자동 연동 (E2)
- `/schedule/scheduleAllList/` 목록 + 공지 신규 알림을 주기적으로 긁어 기관(instCd) 평가를 골라낸다.
- 일시 변경·신규는 알람 교체, 확정(닫힘)은 유지, 취소는 삭제. 기본 30분 전(설정 변경 가능).
- 네이티브 `EvalSync`와 JS가 `eval_sync_state` 키를 공유해 중복 동기화 없음.
- 평가 공지 텍스트에서 일시를 파싱(공지에만 있고 목록에 없는 신규 평가 대응).

### 3-5. 물리 탐지 (베타) — `PhysicalCheck.java`(권위) + JS 미러(상수 동일, check:phy 가드)
- **신호**: 연결 Wi-Fi SSID(가중 2)·BSSID(3)·기지국 Cell(1) — 자동 학습: 서버가 세션 열림을 확인한 순간의 신호를 상한 300건까지 축적.
- **판정**: 점수 ≥ 3 → "학원 안" 후보, 연속 2틱 일치(히스테리시스), 점수 상한 6. 학습 데이터 없거나 신호 무(비행기모드)면 **판정 보류**.
- **의심 알림 (하루 1회 각)**:
  - S1 — 세션 닫힘 + 학원 신호 → "입실 처리 확인 필요 🚪"
  - S2 — 세션 열림 + 학원 밖 → "퇴실 처리 확인 필요 🚗"
- **지오펜스**: 학습 좌표 반경 150m 진입/이탈 시 즉시 재판정 (반응 수십 초). 힌트 TTL 6시간·재등록 6시간 스로틀·포그라운드 스캔 30분 스로틀(32차).
- **수집 모드**: 틱 샘플(시각·신호·세션·판정·활동)을 폰 내부 링버퍼(최대 1200건)에만 저장 → "내보낼 때만" FileProvider 공유. 자동 전송 없음. (자세한 건 `docs/beta-phy-collection.md`)
- 목표: 테스터 JSON을 취합해 공식 시드를 앱에 내장(N31-1, 대기 중).

### 3-6. 보안·프라이버시 구현 항목
- 캐시·스냅샷 키는 **memberId 포함** — 계정 전환 시 타인 데이터 격리; 로그아웃 시 정체성·스냅샷 정리 + keep-alive 자동 OFF.
- `allowBackup="false"`, 자체 수신기 `exported=false`, WebView는 codyssey 허용 도메인만 로드.
- 위치/Wi-Fi/기지국 정보는 외부 전송 경로 없음(판정 전용). DiagLog(최근 80건)도 폰 내부에만.

### 3-7. 핵심 상수 (변경 시 네이티브/JS/테스트 함께)
| 상수 | 값 | 위치 |
|---|---|---|
| 월 필수 / 일 최대 (기본 설정) | 80h / 12h | background.js, capacitor-adapter.js 기본값 |
| 서버 일 상한 | 12h 고정 | SERVER_DAILY_CAP_MINUTES |
| 개방 세션 유효 한도 | 13h | MAX_OPEN_SESSION_MS |
| 틱 / 스냅샷 신선도 | 5분 / 30분 | SyncTickReceiver / GateCheck |
| 물리 가중·임계·캡·스트릭 | 2·3·1 / 3 / 6 / 2 | PhysicalCheck ↔ shared(PHY_ 접두, check:phy) |
| 지오펜스 | 반경 150m, 힌트·등록 TTL 6h | PhyGeofence/PhysicalCheck |
| 알람 stale / 알람음 | 15분 / 최대 60초 | ALARM_STALE_WINDOW_MS / AlarmSoundService |
| 평가 리드 기본 / 새로고침 기본 | 30분 / 30분 | 설정 기본값 |

### 3-8. CI/CD
- `main` 푸시: check:js → D2(assets 미커밋 가드) → check:phy → 단위 → cap sync → assembleDebug → 아티팩트(APK+ZIP)
- 태그 `v*`: 위 + AAB + **GitHub Release 자동 생성(APK·AAB·ZIP 첨부)**
- AAB는 키스토어 secrets 미등록이라 현재 무서명(N28-1). 실제 배포/업데이트 설치는 디버그 키 APK 사용.

---

## 4. 사용자 사용법

### 4-A. 안드로이드 앱 (권장 — 백그라운드 자동 감지)

1. **설치**: Releases → `app-debug.apk` 다운로드 → 설치 (출처 불명 허용 필요). 기존 설치본은 같은 키라 **그대로 덮어쓰기** 가능.
2. **첫 실행 → 로그인**: 코디세이 이메일/비밀번호 입력 (앱 안에만 저장).
3. **권한 체크리스트** (설정 화면에서 바로 이동 가능):
   | 권한 | 왜 필요 | 없으면 |
   |---|---|---|
   | 알림 (Android 13+) | 모든 알림 | 무음 |
   | 정확한 알람 | 퇴실/목표 알람 정시 발화 | 몇 분 늦거나 누락 |
   | 배터리 최적화 예외 | 5분 틱 생존 | 절전 시 감지 멈춤 |
   | 위치 (사용 중) | 물리 탐지(Wi-Fi·셀 판정) | 근처 감지 불가 |
   | 위치 **항상 허용** | 지오펜스(백그라운드 즉시 감지) | 근처 감지만 가능(틱 주기 지연) |
   | 근처 Wi-Fi 기기 | SSID/BSSID 읽기 | 근처 감지 불가 |
   | 신체 활동 | 정지/걷기 보조 | 무시됨(선택) |
   ※ "항상 허용"은 Android 11+서 앱 내에서 직접 못 켭니다: 시스템 **설정 → 애플리케이션 → 출입알리미 → 권한 → 위치 → 항상 허용**.
4. **물리 탐지 온볼딩(베타)**: 설정 → 물리 탐지(베타) → "학원 근처 감지" 켬 → 권한 허용 → **학원에 있는 상태로** "지금 위치를 학원으로 학습" 1회 → 이후 자동. 2~3일 쓰다가 S1/S2 알림이 오면 확인 버튼으로 응답.

### 4-B. 크롬 익스텐션 (PC)

1. Releases → `codyssey-extension.zip` 다운로드 → 압축 해제.
2. `chrome://extensions` → 우상 **개발자 모드** 켬 → **"압축해제된 확장 프로그램 로드"** → 해제한 폴더 선택.
3. 툴바 아이콘 클릭 → 로그인. (백그라운드 감지는 익스텐션에선 미지원 — 브라우저가 떠 있을 때만 갱신)

### 4-C. 화면 설명 (공통)

| 영역 | 보이는 것 | 할 수 있는 것 |
|---|---|---|
| 상단 상태 카드 | 오늘 인정 시간 · 월 누적/목표(80h 기본) 진행률 · 현재 입실 중 여부 | 헤더 💓 로그인 유지 빠른 토글 · 🔄 즉시 갱신 · ⚙️ 설정 |
| 월간 캘린더 | 일별 인정 시간, 오늘은 실시간 반영 | 지난달/다음달 이동 |
| 계산기 | 퇴실 예정→총 인정(일 잔여·월 잔여·12h 초과 경고) / 목표→예상 퇴실 시각 | 모드는 상단 **카드 두 개 중 탭**(서로 전환). 계산 시 알람 자동 등록, "알람 해제"로 취소 |
| 평가 알람 | 연동된 평가 일정 + 알람 시점 | 📥 즉시 동기화 버튼 |
| 활성 알람 | 대기 중 알람 목록 | 개별 삭제 |
| 자정 경고 배너 | "밤샘? 퇴실 누락?" (미퇴실 발견 시) | 밤샘=유지 / 퇴실 누락=어제 퇴실로 처리 |
| 물리 탐지 알림 | "입실/퇴실 처리 확인 필요" (의심 시 하루 1회) | 바로 처리 안내 |

### 4-D. 설정 항목 (⚙️)

- **목표 시간**: 월 필수(기본 80h) · **일 최대**(기본 12h, 서버 상한 이내에서만 의미 있음)
- **알림**: 브라우저 알림 켬 · 소리 켬 · 입·퇴실 처리 알림 · 평가 알림 기본 시점(분 전) · 평가 자동 연동 · 기관 코드(instCd — 보통 자동, 필요 시 수동)
- **자동 새로고침**: 켬/주기(기본 30분)
- **로그인 유지**: 세션이 풀려도 계정으로 재로그인 (opt-in — 보안상 기본 OFF)
- **백그라운드 감지**(앱): 켬 · 절전모드 예외 이동 · 정확한 알람 권한 이동
- **물리 탐지(베타)**: 근처 감지 · 수집 모드(기본 켬, OFF 가능) · 지오펜스 · 지금 위치 학습 · 수집 데이터 내보내기(공유 시트로 JSON 전달)

### 4-E. 자주 묻는 문제

| 증상 | 확인 |
|---|---|
| 알람이 안 울림 | 알림 권한 → 정확한 알람 권한 → 배터리 최적화 예외 순서로 켜기. 채널 `codyssey_alarms`가 음소거면 해제 |
| 물리 탐지 알림이 안 옴 | 근처 감지 켬 + 학습 1회(학원에서) + 위치 권한. 지오펜스까지는 "항상 허용" 필요 |
| "입실 중"이 이상함 | 서버에 퇴실 태그가 빠진 것 — 태그하고 갱신, 또는 다음 날 배너에서 처리 |
| 로그인이 풀림 | 비밀번호 변경/세션 만료 시 재로그인. 자주면 로그인 유지(opt-in) 검토 |
| 수치가 안 맞음 | 🔄 갱신. 서버 집계와 5분 캐시 차이가 날 수 있음 |
| 앱 삭제 전 | 알람/설정은 기기 안 정보 — 재설치 후 로그인·학습부터 다시 |

---

## 5. 개발자용 요약

```bash
npm ci                   # 설치
npm run check:js         # 문법
npm run check:phy        # 네이티브↔JS 판정 상수 미러 검사
npm run test:js          # 단위 98건
node sandbox/test_relay_e2e.mjs   # e2e 29건 (로컬 릴레이 서버 대역)
npx cap sync android && cd android && ./gradlew assembleDebug   # APK
git tag v1.x.y && git push origin v1.x.y   # CI가 Release 자동 생성
```

- 로그인·세션 저장소는 기기 한정이며 PR/커밋에 실계정·PAT 포함 금지.
- 판정 상수를 바꿀 땐 `PhysicalCheck.java`와 `web/js/shared-attendance.js` 양쪽 + `tests/` 보강 (check:phy가 CI에서 차단해 줌).
- 진단 로그: 로그인 화면의 "최근 세션 진단" 영역(진단 로그 복사 버튼 포함), 태그 `GATE/EVAL/PHY/SVC/LOGIN/ALARM/NOTIF` 등 최근 80건.
