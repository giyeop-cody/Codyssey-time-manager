// ============================================================
// 출입 데이터 공통 로직 (단일 소스)
// - background.js(익스텐션), capacitor-adapter.js(Android), popup.js가 공유
// - ES 모듈: 서비스 워커/모듈 스크립트에서 import
// ============================================================

// 서버 인정 규칙: 하루 최대 12시간까지만 합산 (사용자 설정값과 무관하게 고정)
export const SERVER_DAILY_CAP_HOURS = 12;
export const SERVER_DAILY_CAP_MINUTES = SERVER_DAILY_CAP_HOURS * 60;

// ===== 시각/기간 변환 =====
export function timeToMinutes(timeStr) {
  if (!timeStr) return 0;
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

export function minutesToTimeStr(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}시간 ${m}분`;
}

export function minutesToHHMM(minutes) {
  if (minutes === null || minutes === undefined || isNaN(minutes)) return '--:--';
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

// endMinutes(오늘 자정부터 분) 표시 — 24시간 초과 시 'N일 후 HH:MM' (K11: 팝업/백그라운드 공용 단일 소스)
export function formatEndMinutes(m) {
  if (m === null || m === undefined || isNaN(m)) return '--:--';
  if (m < 1440) return minutesToHHMM(m);
  const days = Math.floor(m / 1440);
  return `${days}일 후 ${minutesToHHMM(m % 1440)}`;
}

// 분(ms epoch) 시각 → 사용 메모: 아래 STALE_WINDOW_MS보다 오래 지연 발화된 알람은 표시하지 않음 (K3)
export const ALARM_STALE_WINDOW_MS = 15 * 60 * 1000;
export function isAlarmStale(scheduledTimeMs, nowMs = Date.now()) {
  if (!scheduledTimeMs || scheduledTimeMs <= 0) return false; // 시각 정보 없으면 신선한 것으로 간주
  return nowMs - scheduledTimeMs > ALARM_STALE_WINDOW_MS;
}

export function getTodayString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// HH:MM:SS / HH:MM → 분
export function durationToMinutes(durationStr) {
  if (!durationStr) return 0;
  const parts = durationStr.split(':').map(Number);
  if (parts.some(isNaN)) return 0;
  if (parts.length === 3) return parts[0] * 60 + parts[1] + Math.round(parts[2] / 60);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return 0;
}

// HH:MM(:SS) → 자정부터 분 (파싱 불가 시 null)
export function timeStrToMinutes(timeStr) {
  if (!timeStr) return null;
  const parts = timeStr.split(':').map(Number);
  if (parts.length >= 2 && !parts.some(isNaN)) return parts[0] * 60 + parts[1];
  return null;
}

// 날짜 + 시각 문자열 → 로컬 타임스탬프(ms)
export function parseEntryTimestamp(dateStr, entryTime) {
  if (!dateStr || !entryTime) return null;
  const time = entryTime.length === 5 ? `${entryTime}:00` : entryTime;
  const ts = new Date(`${dateStr}T${time}`).getTime();
  return isNaN(ts) ? null : ts;
}

// 마지막 입실부터 현재까지 경과 분 (자정 경계 안전)
export function elapsedSinceEntry(parsed, nowMs = Date.now()) {
  if (!parsed || !parsed.isCurrentlyIn) return 0;
  if (parsed.entryTimestamp) {
    return Math.max(0, Math.floor((nowMs - parsed.entryTimestamp) / 60000));
  }
  if (parsed.lastInTime === null) return 0;
  const now = new Date(nowMs);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return Math.max(0, nowMin - parsed.lastInTime);
}

// ===== 서버 규칙(일별 12시간 캡) 기준 실시간/예측 계산 =====
// 오늘 실시간 인정: min(서버 오늘 누적 + 경과, 12h)
export function recognizedToday(parsed, nowMs = Date.now()) {
  if (!parsed) return 0;
  return Math.min(
    parsed.dailyTotal + elapsedSinceEntry(parsed, nowMs),
    SERVER_DAILY_CAP_MINUTES
  );
}

// 월 누적 실시간: 서버 월 누적 + 오늘 세션 경과분(캡까지만)
export function recognizedMonthly(parsed, nowMs = Date.now()) {
  if (!parsed) return 0;
  const effectiveElapsed = Math.min(
    elapsedSinceEntry(parsed, nowMs),
    Math.max(0, SERVER_DAILY_CAP_MINUTES - parsed.dailyTotal)
  );
  return parsed.monthlyTotal + effectiveElapsed;
}

// 추가 시간 반영 시 예상 월 누적 (오늘분을 캡 적용 후 합산)
export function projectedMonthly(parsed, additionalMinutes, nowMs = Date.now()) {
  if (!parsed) return 0;
  const todayUncapped =
    parsed.dailyTotal + elapsedSinceEntry(parsed, nowMs) + Math.max(0, additionalMinutes);
  const todayCapped = Math.min(todayUncapped, SERVER_DAILY_CAP_MINUTES);
  return (parsed.monthlyTotal - parsed.dailyTotal) + todayCapped;
}

// ===== 출입기록 파싱 =====
// targetDate 기준 월의 detail_list를 파싱.
// - 세션은 입실 시각순 정렬해 상태 판정 (순서 뒤집힌 응답 대응)
// - 퇴실 누락 세션은 날짜와 무관하게 "현재 입실 중"으로 감지 (전날 입실 포함)
export function parseAttendance(data, targetDate = new Date()) {
  const detailList = (data && (data.detail_list || data.result || data.data)) || [];
  const year = targetDate.getFullYear();
  const month = targetDate.getMonth() + 1;
  const todayStr = getTodayString();

  let monthlyTotal = 0;
  let dailyTotal = 0;
  let lastInTime = null;
  let lastOutTime = null;
  let isCurrentlyIn = false;
  let entryTimestamp = null;
  let hasMissingEntry = false;
  const dailyBreakdown = {};

  for (const day of detailList) {
    const dateStr = day.date || '';
    if (!dateStr) continue;
    if (!dateStr.startsWith(`${year}-${String(month).padStart(2, '0')}`)) continue;

    // 서버에서 이미 12시간 캡 적용된 일일 총 시간
    const dailyTotalMinutes = durationToMinutes(day.daily_total_duration);
    monthlyTotal += dailyTotalMinutes;
    dailyBreakdown[dateStr] = dailyTotalMinutes;

    const sessions = (day.sessions || []).slice().sort((a, b) => {
      const ta = timeStrToMinutes(a.entry_time);
      const tb = timeStrToMinutes(b.entry_time);
      return (ta === null ? 0 : ta) - (tb === null ? 0 : tb);
    });

    for (const session of sessions) {
      const entryMin = timeStrToMinutes(session.entry_time);
      const exitMin = timeStrToMinutes(session.exit_time);
      const isMissing = session.is_missing === true;

      if (isMissing && session.missing_type === 'exit' && entryMin !== null) {
        isCurrentlyIn = true;
        lastInTime = entryMin;
        lastOutTime = null;
        entryTimestamp = parseEntryTimestamp(dateStr, session.entry_time);
      } else if (isMissing && session.missing_type === 'entry') {
        hasMissingEntry = true;
      } else if (entryMin !== null && exitMin !== null && dateStr === todayStr) {
        lastInTime = entryMin;
        lastOutTime = exitMin;
      }
    }

    if (dateStr === todayStr) {
      dailyTotal = dailyTotalMinutes;
    }
  }

  return {
    monthlyTotal,
    dailyTotal,
    lastInTime,
    lastOutTime,
    isCurrentlyIn,
    entryTimestamp,
    hasMissingEntry,
    dailyBreakdown,
    rawDetailList: detailList
  };
}

// 전월 데이터에서 미퇴실 세션 감지 (월 경계 입실 — R2)
// parsed에 입실 중 세션이 없을 때만 적용. 변경 시 true 반환.
export function applyOvernightFromPrevMonth(parsed, prevMonthData) {  if (!parsed || parsed.isCurrentlyIn || !prevMonthData) return false;
  const detailList = prevMonthData.detail_list || prevMonthData.result || prevMonthData.data || [];

  // 뒤에서부터(최근 날짜 우선) 퇴실 누락 세션 탐색
  for (let i = detailList.length - 1; i >= 0; i--) {
    const day = detailList[i];
    const dateStr = day.date || '';
    if (!dateStr) continue;
    for (const session of (day.sessions || [])) {
      const entryMin = timeStrToMinutes(session.entry_time);
      if (session.is_missing === true && session.missing_type === 'exit' && entryMin !== null) {
        parsed.isCurrentlyIn = true;
        parsed.lastInTime = entryMin;
        parsed.lastOutTime = null;
        parsed.entryTimestamp = parseEntryTimestamp(dateStr, session.entry_time);
        return true;
      }
    }
  }
  return false;
}

// ===== 알람 이름 유틸 (background.js와 공유 — L11 중복 제거) =====
export const ALARM_PREFIX = 'codyssey_alarm_';
export const LEGACY_ALARM_PREFIX = 'codyssey_exit_';

export function buildAlarmName(memberId, type, endMinutes) {
  return `${ALARM_PREFIX}${memberId}_${type}_${endMinutes}`;
}

export function legacyAlarmName(memberId, endMinutes) {
  return `${LEGACY_ALARM_PREFIX}${memberId}_${endMinutes}`;
}

// 알람 이름 파싱 (신형 codyssey_alarm_{memberId}_{type}_{endMinutes} + 구형 호환)
export function parseAlarmName(name) {
  if (!name || typeof name !== 'string') return null;
  const parts = name.split('_');
  if (parts[1] === 'alarm' && parts.length >= 5) {
    const endMinutes = parseInt(parts[4]);
    if (isNaN(endMinutes)) return null;
    return { memberId: parts[2], type: parts[3], endMinutes };
  }
  // 구형 codyssey_exit_{memberId}_{endMinutes}
  if (parts[1] === 'exit' && parts.length >= 4) {
    const endMinutes = parseInt(parts[3]);
    if (isNaN(endMinutes)) return null;
    return { memberId: parts[2], type: 'exit', endMinutes };
  }
  return null;
}

// 이름 재계산 없이 해제(cancel) 가능하도록, 같은 알람의 신/구형 이름 쌍을 반환 (문제2 수정)
// - memberId를 다시 조립하지 않고 "이미 저장된 이름"만으로 해제할 때
//   양쪽 명명 규칙을 모두 정리하기 위함
export function equivalentAlarmNames(name) {
  if (!name || typeof name !== 'string') return [];
  const parsed = parseAlarmName(name);
  if (!parsed) return [name]; // 파싱 불가라도 주어진 이름 자체는 해제 시도
  const modern = buildAlarmName(parsed.memberId, parsed.type, parsed.endMinutes);
  const legacy = legacyAlarmName(parsed.memberId, parsed.endMinutes);
  return modern === legacy ? [modern] : [modern, legacy];
}

// ============================================================
// 입·퇴실 처리 감지 (G1)
// - 마지막으로 스냅샷한 "오늘/어제 세션 상태"와 새 응답을 비교해
//   새 입실 처리 / 퇴실 완료 처리 이벤트를 찾아낸다.
// - 스냅샷 포맷: { 'YYYY-MM-DD': [ ['HH:MM', 'HH:MM'|null], ... ] }
//   (JS와 Android 네이티브 GateCheck가 동일 포맷을 공유 — 중복 알림 방지)
// ============================================================

// 이 시간보다 오래된 변화는 "방금 처리"가 아닌 것으로 보고 알림 없이 스냅샷에만 반영
// (앱을 오래 닫아뒀다가 열었을 때 과거 입실이 새 알림처럼 울리는 것 방지)
export const GATE_EVENT_MAX_AGE_MS = 4 * 60 * 60 * 1000;
export const GATE_EVENT_MAX_PER_PASS = 3; // 한 번의 감지에서 알림 상한 (폭주 방지)

// 'HH:MM(:SS)' → 'HH:MM' 정규화 (스냅샷 비교 안정성). 파싱 불가 시 null
export function normalizeHHMM(timeStr) {
  if (!timeStr || typeof timeStr !== 'string') return null;
  const m = timeStr.trim().match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (isNaN(h) || isNaN(mm) || h > 30 || mm > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

// rawData(detail_list)에서 지정된 날짜들의 세션 스냅샷 맵 생성
// - entry_time이 없는 세션(입실 누락)은 식별 불가라 비교 대상에서 제외
// - 요청한 날짜는 데이터가 없어도 빈 배열로 포함 (날짜 롤오버 감지용)
export function snapshotSessionsByDate(rawData, dateStrs) {
  const out = {};
  const want = Array.isArray(dateStrs) ? dateStrs.filter(Boolean) : [];
  const detailList = Array.isArray(rawData)
    ? rawData
    : ((rawData && (rawData.detail_list || rawData.result || rawData.data)) || []);
  for (const day of detailList) {
    const dateStr = (day && day.date) || '';
    if (!dateStr || !want.includes(dateStr)) continue;
    const sessions = [];
    for (const s of (day.sessions || [])) {
      const entry = normalizeHHMM(s && s.entry_time);
      if (!entry) continue;
      const exit = normalizeHHMM(s && s.exit_time);
      sessions.push([entry, exit]);
    }
    sessions.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    out[dateStr] = sessions;
  }
  for (const d of want) {
    if (!Object.prototype.hasOwnProperty.call(out, d)) out[d] = [];
  }
  return out;
}

// 이벤트 시각 계산: 퇴실 이벤트에서 퇴실 시각이 입실 시각보다 작으면 익일로 간주 (야간 세션)
function gateEventTimestamp(event) {
  const timeStr = event.type === 'exit' ? event.exit : event.entry;
  let ts = parseEntryTimestamp(event.dateStr, timeStr);
  if (ts === null) return null;
  if (event.type === 'exit' && event.entry) {
    const em = timeStrToMinutes(event.entry);
    const xm = timeStrToMinutes(event.exit);
    if (em !== null && xm !== null && xm < em) ts += 24 * 60 * 60000;
  }
  return ts;
}

// 이전 스냅샷(prevDates, null=없음)과 새 스냅샷(nextDates)을 비교해 이벤트 배열 반환
// - 최초 스냅샷(null)은 조용히 채택 (과거 데이터로 알림 폭주 방지)
// - entry_time 일치로 세션을 매칭: 새 entry → 입실 이벤트, exit가 새로 채워짐 → 퇴실 이벤트
// - GATE_EVENT_MAX_AGE_MS보다 오래된 이벤트는 제외, 최신 순으로 MAX_PER_PASS건 제한
export function detectGateEvents(prevDates, nextDates, nowMs = Date.now()) {
  if (!nextDates || typeof nextDates !== 'object') return [];
  if (!prevDates || typeof prevDates !== 'object') return []; // 베이스라인 채택

  const events = [];
  for (const [dateStr, sessions] of Object.entries(nextDates)) {
    if (!Array.isArray(sessions)) continue;
    const prevSessions = Array.isArray(prevDates[dateStr]) ? prevDates[dateStr] : [];
    const prevExitByEntry = new Map();
    for (const p of prevSessions) {
      if (Array.isArray(p) && p[0]) prevExitByEntry.set(p[0], p[1] || null);
    }
    for (const pair of sessions) {
      if (!Array.isArray(pair) || !pair[0]) continue;
      const [entry, exit] = [pair[0], pair[1] || null];
      if (prevExitByEntry.has(entry)) {
        const prevExit = prevExitByEntry.get(entry);
        if (!prevExit && exit) {
          events.push({ type: 'exit', dateStr, entry, exit });
        }
      } else {
        events.push({ type: 'entry', dateStr, entry, exit });
      }
    }
  }

  return events
    .map(e => ({ ...e, atMs: gateEventTimestamp(e) }))
    .filter(e => e.atMs !== null && nowMs - e.atMs <= GATE_EVENT_MAX_AGE_MS) // 미래/너무 오래된 것 제외
    .sort((a, b) => a.atMs - b.atMs)
    .slice(-GATE_EVENT_MAX_PER_PASS);
}

// 입·퇴실 이벤트 → 알림 제목/본문 (JS용 — Android GateCheck.java가 동일 문구를 미러링)
export function formatGateEventMessage(event, todayStr = getTodayString()) {
  const dateLabel = event.dateStr === todayStr
    ? ''
    : `[${Number(event.dateStr.slice(5, 7))}월 ${Number(event.dateStr.slice(8, 10))}일] `;
  if (event.type === 'entry') {
    return { title: '✅ 코디세이 입실 처리', body: `${dateLabel}입실 처리됨: ${event.entry}` };
  }
  const extra = event.entry ? ` (입실 ${event.entry})` : '';
  return { title: '🏁 코디세이 퇴실 처리', body: `${dateLabel}퇴실 처리됨: ${event.exit}${extra}` };
}

// 스냅샷 이벤트의 알림 id 키 (JS/네이티브 공통 규칙 — 같은 이벤트는 같은 id)
export function gateEventKey(event) {
  const t = event.type === 'exit' ? event.exit : event.entry;
  return `gate_${event.dateStr}_${event.type}_${t}`;
}

// ============================================================
// 평가 알람 (E1) — 사용자가 등록한 평가 일정의 N분 전 알림
// 퇴실/목표 알람(codyssey_alarm_*)과 네임스페이스 분리
// ============================================================
export const EVAL_ALARM_PREFIX = 'codyssey_eval_';

export function newEvalId(nowMs = Date.now()) {
  return `e${nowMs.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export function buildEvalAlarmName(evalId) {
  return `${EVAL_ALARM_PREFIX}${evalId}`;
}

export function parseEvalAlarmName(name) {
  if (!name || typeof name !== 'string') return null;
  if (!name.startsWith(EVAL_ALARM_PREFIX)) return null;
  const evalId = name.slice(EVAL_ALARM_PREFIX.length);
  return evalId ? { evalId } : null;
}

// 평가 알람 유효성 검사: 과거 시각이면 'past', 입력 오류면 'invalid', 정상이면 null 반환
export function validateEvalAlarm(whenMs, leadMinutes, nowMs = Date.now()) {
  if (!whenMs || isNaN(whenMs) || whenMs <= 0) return 'invalid';
  const lead = Number(leadMinutes);
  if (isNaN(lead) || lead < 0 || lead > 1440) return 'invalid';
  if (whenMs - lead * 60000 <= nowMs) return 'past';
  return null;
}

// ============================================================
// E2: 평가 일정 자동 연동 (schedule/scheduleAllList 응답 해석)
// - 2026-07-17 usr 프론트엔드 번들(usr.codyssey.kr/assets/index-*.js) 실측 근거:
//   · 호출: POST https://api.usr.codyssey.kr/schedule/scheduleAllList/
//           ?mbrId=&instCd=&bgngYmd=YYYY.MM.DD&endYmd=YYYY.MM.DD&scheduleType=request (본문 없음)
//   · 응답: result.reqList[] (+ academicList[]·timeList[] — 출직표/학사일정, 미사용)
//   · 평가 행 식별: scdlGubunCd === 'EV' (AM=오전점호 / EXAM=시험 / MT=멘토링 등은 제외)
//   · 시작 시각: bgngYmd('YYYY.MM.DD') + bgngTm('HH:MM') — 두 필드 조합
//   · 상태(fixedCd): 00001=요청(수락 대기) 00002=평가 대기중 00003=평가 진행중
//                    00004=요청 거절 / 00005=요청 취소 / 00006=평가 완료 → 이 3개는 알람 제외
//   · 역할(reqDetail): '|' 연속 구분으로 쪼갠 첫 토큰 — R=내가 피평가자(request) /
//     A=내가 평가자(participation). 실 형식: "R||mtlEvlSn||projectNo||lcorsNo||uqstnNo"
//   · 제목: title || scdlGubunNm (캘린더 표시 규칙과 동일)
// - 구 배포/필드 변종 대비 폴곤 체인은 유지 (EV 행의 키 목록을 sampleKeys에 남김)
// ============================================================

export const EVAL_AUTO_ID_PREFIX = 'auto_'; // codyssey_eval_auto_{key} — 수동 등록(e...)과 구분
export const EVAL_CANCEL_FIXED_CODES = ['00004', '00005', '00006']; // 거절/요청취소/완료 → 알람 대상 아님
export const EVAL_GUBUN_VALUE = 'EV'; // scdlGubunCd === 'EV' 인 행만 평가 (AM/EXAM/MT 등 제외)

// 멤버 정보 응답 어디에 있든 instCd를 재귀 탐색 (키 이름만 확실하다는 전제)
export function findInstCd(root) {
  if (!root || typeof root !== 'object') return null;
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    for (const [k, v] of Object.entries(cur)) {
      if (/^inst(cd|code)?$/i.test(k) && typeof v === 'string' && v.trim()) return v.trim();
    }
    for (const v of Object.values(cur)) {
      if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

function pickFirst(row, names) {
  for (const n of names) {
    const v = row[n];
    if (v !== null && v !== undefined && String(v).trim() !== '') return String(v).trim();
  }
  return null;
}

// 'YYYY.MM.DD' / 'YYYY-MM-DD' / 'YYYYMMDD' → [y, m, d] (+ 'YY.MM.DD' 2자리 연도 폴곤)
function ymdFromString(s) {
  if (!s) return null;
  const m = String(s).match(/(20\d\d)[.\-/]?(0[1-9]|1[0-2])[.\-/]?(0[1-9]|[12]\d|3[01])/);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const s2 = String(s).trim().match(/^(\d{2})[.\-/](0?[1-9]|1[0-2])[.\-/](0?[1-9]|[12]\d|3[01])$/);
  if (s2) return [2000 + Number(s2[1]), Number(s2[2]), Number(s2[3])];
  return null;
}

// 'HH:mm' / 'HHmm' → [h, m] (날짜가 붙은 문자열에서는 뒤쪽 시각만 추출)
function hmFromString(s) {
  if (!s) return null;
  const str = String(s).trim();
  const colonParts = str.match(/(\d{1,2}):(\d{2})/g);
  if (colonParts && colonParts.length) {
    const last = colonParts[colonParts.length - 1];
    const [h, m] = last.split(':').map(Number);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return [h, m];
  }
  const hm = str.match(/(\d{2})(\d{2})/);
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) return [h, m];
  }
  return null;
}

const EVAL_DT_FULL_KEYS = [
  'scdlBgngDt', 'evlBgngDt', 'scdlDttm', 'bgngDttm', 'evlDt', 'scdlStartDt', 'evlStartDt',
  'startDt', 'bgngDt', 'scdlBeginDt', 'evlBgngDttm'
];
const EVAL_DT_DATE_KEYS = [
  'scdlDe', 'scdlDt', 'scdlYmd', 'evlDe', 'bgngYmd', 'evlYmd', 'scdlDay', 'evlDate', 'scdlDate'
];
const EVAL_DT_TIME_KEYS = [
  'scdlTime', 'scdlHm', 'bgngTm', 'bgngHm', 'bgngTime', 'evlBgngHm',
  'startTime', 'startHm', 'scdlStartHm'
]; // ※ 'endTm' 등 종료 시각 키는 넣지 않음 — 시작 날짜+종료 시각이 섞이는 오파싱 방지

// 평가 행에서 시작 시각(epoch ms) 추출 — 전체 일시 키 → 날짜+시각 키 조합 → 전 필드 스캔 순
export function extractEvalDateTimeMs(row) {
  if (!row || typeof row !== 'object') return null;

  // 1. 날짜+시각이 한 필드에 있는 형태
  for (const k of EVAL_DT_FULL_KEYS) {
    const v = pickFirst(row, [k]);
    if (!v) continue;
    const ymd = ymdFromString(v);
    const hm = hmFromString(v);
    if (ymd && hm) {
      return new Date(ymd[0], ymd[1] - 1, ymd[2], hm[0], hm[1], 0).getTime();
    }
  }

  // 2. 날짜 키 + 시각 키 조합
  let ymdV = null;
  for (const k of EVAL_DT_DATE_KEYS) {
    ymdV = ymdFromString(pickFirst(row, [k]));
    if (ymdV) break;
  }
  let hmV = null;
  for (const k of EVAL_DT_TIME_KEYS) {
    hmV = hmFromString(pickFirst(row, [k]));
    if (hmV) break;
  }
  if (ymdV && hmV) {
    return new Date(ymdV[0], ymdV[1] - 1, ymdV[2], hmV[0], hmV[1], 0).getTime();
  }

  // 3. 전 필드 스캔 (폴곤) — 완전한 일시 패턴을 가진 첫 값
  for (const v of Object.values(row)) {
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const s = String(v);
    if (!/20\d\d[.\-/]?\d{2}[.\-/]?\d{2}/.test(s)) continue;
    const ymd = ymdFromString(s);
    if (!ymd) continue;
    const hm = hmFromString(s) || [9, 0]; // 시각 없으면 오전 9시로 간주 (알림은 설정 lead로 조정됨)
    return new Date(ymd[0], ymd[1] - 1, ymd[2], hm[0], hm[1], 0).getTime();
  }
  return null;
}

// reqList[] → 정규화된 평가 일정 [{key, title, role, whenMs}] (+ 진단: skipped, nonEv, sampleKeys)
// - scdlGubunCd가 있고 'EV'가 아닌 행(오전점호/시험/멘토링 등)은 평가가 아니므로 nonEv로만 집계
// - sampleKeys는 진단 가치가 높은 "첫 번째 EV 행"의 키 목록 (EV 행이 없으면 첫 행)
export function parseScheduleRows(rawList) {
  const list = Array.isArray(rawList) ? rawList : [];
  const items = [];
  let skipped = 0;
  let nonEv = 0;
  let sampleKeys = null;
  let evSampleKeys = null;

  for (let i = 0; i < list.length; i++) {
    const row = list[i];
    if (!row || typeof row !== 'object') { skipped++; continue; }
    if (i === 0 && !sampleKeys) sampleKeys = Object.keys(row);

    const gubun = pickFirst(row, ['scdlGubunCd']);
    if (gubun && gubun !== EVAL_GUBUN_VALUE) { nonEv++; continue; } // 평가(EV)가 아닌 행
    if (!evSampleKeys) evSampleKeys = Object.keys(row);

    const fixed = pickFirst(row, ['fixedCd', 'fixedCode', 'sttsCd', 'stusCd']);
    if (fixed && EVAL_CANCEL_FIXED_CODES.includes(fixed)) continue; // 거절/취소/완료 제외

    const whenMs = extractEvalDateTimeMs(row);
    if (!whenMs || isNaN(whenMs)) { skipped++; continue; }

    const detail = pickFirst(row, ['reqDetail', 'reqDtl', 'detailCd']) || '';
    const dTokens = detail.split(/\|+/).filter(Boolean); // "R||35||…" → ['R','35','…']
    const role = (dTokens[0] === 'R' || dTokens[0] === 'A') ? dTokens[0] : '';
    const course = pickFirst(row, ['title', 'scdlGubunNm', 'lcorsNm', 'mtlEvlNm', 'evlNm', 'courseNm', 'projectNm', 'subjectNm', 'evlTtl', 'ttmsNm']) || '평가';
    const reqUsr = pickFirst(row, ['scdlReqUsr', 'reqUsrNm', 'reqNm']) || '';
    const roleLabel = role === 'R' ? '피평가자' : role === 'A' ? '평가자' : '평가';
    const title = reqUsr ? `${course} (${roleLabel}: ${reqUsr})` : `${course} (${roleLabel})`;

    const idParts = ['mtlEvlSn', 'scdlNo', 'evlScdlNo', 'evlNo', 'evlDegr', 'reqNo', 'scdlSn', 'scheduleNo', 'evalReqNo', 'evlReqNo']
      .map(k => pickFirst(row, [k]))
      .filter(Boolean);
    if (!idParts.length && dTokens.length >= 2) idParts.push(dTokens[1]); // reqDetail의 mtlEvlSn
    const key = (idParts.length ? idParts.join('_') : `${whenMs}_${detail}_${reqUsr}`)
      .replace(/[^A-Za-z0-9_.-]/g, '_');

    items.push({ key, title, role, whenMs });
  }

  // key 중복 제거(앞쪽 유지) + 시각순 정렬
  const seen = new Map();
  for (const it of items) {
    if (!seen.has(it.key)) seen.set(it.key, it);
  }
  return {
    items: [...seen.values()].sort((a, b) => a.whenMs - b.whenMs),
    skipped,
    nonEv,
    sampleKeys: evSampleKeys || sampleKeys
  };
}

// 이전 동기화 항목과 새 항목 비교 — added/removed/changed (시각·lead·제목 변경 감지)
export function diffEvalItems(prevItems, nextItems, leadMinutes) {
  const prevMap = new Map((Array.isArray(prevItems) ? prevItems : []).map(i => [i && i.key, i]));
  const nextMap = new Map((Array.isArray(nextItems) ? nextItems : []).map(i => [i && i.key, i]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [k, it] of nextMap) {
    if (!k) continue;
    const p = prevMap.get(k);
    if (!p) {
      added.push(it);
    } else if (p.whenMs !== it.whenMs || p.leadMinutes !== leadMinutes || p.title !== it.title) {
      changed.push({ ...it, name: p.name });
    }
  }
  for (const [k, p] of prevMap) {
    if (k && !nextMap.has(k)) removed.push(p);
  }
  return { added, removed, changed };
}
