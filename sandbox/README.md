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
- 정확 알람 권한 미허용 시 틱이 자동 5분으로 축소 (앱이 폴백 처리, 설정에서 권한 안내 기존 M5 경로)
- 제조사 독자 절전(삼성 "절전 앱", 샤오미 등)은 OS 예외와 별개 — 그 경우에도 Worst case 15분 WorkManager 폴백이 남음
- 1분 상시 감지는 배터리 부담이 크므로 **설정에서 OFF 가능** (SyncWorker 15분 경로로 회귀)

## 부록 6: '로그인 폼 갑자기 회귀' 진단 체계 (19차 — v1.3.1)

### 발견한 회귀 메커니즘 (제보 전 코드 기준)

1. 어떤 API라도 응답이 301/302/307/401/**403**이면 즉시 `clearSessionIdentity()` → member_id 소각
2. 다음 상태 조회(GET_STATUS) → memberId 없음 → **로그인 폼으로 튕김**
3. 망 흔들림·포털 리다이렉트(공유 Wi-Fi)·서버 정책 403 등 **일시 응답**에도 동일 — v1.3.0의 1분 감지 도입으로 접촉 빈도가 늘어 체감 증가

### 19차 대응

**A. 진단 로그 (원인 가시화 — 핵심 요구사항)**
- 네이티브/JS가 같은 링버퍼(`codyssey_prefs/diag_log`, 80건)를 공유
- 계측: keep-alive 핑(PING) · 출입 조회(GATE) · 평가 2채널(EVAL-S/N) · 쿠키 존재 전이(COOKIE) · 서비스 시작/정지(SVC) · 로그인 인증(LOGIN) · 인증 오류 판정(AUTH) · 화면 전환(POPUP)
- 상태 전이(`addOnChange`)만 기록해 1분 주기 스팸 방지
- 로그인 화면에 **최근 8건 + 복사/지우기 버튼** — 공유 시 그대로 붙여넣기

**B. 오분류 제거 (회귀 자체 감축)**
- 인증류 판정 코드를 302/303/401로 축소 (403·301/307/308은 세션 무효가 아니라 일시/정책 오류 취급)
- 단발 인증류 응답은 **폐기 보류 → 연속 2회 + 회원 정보 재조사까지 실패**해야 세션 종료 확정
  (재조사 정상이면 "일시 오류 판정, 세션 유지"로 복구 — 로그 포함)
- 갱신 실패 시 기존 데이터 화면 유지 (첫 로드 실패만 로그인 폼 — 사유 로그 첨부)

### 판독 가이드 (로그인 폼의 진단 블록 기준)

| 패턴 | 판독 |
|---|---|
| GATE 200 연속 → GATE 302 전이 + LOGIN 없음 | 서버측 세션 종료 — 만료 또는 **중복 로그인 강제 로그아웃** (다른 기기/브라우저 로그인 여부 확인) |
| LOGIN(성공) 후 수 시간 경과 + 302 전이 | 세션 TTL 만료 추정 (login 시각은 LOGIN 로그로 확인) |
| 302가 반복되다가 다음 로그인까지 이어짐 | 동일 — 서버 리다이렉트가 원인 |
| COOKIE 소실 사건 선행 | 로컬 쿠키 소실 (앱 데이터 삭제/업데이트/저장소 초기화 여부 확인) |
| GATE net / -1 반복 | 단순 네트워크 오류 — 이 경우 로그인 폼으로 튕기지 않음(19차부터) |

## 부록 7: '알람이 백그라운드에서 안 오고 앱을 켜면 몰아서 옴' 수정 (20차 — v1.3.2)

### 증상
알람이 창이 내려가 있거나(백그라운드) 앱이 꺼져 있으면 오지 않고, 창을 여는 순간 바로 울림.

### 코드 근거 원인 분석
1. **부활 알람의 무효 경로**: 폴링 서비스 부활 사슬이 `PendingIntent.getService`(=백그라운드 startService)였음.
   앱 프로세스가 죽은 상태에서 알람이 울려도 백그라운드 서비스 시작 제한(특히 specialUse FGS)으로 복구 실패
   → 앱을 열기 전까지 1분 감지 정지 → 알람 미발생.
2. **태스크 제거 무대응**: `onTaskRemoved` 미구현 — 최근 앱 목록 스와이프 제거 시(특히 삼성 등) FGS 사망했는데도 복구 예약 없음.
3. **비자발적 onDestroy의 사슬 절단**: OS가 죽인 경우에도 `cancelAlarm()`이 복구 알람까지 해제.
4. **가시성 부재**: 예약만 됐는지, 늦게 울렸는지, 왜 안 울렸는지 사용자가 판독할 수단이 없음.

### 수정 내용
- **`receiver/TickReceiver` 신설**: 부활 알람 수신지를 브로드캐스트로 전환(백그라운드 제한 없음, 알람 발화 윈도우에서 FGS 복구 허용). 매니페스트 등록.
- **`PollingService.onTaskRemoved`**: 대시 활성 상태면 30초 후 자기 복구 알람 예약 + 진단 로그.
- **`PollingService.onDestroy`**: 설정이 켜져 있으면 복구 알람 유지(사용자 해제일 때만 취소).
- **틱 지연 계측**: 예정 대비 3분+ 지연 틱 감지 시 "OS가 백그라운드 실행을 지연" 로그(`dash_expect_at`).
- **`AlarmPlugin.schedule`**: 정확 알람 레이스(권한 체크 직후 해제) 시 WorkManager 폴백 + 모든 예약을 `ALARM-S` 로그에 기록(시각·정확/부정확).
- **`AlarmReceiver`**: 발화 시 `ALARM-F` 로그 (정시 | +N분 지연 | stale 스킵 명시).
- **`NotificationHelper`**: `notify()`의 SecurityException(알림 권한 꺼짐)을 잡아 `NOTIF` 로그 — 예외가 호출부로 전파돼 조용히 죽던 것 방지.
- **`PollingPlugin.getDashStatus`**: `exactAlarm`/`batteryExempt` 필드 추가. 설정 화면에 "정확 알람 ✅/⚠️" + 전용 권한 설정 진입 버튼(`btn-exact-alarm`).

### 판독표 (진단 로그에서)
| 로그 | 해석 |
|---|---|
| ALARM-S (정확) 예약 후 정시 ALARM-F 발화 | 정상 동작 |
| ALARM-S (부정확) 반복 | 정확 알람/알람·리마인더 권한 꺼짐 → 설정에서 허용 |
| 알람이 오지 않고 SVC "최근 목록에서 제거됨" | 20차부터 30초 내 자동 복구. 이후 틱 지연 로그 지속이면 제조사 절전(배터리 예외) 필요 |
| SVC "틱이 약 N분 지연됨" 빈번 | OS가 백그라운드 실행을 지연 — 배터리 최적화 예외 미설정/제조사 독자 절전 |
| ALARM-S 없이 앱을 열어야 알람이 옴 | 알람 예약이 앱 실행 시점에만 일어남(정상 설계) — 1분 감지 복구로 커버되는지 틱 로그 확인 |
| NOTIF "알림 권한이 꺼져 있음" | 시스템 설정 > 알림에서 이 앱 허용 필요 |

## 부록 8: '스와이프 종료 → 재실행 시 로그인창' 근본 수정 — 세션 쿠키 영속화 (21차 — v1.3.3)

### 증상 (사용자 실측 재현 경로)
로그인 → 창 스와이프로 닫음 → 시간 경과 → 앱 실행 → 로그인창 노출

### 근본 원인
- 서버 `JSESSIONID`는 **만료일 없는 세션 쿠키** → WebView 쿠키 저장소에서도 프로세스가 죽으면 디스크에 남지 않음.
- 스와이프 종료(프로세스 사망) 후 재실행하면: 쿠키 없음 → 출입 조회 302 → (연속 + 회원정보 재조회 실패) → 19차 로직이 세션 종료 확정 → member_id 폐기 → 로그인 폼.
- 즉 "쿠키 소실이 먼저, 로그인 화면은 그 결과" — member_id만 영속 저장소에 있던 불균형이 근본 결함.

### 수정 (세션 쿠키 백업·복원)
- `CookieManager.persistSessionCookie`: **인증이 확인된 응답**(핑 200 / httpRequest 200 / 로그인 인증 성공)에서 JSESSIONID를 SharedPreferences(`session_jsessionid`)에 백업. 비인증 302에선 백업하지 않음(비인증 세션 덮어쓰기 방지). 서버가 쿠키를 회전시켜도 최신값으로 따라감.
- `CookieManager.restoreSessionCookie`: 저장소에 JSESSIONID 없고 백업 있으면 재주입 + `COOKIE` 로그. 모든 호출부: pingKeepAlive·httpRequest·NetworkPlugin.addCookies(모든 네이티브 요청)·PollingService.onCreate·MainActivity.onCreate. 이미 있으면 no-op.
- 세션 폐기 경로(JS clearSessionIdentity)에서 `session_jsessionid` 키도 함께 삭제 — 죽은 세션 부활 방지.

### 효과 · 한계
- 스와이프 종료/프로세스 사망/재부팅(BootReceiver 경유) 후에도 세션 복원 → 로그인 폼 회귀 해소.
- **서버 TTL 만료는 여전히 제거 불가**(서버 정책): 복원된 쿠키로 302가 오면 진단 로그에 LOGIN 시각 대비 경과가 남고, 정당하게 재로그인 필요.
- 보안: JSESSIONID 평문 저장은 기존 WebView 저장소와 동일 수준(allowBackup=false).

## 부록 9: 세션 종료 판독 정리 + 만료 시 폼 비전환(캐시 대시보드) 정책 (22차 — v1.4.0)

### 판독 사실관계 (실제 로그 기반)
- `PING 송신 쿠키: 있음 → 302 + 빈 JSESSIONID` 패턴 반복 확인 — **쿠키를 달고 보낸 요청도 서버가 거절** = 서버측 세션 무효화 (21차가 고친 로컬 소실과는 다른 층).
- 공식 정책 "중복 로그인 시 기존 세션 강제 로그아웃"과 일치 → 사용자 다른 기기 로그인이 유력 원인 (본인 확인: 다른 기기에 로그인되어 있음).
- "스와이프와 타이밍이 물리는" 것은 우연이 아니라 **스와이프 후 다른 기기로 옮겨 사용하는 생활 패턴**의 반영일 가능성 높음.

### member_id vs 세션 쿠키 (사용자 질의 대한 정리)
- member_id = 식별자(영속 저장). JSESSIONID = 매 요청의 인증수단.
- 서버가 세션을 회수하면 member_id 단독으로는 모든 데이터 API가 302 — "member_id만 있으면 된다"는 UI 표시에는 유효하나 데이터 갱신/알람에는 무의미 → 22차 정책으로 정리.

### 22차 정책: 만료 시 폼 강제 전환 폐지
- 세션 무효 '확정' 시에도 member_id/캐시가 메모리에 있으면 ⇒ **캐시 데이터 기반 대시보드 유지** + 상단 🔒 만료 배너(재로그인 버튼)만 표시.
- 캐시가 전혀 없는 최초 진입만 기존처럼 로그인 폼.
- 재로그인 성공 시 배너 자동 해제.
- (네이티브 측 명의 폐기는 그대로: member_id 삭제 시 GateCheck는 스킵 — 만료 중 서버 요청 낭비 방지)
- 후보였으나 미채택: 자동 재로그인(자격증명 Keystore 저장) — 다른 기기 세션과 핑퐁(상호 강제 로그아웃) 위험이 있어 명지적 요청 시에만 구현.

## 부록 10: '퇴실 알람이 시간이 돼도 안 울림' 점검 매트릭스 (23차 — v1.4.1)

예약 알람 경로: SET_ALARM(JS) → AlarmPlugin.schedule(정확 알람) → AlarmReceiver → NotificationHelper(채널 codyssey_alarms).

| 진단 로그 | 판정 |
|---|---|
| `ALARM-S 알람 예약: ... (정확)` 있음 | 예약까지는 성공 → 발화 계층 점검 |
| ALARM-S 없음, 권한 alert 이력 | 23차 이전엔 알림 권한 없음 시 조용히 return됨 — 23차부터 alert으로 안내 |
| `ALARM-F 알람 발화: ... (정시)` 있음 | 발화까지 정상 → 표시/채널 계층 (NOTIF 로그 확인) |
| `ALARM-F ... (+"분 지연 — OS가 늦게 깨움)` | 제조사 절전 지연 — 배터리 최적화 예외·정확 알람 재확인 |
| `ALARM-F 표시 생략 ...` | 15분 stale 상한 초과 발화 — 정책상 표시 안 함 |
| `NOTIF ⚠️ '출입 알림' 채널이 시스템 설정에서 꺼져 있어...` | 채널 차단 — 시스템 설정에서 채널 활성 필요 (코드 우회 불가) |

코드 수정:
- PendingIntent requestCode를 id.hashCode() → id별 고유 정수 매핑으로 교체 (해시 충돌 덮어쓰기 소멸 방지) + 구버전 PI 자동 정리(이중 발화 방지).
- 설정 시 알림 권한 미허용이면 조용한 return → 명시적 alert + 설정 유도.
- 채널 차단(IMPORTANCE_NONE) 감지 → NOTIF 로그.


## 부록 11: 재실행 시 로그인 폼 섬광 노출 제거 — 초기 세션 스플래시 (24차 — v1.4.2)

- 원인: popup.html의 #login-screen이 마크업상 기본 노출. init()의 비동기 세션 확인(checkExistingSession → GET_STATUS) 동안 로그인 폼이 "잠깐" 보였다가 세션 확인 후 대시보드로 전환되어 섬광처럼 인식.
- 수정: 초기 스플래시(#init-splash, "세션 확인 중...")를 기본 노출로 두고 로그인 화면은 기본 숨김. showLoginScreen/showDashboard가 모두 스플래시를 닫음 → 초기 확인 구간은 낸 끝에서 스플래시만 보임.
- 사용자 요청대로 확인/재인증 구간은 로딩 표시로 커버.
