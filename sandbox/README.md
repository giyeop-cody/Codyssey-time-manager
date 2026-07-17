# 팝업 샌드박스·중계 서버

`web/popup.html` + `web/js/popup.js`를 브라우저에서 직접 실행하는 두 가지 경로를 제공합니다.

| 경로 | 백엔드 | 데이터 | 용도 |
|---|---|---|---|
| **중계 서버** `relay_server.py` | 파이썬(표준라이브러리만) | **실제 코디세이** | 진짜 동작 확인·실데이터 QA |
| **모의 샌드박스** `popup-sandbox.html` | 없음(모의 대역) | 픽스처 | 네트워크 없이 UI 로직만 확인 |

---

## 1. 중계 서버 (진짜 동작)

```bash
python sandbox/relay_server.py            # 표시된 주소(기본 http://localhost:8787)를 브라우저에서 열기
python sandbox/relay_server.py --save-session   # 세션 쿠키를 로컬 파일에 저장 (재시작핻 캐시 유지)
```

- 첫 화면에서 **실제 코디세이 계정으로 로그인** → 대시보드·캘린더·알람·설정 전부 실데이터
- 알람은 **중계 서버 내 타이머**가 시간에 맞춰 발화 → 브라우저 Notification(권한 허용 시)/토스트로 전달 — 서버가 살아있는 동안 팝업을 닫아도 발화됨
- 입·퇴실 감지(G1)·평가 일정 자동 동기(E2)도 동작 (팝업을 열어두면 조회 시 감지/동기 수행)
- 상태(`relay_kv.json`)와 세션(선택 시 `relay_cookies.txt`)은 로컬 파일 — **자격 정보 포함이라 커밋 금지** (.gitignore 등록됨)

### 주의
- **로컬 전용**입니다. 세션 쿠키가 곧 계정 권한이므로 `--host 0.0.0.0` 외부 노출·배포 금지
- 비밀번호는 로그인 요청 순간에만 전달되고 파일/로그에 저장되지 않음
- 중계 서버는 background.js의 **축소 이식**(메시지 라우팅·알람 엔진·캐시·프록시) — 크롬 확장/안드로이드 앱 배포 경로와 별개의 개발용 도구

### 구조
```
브라우저 탭 (popup.html + relay_harness.js)
  ├─ /msg  → chrome.runtime.sendMessage 대역 (GET_STATUS·알람·설정…)
  ├─ /native/* → 로그인 중계 (CORS 우회)
  ├─ /kv   → 설정·스냅샷·평가 동기 상태 저장
  └─ /events → 서버측 알람 발화 폭
       ↓
sandbox/relay_server.py (파이썬 중계)
  ├─ api.ams.codyssey.kr 로그인 + 쿠키 관리
  ├─ api.usr.codyssey.kr 출입/멤버 프록시 (5분 캐시)
  ├─ codyssey.kr 평가 일정 프록시
  └─ 알람 스케줄러 (3초 주기 발화 → 이벤트 큐)
```

---

## 2. 모의 샌드박스 (`popup-sandbox.html`)

**실제 서버·네트워크 없이** UI만 확인하는 단일 파일 — 브라우저나 워크스페이스 미리보기에서 바로 실행.

### 제어 패널 (페이지 상단)
| 버튼 | 동작 |
|---|---|
| 입실⇄퇴실 전환 | 모의 게이트 상태 전환 (앱 내 ⟳ 버튼으로 반영 확인) |
| 데모 알람 2건 채우기 | 퇴실 45분 뒤 / 목표 120분 뒤 알람 추가 |
| 자동 평가 감지 시뮬 | `codyssey_eval_auto_` 형태의 평가 알람 1건 + 감지 알림(토스트) |
| 가장 빠른 알람 즉시 발화 | 발화 시 목록 자동 제거 + ALARM_TRIGGERED 자동 갱신 경로 확인 |
| 세션 만료 / 복원 | NOT_LOGGED_IN 흐름(로그인 화면) 확인, 로그인은 모의 인증으로 통과 |

### 제약
- 백그라운드·네이티브 로직은 미실행 — 팝업 UI와 popup.js 로직만 검증 대상
- 상태는 메모리에만 존재 (새로고침하면 초기화)

### 재생성
```bash
node scripts/build-sandbox.js   # → sandbox/popup-sandbox.html 재생성 + 모듈 문법 검사
```
생성물(`popup-sandbox.html`)은 커밋 대상이 아닙니다 (소스는 `sandbox/harness.js` + `scripts/build-sandbox.js`).

