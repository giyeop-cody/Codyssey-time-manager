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
  ├─ api.usr.codyssey.kr 평가 일정 프록시 (아래 "평가 API 실측" 참고)
  └─ 알람 스케줄러 (3초 주기 발화 → 이벤트 큐)
```

### 평가 API 실측 (2026-07-17, usr 프론트엔드 번들에서 확정)

- 엔드포인트: `POST https://api.usr.codyssey.kr/schedule/scheduleAllList/?mbrId=&instCd={instCd}&bgngYmd=YYYY.MM.DD&endYmd=YYYY.MM.DD&scheduleType=request` (**본문 없음**)
  - 참고: 문서상 레거시 `api.codyssey.kr`은 현 배포에서 404, `codyssey.kr`은 정적 SPA 호스트
  - `lms.codyssey.kr`은 DNS 자체가 없음 (상세 페이지 참조만 존재)
- 응답: `result.reqList[]` — 평가 행은 `scdlGubunCd === 'EV'`, 시각은 `bgngYmd`+`bgngTm`,
  제목은 `title || scdlGubunNm`, 역할은 `reqDetail` 첫 토큰(R=내가 피평가자 / A=내가 평가자),
  `fixedCd` 00004(거절)·00005(취소)·00006(완료) 제외, 고유키는 `mtlEvlSn` 우선
- 샌드박스에서 실데이터 원문 확인: 로그인 후 개발자도구 콘솔에서
  `chrome.runtime.sendMessage({type:'EVAL_SCHEDULE', instCd:'<기관코드>', fromYmd:'2026.01.01', toYmd:'2026.12.31'}, console.log)`
  → 응답의 `rows`(핵심 필드 축약)와 `raw`(원문) 비교 가능

### 스텁 기반 종단검증 (회귀 스크립트)

`npm run test:relay` — 스텁 코디세이 서버를 띄우고 중계 서버에 env(`CODYSSEY_AMS_BASE/USR_BASE/EVAL_BASE`)로
주입해, 로그인 → 평가 동기 → 알람 등록/변경/해제·진단값(nonEv/skipped/sampleKeys)까지 20건 자동 검증.
중계 서버의 모든 `CODYSSEY_*_BASE` env는 이 검증용이며 실사용 시 설정 불필요.

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


## 부록: api.usr.codyssey.kr 인증·CORS 실측 (2026-07-18 프로브)

사용자 제보("scheduleAllList가 403")의 원인 확정용 비인증 프로브 결과:

| 요청 | 응답 | 해석 |
|---|---|---|
| POST scheduleAllList (Origin 없음, 쿠키 없음) | **302** → `http://api.usr.codyssey.kr/login` (+ `Set-Cookie: JSESSIONID=...; Domain=codyssey.kr; SameSite=None; Secure`) | 미인증은 로그인 리다이렉트 (403 아님) |
| POST scheduleAllList + `Origin: https://codyssey.kr` | **403 `Invalid CORS request`** | 허용 origin이 아니면 403 |
| OPTIONS + `Origin: https://usr.codyssey.kr` | 200, `ACAO: https://usr.codyssey.kr`, `Allow-Credentials: true` | **공식 웹앱 origin만 허용** |
| GET /rest/user/info/detail + `Origin: chrome-extension://...` | **403 `Invalid CORS request`** | 임의 origin 부착 시 즉시 403 |
| POST ams `/rest/login/pre-check`, `/authenticate` ± `Origin: https://ams.codyssey.kr` | 200/401 (모두 정상 응답) | AMS 로그인 origin도 허용 목록에 있음 |

결론:
- **세션 쿠키는 `JSESSIONID` · `Domain=codyssey.kr`** — *.codyssey.kr 전 서브도메인에 자동 송신 (SameSite=None+Secure라 cross-site fetch도 withCredentials면 가능). 기존 "host-only 쿠키" 가설보다 좋은 조건.
- **서버가 403을 내는 유일한 경로는 "허용되지 않은 Origin 헤더"** — 우리 클라이언트(크롬 익스텐션 fetch / 네이티브 HttpURLConnection)는 Origin 헤더가 붙지 않으므로 메커니즘상 정상. 브라우저 주소창에 URL을 직접 붙여 넣으면 302→/login 흐름(또는 http→:80 비정상 리다이렉트)으로 이어지는데, 이것은 미인증 상태의 정상 동작.
- 그래도 **실패 가시성**이 없으면 사용자가 원인을 알 수 없으므로, 14차에서 팝업에 평가 연동 상태(시각/건수/실패 사유)를 표시하고 본문 없는 POST의 Content-Type을 제거함(S4).
