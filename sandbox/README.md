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

## 부록 2: 알림함 평가 감지 채널 (E3, 15차) — /alarm/alarmList/list 실측

사용자 제공 실측 명세(2026-07-14 데이터):
- `POST https://api.usr.codyssey.kr/alarm/alarmList/list` — 본문 JSON `{"page":1,"pagePerRows":10}`
- 응답 `result.list[]` + `result.paginator` (최신순)
- 평가 지정 알림 식별: 본문(`pstartCn`)에 **`평가예정일시 : YYYY-MM-DD HH:MM:SS`** 가 있는 행
  - 실측: sysDivCd `00017` "동료평가자로 지정 되었습니다." (요청자/Discord ID/프로젝트명/학습과정명/단위문제명 필드 포함)
  - 종료 계열(00020)은 '평가종료일시'라 자연 제외. 포인트/레벨 계열(00055~58)도 제외됨
- 설계: 신규 pstartSn을 seen 캐시에 기록(90일 보존) → **신규 1건당 1회 알림 + lead 분 전 알람**.
  스케줄 채널(scheduleAllList)이 이미 잡은 평가(±2분)는 조용히 캐시만 — 이중 알람/알림 방지.
- 서버 확인(2026-07-18 프로브): POST no-Origin → 302(미인증 정상) / Origin usr.codyssey.kr 허용 / 그 외 Origin → 403.
  즉 알림함도 스케줄 API와 동일한 보안 정책 (세션 쿠키 `JSESSIONID Domain=codyssey.kr` 필요).

## 부록 3: 로그인 거부 실측과 원인 분석 (16차 — "등록되지 않은 회원입니다." 제보 대응)

**증상**: 앱 로그인 화면에 "등록되지 않은 회원입니다." — 본인 계정이 분명히 존재하는데.

**결론 요약**: 우리 앱의 요청 형식 문제가 아니다. 서버가 "등록된 이메일 + 비밀번호 해결 실패"에 복내는 문구가
`등록되지 않은 회원입니다.`이다. 즉 **① 비밀번호 오입력, 또는 ② 소셜(Google/네이버) 가입 계정이라 비밀번호 미등록**.
공식 사이트(ams.codyssey.kr/loginForm)도 이 서버 문구를 그대로 표시하므로, 공식 사이트에서 같은 오류가 나면 계정 상태 문제로 확정.

### 실측 프로브 (2026-07-18, 비인증)

| 요청 (모두 정상 형식 확인됨) | 응답 |
|---|---|
| POST `/rest/login/pre-check` `{userId}` (등록/미등록 무관) | 항상 200 `{result:{from:"MBR_BAS"}}` — 계정 존재 여부 미검증 |
| POST `/authenticate` 등록 이메일 + 틀린 비번 | 401 E0000 **`등록되지 않은 회원입니다.`** |
| POST `/authenticate` 미등록 이메일 + 틀린 비번 | 401 E0000 `입력하신 아이디 혹은 비밀번호가 일치하지 않습니다.` |
| from=MBR_BAS / 공란 / 생략, aliasNm 후보, `X-Requested-With`, 세션 선취득, api.usr 호스트 | 전부 동일하게 401 — **요청 변형으로 서버 인식이 바뀌지 않음** |

→ "등록된 이메일인지"를 서버가 구분해서 다른 문구를 복낸다. 문구와 달리 이 경우는
"자격증명(비밀번호) 해결 실패"를 뜻한다.

### 공식 클라이언트 근거 (ams.codyssey.kr 번들)

- 로그인 폼: `POST {base}/authenticate` — `URLSearchParams{userId,password[,aliasNm]}`,
  헤더 `X-Requested-With: XMLHttpRequest`, `maxRedirects:0` → 성공 시 `Location`로 이동.
- 오류 처리: `response.data.message`를 **그대로** 표시 / `E0001`이면 10분 잠금 안내 /
  `code:"INSTITUTION_MISMATCH"`이면 기관 로그인 페이지로 이동.

### 16차 대응

1. 팝업이 서버 문구를 해석해 원인별 안내로 치환 (`describeLoginServerError`, shared 단일 소스):
   - `등록되지 않은 회원` → 비밀번호 재확인 + 소셜 가입 시 비밀번호 미등록 가능성 + 공식 사이트 "비밀번호 찾기" 안내 (원문 병기)
   - `E0001` → 10분 잠금 안내
2. 모바일 IME/자동완성의 비밀번호 앞뒤 공백 오입력 → 공백 제거 1회 자동 재시도 (`shouldRetryTrimmedPassword`)
3. 로그인 실패 시 **"공식 사이트에서 로그인 · 비밀번호 찾기"** 버튼 표시 (네이티브: 시스템 브라우저로 ams.codyssey.kr/loginForm 열기)

### 사용자 확인 절차 (실계정 필요 — L1 잔여 분)

1. 공식 사이트(ams.codyssey.kr)에서 이메일+비밀번호 로그인 시도
2. 같은 문구 → **비밀번호 찾기로 재설정** 후 앱 로그인 (소셜 가입 계정은 이 절차로 비밀번호 신설)
3. 공식 사이트에선 성공·앱에선 실패 → 실패 문구(16차부터 HTTP 코드/사유 표시)를 회수해 추가 분석

## 부록 4: 클립보드 붙여넣기 로그인 실패 분석 (17차 — v1.2.2)

**증상 보강**: 공식에서 확인된 이메일·비밀번호를 **클립보드에서 붙여넣기**했는데 "등록되지 않은 회원입니다."

### 검토한 축과 판정

| 축 | 판정 |
|---|---|
| 요청 인코딩 (네이티브 `URLEncoder.encode` vs 공식 `URLSearchParams`) | **동등** — 둘 다 application/x-www-form-urlencoded 규격, 서버는 퍼센트 디코딩 후 비교. 특수문자·한글·이모지 모두 동일 바이트로 전달됨. 원인 아님 |
| 붙여넣기 오염 (끝 공백·줄바꿈·제로폭 문자) | **최유력** — 비밀번호 칸이 ●●●로 가려 있어 사용자가 확인 불가. `.trim()`은 공백류만 제거하고 제로폭(U+200B/200C/200D/2060/FEFF)·NBSP는 남김 |
| 서버 계정 상태 (부록 3) | 공존 가능 — 두 원인이 겹치면 같은 문구 |

### v1.2.2 대응

1. **👁 비밀번호 표시/숨기기 토글** — 공식 로그인 폼(showPasswordToggle)과 동일 기능. 붙여넣은 내용을 눈으로 확인 가능
2. **재시도 확장** — 첫 시도는 원문 그대로(공식과 동일), 실패 시 앞뒤 공백+제로폭+NBSP까지 제거한 후보로 1회 자동 재시도 (`sanitizePasswordCandidate`)
   - 중간 제로폭은 비밀번호 자체일 수 있어 **보존** (회원가입 때 붙여넣기로 설정했을 수 있음)
3. **입력 진단 표시** — 실패 시 내용 노출 없이 길이·공백/보이지 않는 문자 개수·스마트 따옴표 여부만 표기 (`credentialInputDigest`)

### 남은 확인 절차 (실기기)

1. **모바일 공식 사이트에서 동일 클립보드로 붙여넣기 로그인** — 거기서도 실패하면 클립보드 내용 자체 문제 확정
2. v1.2.2 실패 시 표시되는 **입력 진단 수치**(자릿수·개수) 회수 → 전송 경로 vs 입력 내용 최종 분기

## 부록 5: 1분 상시 감지 서비스 (W7, 18차 — v1.3.0)

사용자 요구: "백그라운드 1분 감지 + 알람 소리(이어폰 라우팅) + 절전모드 미진입 + 종료필치 유지 + 로그인 유지/동기화 버튼 구분".

### 아키텍처

| 계층 | 기존 | 18차 추가 |
|---|---|---|
| 감지 루틴 | SyncWorker 최소 주기 15분 (WorkManager 하한) | `PollingService`(FGS·specialUse) — Handler 60초 틱 + `setExactAndAllowWhileIdle(ELAPSED_REALTIME_WAKEUP)` 자기 부활 예약. 서비스 사망/스와이프 종료 → 1분 뒤 알람으로 재기동, MainActivity/BootReceiver 경유 복원 |
| 틱 비용 | — | partial wake lock **60초 캡**, `ticking` 원자 플래그로 중첩 방지. GateCheck(설정 ON 시 조회, OFF면 즉시 반환) + EvalSync(6시간 스로틀) 재사용이라 보통 틱은 1~2회 HTTP |
| keep-alive | 25~28분 | 서비스 가동 중 **50초 간격**으로 상향 (세션 유지 마진) |
| 절전 예외 | — | `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` + 설정에서 시스템 다이얼로그 개시, 상태 표시 (✅/⚠️) |
| 알람음 | TYPE_NOTIFICATION | **TYPE_ALARM + USAGE_ALARM 속성**(채널 매번 동기화) → 이어폰 착용 시 이어폰 라우팅, 미착용 시 알람 볼륨(단말 정책상 매너모드 우회 가능). 설정 '소리' 토글과 AlarmPlugin.setAlarmSound로 OFF 시 해당 알람만 조용히 |
| UI | 💓/⚙️/🔄·🔃 이모지만 | 버튼에 미니 라벨(유지/설정/갱신/동기) 추가, 동기 아이콘 🔃→📥 |

### 플랫폼 한계 (기술적 상한 — 제거 불가)

- **포그라운드 서비스 = 상시 알림 1개 필수** (무소음 채널 `codyssey_monitor`). 완전 무알림 상시 동작은 OS가 허용하지 않음
- 정확 알람 권한 미허용 시 틱이 자동 5분으로 축소 (앱이 폴곤 처리, 설정에서 권한 안내 기존 M5 경로)
- 제조사 독자 절전(삼성 "절전 앱", 샤오미 등)은 OS 예외와 별개 — 그 경우에도 Worst case 15분 WorkManager 폴곤이 남음
- 1분 상시 감지는 배터리 부담이 크므로 **설정에서 OFF 가능** (SyncWorker 15분 경로로 회귀)
