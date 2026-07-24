// ============================================================
// 출입 데이터 공통 로직 (단일 소스)
// - background.js(익스텐션), capacitor-adapter.js(Android), popup.js가 공유
// - ES 모듈: 서비스 워커/모듈 스크립트에서 import
// ============================================================

// 서버 인정 규칙: 하루 최대 12시간까지만 합산 (사용자 설정값과 무관하게 고정)
export const SERVER_DAILY_CAP_HOURS = 12;
export const SERVER_DAILY_CAP_MINUTES = SERVER_DAILY_CAP_HOURS * 60;

// ===== 시각/기간 변환 =====
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

// 날짜 → 'YYYY.MM.DD' (평가 API 쿼리용 — background.js/capacitor-adapter.js 공용, 33차: 양쪽 동일 정의 통합)
export function formatDateYmdDot(d) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// '7월 20일 (월) 14:00' 형태 (알림 본문용 — background.js/capacitor-adapter.js 공용, 33차: 동일 정의 통합)
export function formatEvalWhenKo(ms) {
  const d = new Date(ms);
  const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${wd}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

// ===== 계산기 입력 파싱 (35차: 텍스트 상자 폐기에 맞춰 순수 함수로 이동 — 단위 테스트 대상) =====
// 시계 시각 'HH:MM' (00:00~23:59) → 자정부터 분. 입력 칸 값 전용 (빈값/범위 밖 null)
export function parseClockHHMM(val) {
  if (!val || typeof val !== 'string' || !val.includes(':')) return null;
  const [h, m] = val.split(':').map(Number);
  if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

// 목표 기간 'HH:MM' (00:01 ~ maxHours, 기본 서버 일 상한 12:00) → 분 (36차: 시간/분 두 칸 → 단일 HH:MM 칸)
export function parseGoalDurationHHMM(val, maxHours = SERVER_DAILY_CAP_HOURS) {
  const minutes = parseClockHHMM(val);
  if (minutes === null) return null;
  return minutes >= 1 && minutes <= maxHours * 60 ? minutes : null;
}

// 날짜 + 시각 문자열 → 로컬 타임스탬프(ms)
export function parseEntryTimestamp(dateStr, entryTime) {
  if (!dateStr || !entryTime) return null;
  const time = entryTime.length === 5 ? `${entryTime}:00` : entryTime;
  const ts = new Date(`${dateStr}T${time}`).getTime();
  return isNaN(ts) ? null : ts;
}

// 미퇴실(열린) 세션이 "현재 입실 중"으로 인정되는 최대 시간 — 서버 일 12시간 캡 + 1시간 여유.
// 이 시간을 넘긴 미퇴실 세션은 퇴실 태그 누락/자동 퇴실 등 낡은 기록으로 보고 입실 중에서 제외한다.
// (이전엔 날짜와 무관하게 영구 누적되어, 며칠 전 미퇴실 세션 때문에 "입실 중 · 12시간 채움"으로 표시되는 결함 — S1)
export const MAX_OPEN_SESSION_MS = 13 * 60 * 60 * 1000;
export const MAX_OPEN_SESSION_MINUTES = MAX_OPEN_SESSION_MS / 60000;
export function isOpenSessionFresh(entryTs, nowMs = Date.now()) {
  return !!entryTs && entryTs <= nowMs && (nowMs - entryTs) <= MAX_OPEN_SESSION_MS;
}

// 마지막 입실부터 현재까지 경과 분 (자정 경계 안전, S1: 개방 세션 상한 캡)
export function elapsedSinceEntry(parsed, nowMs = Date.now()) {
  if (!parsed || !parsed.isCurrentlyIn) return 0;
  if (parsed.entryTimestamp) {
    if (!isOpenSessionFresh(parsed.entryTimestamp, nowMs)) return 0; // 낡은 개방 세션 이중 방어
    return Math.min(
      Math.max(0, Math.floor((nowMs - parsed.entryTimestamp) / 60000)),
      MAX_OPEN_SESSION_MINUTES
    );
  }
  if (parsed.lastInTime === null) return 0;
  const now = new Date(nowMs);
  const nowMin = now.getHours() * 60 + now.getMinutes();
  return Math.max(0, nowMin - parsed.lastInTime);
}

// 두 월 데이터의 detail_list를 하나로 병합 (월 경계 입실·야간 퇴실 감지용 — B8)
export function mergeDetailLists(a, b) {
  const al = (a && (a.detail_list || a.result || a.data)) || [];
  const bl = (b && (b.detail_list || b.result || b.data)) || [];
  if (!al.length) return b;
  if (!bl.length) return a;
  return { detail_list: [...al, ...bl] };
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
// - 퇴실 누락 세션이 "현재 입실 중"이려면 입실 시각이 MAX_OPEN_SESSION_MS 이내여야 함 (S1)
//   → 더 오래된 미퇴실 세션은 낡은 기록으로 간주하고 staleOpenSession에만 남김
export function parseAttendance(data, targetDate = new Date(), nowMs = Date.now()) {
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
  let staleOpenSession = null; // S1: 최근 미퇴실 세션 중 인정 한도(13h)를 넘긴 낡은 세션 (진단용)
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
        const ts = parseEntryTimestamp(dateStr, session.entry_time);
        if (isOpenSessionFresh(ts, nowMs)) {
          // 유효한 개방 세션 — 현재 입실 중
          isCurrentlyIn = true;
          lastInTime = entryMin;
          lastOutTime = null;
          entryTimestamp = ts;
        } else {
          // S1: 13시간 이상 경과한 미퇴실 세션은 낡은 기록 (퇴실 태그 누락/자동 퇴실)
          if (ts) staleOpenSession = { dateStr, entry: session.entry_time };
        }
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
    staleOpenSession,
    dailyBreakdown,
    rawDetailList: detailList
  };
}

// 전월 데이터에서 미퇴실 세션 감지 (월 경계 입실 — R2)
// parsed에 입실 중 세션이 없을 때만 적용. 변경 시 true 반환.
// S1: MAX_OPEN_SESSION_MS(13h) 이내 개방 세션만 유효 — 더 오래된 전월 미퇴실은 낡은 기록
export function applyOvernightFromPrevMonth(parsed, prevMonthData, nowMs = Date.now()) {
  if (!parsed || parsed.isCurrentlyIn || !prevMonthData) return false;
  const detailList = prevMonthData.detail_list || prevMonthData.result || prevMonthData.data || [];

  // 뒤에서부터(최근 날짜 우선) 퇴실 누락 세션 탐색
  for (let i = detailList.length - 1; i >= 0; i--) {
    const day = detailList[i];
    const dateStr = day.date || '';
    if (!dateStr) continue;
    for (const session of (day.sessions || [])) {
      const entryMin = timeStrToMinutes(session.entry_time);
      if (session.is_missing === true && session.missing_type === 'exit' && entryMin !== null) {
        const ts = parseEntryTimestamp(dateStr, session.entry_time);
        if (!isOpenSessionFresh(ts, nowMs)) {
          if (ts) parsed.staleOpenSession = { dateStr, entry: session.entry_time };
          return false; // 가장 최근 미퇴실 세션조차 낡았으면 더 오래된 것은 볼 필요 없음
        }
        parsed.isCurrentlyIn = true;
        parsed.lastInTime = entryMin;
        parsed.lastOutTime = null;
        parsed.entryTimestamp = ts;
        return true;
      }
    }
  }
  return false;
}

// ===== 29차: 자정 롤오버 — 전날 시작 미퇴실 세션 "임시 기록" 처리 =====
// 문제: 자정을 넘겨도 퇴실 기록이 없으면, 전날 입실부터 현재까지의 경과가
// 그대로 오늘 누적으로 표시되어 "당일 기록처럼 보이는" 결함이 있었다.
// 정책:
//  ① 자정이 지나 세션이 열린 채면 "임시" 상태 — 오늘 집계 합산 제외 + 괄호 표기
//  ② 사용자에게 알람/배너로 확인: 밤샘(집계 정상 반영) / 퇴실 누락(계속 제외)
//  ③ 확인 결과는 OVERNIGHT_PREF_KEY 로 저장 (앱은 Capacitor Preferences=네이티브 공유)

export const OVERNIGHT_PREF_KEY = 'overnight_decision';

function localDateStrOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function localHHMMOf(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 현재 입실 중인 세션이 "전날(또는 그 이전)"에 시작됐는지 감지
export function detectCrossMidnightOpen(parsed, nowMs = Date.now()) {
  if (!parsed || !parsed.isCurrentlyIn || !parsed.entryTimestamp) return null;
  const entry = new Date(parsed.entryTimestamp);
  const now = new Date(nowMs);
  if (localDateStrOf(entry) === localDateStrOf(now)) return null; // 같은 날 — 롤오버 아님
  const dayMs = 24 * 60 * 60 * 1000;
  return {
    entryTimestamp: parsed.entryTimestamp,
    entryDateStr: localDateStrOf(entry),
    entryTimeStr: localHHMMOf(entry),
    crossedDays: Math.max(1, Math.round((new Date(localDateStrOf(now)) - new Date(localDateStrOf(entry))) / dayMs)),
    elapsedMinutes: Math.max(0, Math.floor((nowMs - parsed.entryTimestamp) / 60000))
  };
}

// 저장된 확인 결과 유효성 검사 — 감지된 전날 입실 건과 날짜/회원이 일치할 때만 적용
// raw: localStorage/prefs에 저장된 JSON 문자열 또는 객체 {entryDate, memberId, decision, at}
export function readOvernightDecision(raw, detection, memberId) {
  if (!detection || !raw) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch (e) { return null; }
  }
  if (!obj || obj.entryDate !== detection.entryDateStr) return null;
  if (memberId && obj.memberId && obj.memberId !== memberId) return null;
  return (obj.decision === 'overnight' || obj.decision === 'missing') ? obj.decision : null;
}

// 오늘 경과분 합산 여부 — 미확인(임시)/누락이면 제외, 밤샘이면 기존 규칙대로 포함
export function includeCrossMidnightElapsed(detection, decision) {
  if (!detection) return true;
  return decision === 'overnight';
}

// 29차 인지형 버전의 오늘 인정 시간 (임시/누락이면 오늘분 경과 미합산 → 당일 기록 오인 방지)
export function recognizedTodayOvernightAware(parsed, detection, decision, nowMs = Date.now()) {
  if (!parsed) return 0;
  if (!includeCrossMidnightElapsed(detection, decision)) return parsed.dailyTotal;
  return recognizedToday(parsed, nowMs);
}

// 29차 인지형 월 누적 (임시/누락이면 서버 확정분만)
export function recognizedMonthlyOvernightAware(parsed, detection, decision, nowMs = Date.now()) {
  if (!parsed) return 0;
  if (!includeCrossMidnightElapsed(detection, decision)) return parsed.monthlyTotal;
  return recognizedMonthly(parsed, nowMs);
}

// 상태 표시 괄호 문구: 임시 / 밤샘 / 누락 — 사용자 요청의 "()로 묶어 처리"
export function overnightStatusSuffix(detection, decision) {
  if (!detection) return '';
  const base = `전날 ${detection.entryTimeStr} 입실`;
  if (decision === 'overnight') return ` (${base}부터 · 밤샘 집계)`;
  if (decision === 'missing') return ` (${base} · 퇴실 누락 — 오늘 집계 제외)`;
  return ` (${base}부터 · 임시 — 확인 필요)`;
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
// C2: "평가 일정 감지" 알림은 확정/진행(00002/00003) 상태일 때만 — 00001(요청·협의중)은
// 알람만 조용히 등록 (파기 가능성이 있는 협의 시간으로 미리 알리지 않음). 미상(코드 없음)은 알림.
export const EVAL_CONFIRMED_STATES = ['00002', '00003'];
export function isEvalConfirmed(state) {
  return !state || EVAL_CONFIRMED_STATES.includes(state);
}

// 멤버 정보 응답 어디에 있든 instCd를 재귀 탐색 (키 이름만 확실하다는 전제)
// S4: 숫자형(instCd: 21)도 수용 (JSON number로 오는 변종 대비 — 자동 감지 실패로
// 평가 동기화가 no_instcd 상태로 멈추는 경로 방지. 실패 시 설정 수동 입력 안내와 병행)
export function findInstCd(root) {
  if (!root || typeof root !== 'object') return null;
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
    seen.add(cur);
    for (const [k, v] of Object.entries(cur)) {
      if (/^inst(cd|code)?$/i.test(k)) {
        if (typeof v === 'string' && v.trim()) return v.trim();
        if (typeof v === 'number' && Number.isFinite(v)) return String(v);
      }
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

    items.push({ key, title, role, whenMs, state: fixed || '' }); // state=고정코드(협의/확정 구분 알림용)
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

// ============================================================
// E3: 알림함(alarm/alarmList/list) 기반 평가 감지 채널 (15차)
// - "평가가 잡혔다"는 시스템 알림(알림함)에서 평가 정보를 읽어 알람을 잡는 보조 채널
// - 실측 샘플(2026-07-14, 사용자 제공): sysDivCd 00017 "동료평가자로 지정 되었습니다."
//   pstartCn: <평가일정> 요청자 / Discord ID / 평가예정일시(YYYY-MM-DD HH:MM:SS) /
//             프로젝트명 / 학습과정명 / 단위문제명 (HTML 엔티티·<br/> 포함)
// - 선별 규칙: 본문에서 "평가예정일시" 시각을 파싱할 수 있는 행만 채택
//   (sysDivCd 00017 선호하되 미상의 변종 코드도 본문 신호로 수용)
// - "평가종료"(00020) 등 종료 계열은 '평가예정일시'가 아니라 '평가종료일시'라 자연 제외
// - 캐시(pstartSn)로 신규 1회만 알림 → N분 전 알람까지 이어지는 흐름은 각 클라이언트가 구현
// ============================================================
export const EVAL_NOTICE_SYS_CODES = ['00017']; // 실측: 동료평가자 지정
export const EVAL_NOTICE_PAGE_PER_ROWS = 30; // 최신 알림 1페이지 이상 여유 있게
export const EVAL_NOTICE_DEDUP_MS = 2 * 60 * 1000; // 스케줄 채널 알람과 같은 평가로 볼 시각 오차
export const EVAL_NOTICE_SEEN_TTL_MS = 90 * 24 * 3600 * 1000; // seen 캐시 보존 기간

// 알림 본문 HTML 디코드: 엔티티 풀고 <br>은 개행, 나머지 태그는 제거
export function unescapeAlarmHtml(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/gi, '&') // 다른 치환 뒤에 &amp; 처리 (연속 엔티티 안전)
    .replace(/\r/g, '');
}

// 라인 필드(label : value) 추출 — 개행까지. 괄호 안 부가정보(이메일)는 분리해 반환
function noticeField(text, label, groupLabels = []) {
  const labels = [label, ...groupLabels].join('|');
  const m = text.match(new RegExp(`^\\s*(?:${labels})\\s*[:：]\\s*(.+)$`, 'm'));
  return m ? m[1].trim() : '';
}

export function parseEvalNoticeDateTimeMs(text) {
  const m = text.match(/평가예정일시\s*[:：]\s*(20\d\d)-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[ T]([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?/);
  if (!m) return null;
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), m[6] ? Number(m[6]) : 0
  ).getTime();
}

// alarmList result.list[] → 평가 지정 알림만 [{key, pstartSn, title, whenMs, role, ...}]
export function parseEvalNoticeAlarms(rawList, nowMs = Date.now()) {
  const list = Array.isArray(rawList) ? rawList : [];
  const items = [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const body = unescapeAlarmHtml(row.pstartCn || '');
    if (!/평가예정일시/.test(body)) continue; // 본문 신호 — 종료/포인트/레벨 등은 여기서 배제
    const whenMs = parseEvalNoticeDateTimeMs(body);
    if (!whenMs || isNaN(whenMs)) continue;

    const title0 = String(row.pstartTitlNm || '').trim();
    if (/종료|취소/.test(title0) && !/지정|배정|안내/.test(title0)) continue; // 종료/취소 변종 방어

    const requesterRaw = noticeField(body, '요청자');
    const requester = requesterRaw.replace(/\s*\([^)]*\)\s*$/, '').trim(); // 이름(이메일) → 이름
    const project = noticeField(body, '프로젝트명');
    const course = noticeField(body, '학습과정명');
    const mission = noticeField(body, '단위문제명');
    const discordId = noticeField(body, 'Discord ID', ['Discord']) || '';

    const role = /동료평가자/.test(title0 + ' ' + body) ? 'A'
      : /피평가자|평가\s*(요청|신청)/.test(title0 + ' ' + body) ? 'R' : '';
    const roleLabel = role === 'A' ? '평가자' : role === 'R' ? '피평가자' : '';

    const bits = [];
    if (roleLabel) bits.push(roleLabel);
    if (requester) bits.push(`요청자: ${requester}`);
    const title = `${project || '평가'}${bits.length ? ` (${bits.join(' · ')})` : ''}`;

    const sn = row.pstartSn !== null && row.pstartSn !== undefined ? String(row.pstartSn) : '';
    if (!sn) continue;
    items.push({
      key: `notice_${sn}`,
      pstartSn: sn,
      title,
      whenMs,
      role,
      requester,
      project,
      course,
      mission,
      discordId,
      readYn: row.readYn || '',
      sysDivCd: row.sysDivCd || '',
      regDt: row.regDt || '',
      past: whenMs <= nowMs
    });
  }
  // 시각순 정렬 + pstartSn 중복 제거(앞쪽 유지)
  const seen = new Set();
  return items
    .sort((a, b) => a.whenMs - b.whenMs)
    .filter(it => (seen.has(it.pstartSn) ? false : (seen.add(it.pstartSn), true)));
}

// seen 캐시({sn: {...}}) 대비 신규 알림만 추림
export function filterNewEvalNotices(seenIds, items) {
  const seen = seenIds && typeof seenIds === 'object' ? seenIds : {};
  return (Array.isArray(items) ? items : []).filter(it => it && !seen[it.pstartSn]);
}

// ===== L2(16차): 로그인 서버 오류 해석 =====
// 실측(sandbox/README 부록 3): AMS /authenticate는 401 + {message_code, success:false, message}로 거부.
//  - 등록된 이메일 + 비번 불일치 → "등록되지 않은 회원입니다." (문구는 오해 소지가 크지만
//    미등록 이메일에는 "입력하신 아이디 혹은 비밀번호가 일치하지 않습니다."가 나가므로 구분됨)
//  - 5회 연속 실패 → message_code "E0001", 10분 잠금
// 공식 사이트도 이 message를 그대로 alert하므로 동일 문구가 공식 사이트에서도 노출된다.
// 반환: 안내 문구(줄바꿈 포함) 또는 null(특별 매핑 없음 — 호출부가 원문 표시).
export function describeLoginServerError(status, body) {
  const msg = (body && typeof body.message === 'string') ? body.message : '';
  const code = body ? (body.message_code || body.code || '') : '';
  if (code === 'E0001' || /입력정보가 틀려|로그인이 제한/.test(msg)) {
    return '5회 이상 입력 정보가 틀려 10분간 로그인이 제한됩니다. 잠시 후 다시 시도해주세요.';
  }
  if (/등록되지 않은 회원/.test(msg)) {
    return '비밀번호가 일치하지 않거나, 이 계정에 비밀번호가 등록되어 있지 않습니다.\n'
      + '· 비밀번호를 다시 확인해주세요 (대소문자 · 한/영 키 · 앞뒤 공백).\n'
      + '· Google/네이버 등 소셜 계정으로 가입했다면 비밀번호가 없을 수 있습니다 — 공식 사이트(ams.codyssey.kr)의 "비밀번호 찾기"에서 먼저 설정해주세요.\n'
      + '· 공식 사이트에서도 같은 문구가 나오면 비밀번호 재설정이 필요합니다.\n'
      + '(서버 응답: ' + msg + ')';
  }
  return null;
}

// 비밀번호 앞뒤 공백/보이지 않는 문자로 인한 오입력 재시도 판정 (모바일 붙여넣기 대응)
export function shouldRetryTrimmedPassword(rawPassword, errorMessage) {
  if (!/등록되지 않은 회원|일치하지 않습니다|비밀번호/.test(errorMessage || '')) return false;
  return !!sanitizePasswordCandidate(rawPassword);
}

// ===== L2+(17차): 붙여넣기 오염 대응 — 보이지 않는 문자 정리·진단 =====
// 메모앱/메신저/패스워드 매니저에서 복사한 자격증명은 끝 공백·줄바꿈·제로폭 문자
// (U+200B/200C/200D/2060/FEFF, NBSP U+00A0)를 동반하는 사례가 잦다.
// .trim()은 이 중 일부(제로폭 등)를 제거하지 못하므로 명시 클래스로 처리한다.
// 비밀번호 난수에는 절대 내용을 표시하지 않고 개수·클스만 진단에 쓴다.
export function stripEdgeInvisibles(s) {
  if (typeof s !== 'string') return '';
  const EDGE = '^[​‌‍⁠﻿ ]+|[​‌‍⁠﻿ ]+$';
  let out = s;
  let prev;
  do {
    prev = out;
    out = out.trim().replace(new RegExp(EDGE, 'g'), '');
  } while (out !== prev);
  return out;
}

// 실패 재시도용 후보: 앞뒤 공백·보이지 않는 문자를 모두 걷어낸 비밀번호 (없으면 null)
export function sanitizePasswordCandidate(rawPassword) {
  if (typeof rawPassword !== 'string' || rawPassword.length === 0) return null;
  const candidate = stripEdgeInvisibles(rawPassword);
  if (candidate === rawPassword || candidate === '') return null;
  return { candidate, removed: rawPassword.length - candidate.length };
}

// 진단 요약: 내용은 절대 포함하지 않고 길이와 문자 클래스만 표기
export function credentialInputDigest(email, password) {
  const em = typeof email === 'string' ? email : '';
  const pw = typeof password === 'string' ? password : '';
  const parts = [`이메일 ${em.length}자`, `비밀번호 ${pw.length}자`];
  const emEdge = em.length - stripEdgeInvisibles(em).length;
  if (emEdge > 0) parts.push(`이메일 앞뒤 공백/보이지 않는 문자 ${emEdge}개`);
  const stripped = stripEdgeInvisibles(pw);
  const pwEdge = pw.length - stripped.length;
  if (pwEdge > 0) parts.push(`비밀번호 앞뒤 공백/보이지 않는 문자 ${pwEdge}개`);
  const inner = (stripped.match(/[​‌‍⁠﻿ ]/g) || []).length;
  if (inner > 0) parts.push(`비밀번호 중간 보이지 않는 문자 ${inner}개`);
  if (/[‘’“”–—]/.test(pw)) parts.push('스마트 따옴표/대시 포함');
  return parts.join(' · ');
}

// ===== 19차: 세션 진단 링버퍼 (네이티브 DiagLog.java와 같은 형식: {t, tag, msg}) =====
export const DIAG_LOG_MAX = 80;

export function diagRingAppend(list, entry, max = DIAG_LOG_MAX) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (entry && entry.msg) arr.push(entry);
  while (arr.length > max) arr.shift();
  return arr;
}

export function formatDiagEntry(e) {
  if (!e || !e.t) return '';
  const d = new Date(e.t);
  const md = (d.getMonth() + 1) + '/' + d.getDate();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return md + ' ' + hh + ':' + mm + ':' + ss + ' [' + (e.tag || '-') + '] ' + (e.msg || '');
}

// ===== 31차(C안): 물리 탐지 판정 엔진 — android PhysicalCheck.java의 미러 =====
// 양쪽이 같은 상수/규칙을 유지해야 팝업 표시와 네이티브 알림이 어긋나지 않는다.
// 값을 바꾸면 PhysicalCheck.java도 함께 바꿀 것.
export const PHY_WEIGHT_SSID = 2;
export const PHY_WEIGHT_BSSID = 3;
export const PHY_WEIGHT_CELL = 1;
export const PHY_THRESHOLD_INSIDE = 3;
export const PHY_STREAK_FLIP = 2;   // inside 전환에 필요한 연속 평가 수
export const PHY_STREAK_ALERT = 2;  // 오탐 방지 — 5분 틱 × 2 = 최소 10분 후 알림
export const PHY_SCORE_CAP = 6;

// 신호 vs 학습 테이블 적중 점수 (PhysicalCheck.scoreSignals와 동일)
export function scorePhySignals(signals, locations) {
  const sig = signals || {};
  const locs = Array.isArray(locations) ? locations : [];
  let score = 0;
  for (const loc of locs) {
    if (!loc || !loc.kind) continue;
    if (loc.kind === 'ssid' && sig.ssid && sig.ssid === loc.value) score += PHY_WEIGHT_SSID;
    else if (loc.kind === 'bssid' && sig.bssid
             && String(sig.bssid).toLowerCase() === String(loc.value).toLowerCase()) score += PHY_WEIGHT_BSSID;
    else if (loc.kind === 'cell' && Array.isArray(sig.cells) && sig.cells.includes(loc.value)) score += PHY_WEIGHT_CELL;
  }
  return Math.min(score, PHY_SCORE_CAP);
}

// 1회 평가 → 다음 상태 + 알림 여부 (PhysicalCheck.decide와 동일 규칙)
// prev: {inside: true|false|null, streakIn, streakOut}
// obs:  {sessionOpen: true|false|null, score, hasSignal, hasLearned}
// 반환: {inside, streakIn, streakOut, alert: 'S1'|'S2'|null}
export function physicalDecision(prev, obs) {
  const inside = prev && prev.inside !== undefined ? prev.inside : null;
  const prevIn = (prev && prev.streakIn) || 0;
  const prevOut = (prev && prev.streakOut) || 0;
  const o = obs || {};

  let cand = null; // 판정 후보: 학습 테이블이 없거나 신호가 아예 없으면 판정 보류
  if (o.hasSignal && o.hasLearned) cand = (o.score || 0) >= PHY_THRESHOLD_INSIDE;

  let streakIn = prevIn, streakOut = prevOut, nextInside = inside;
  if (cand === null) { streakIn = 0; streakOut = 0; }
  else if (cand) {
    streakIn = prevIn + 1; streakOut = 0;
    if (streakIn >= PHY_STREAK_FLIP) nextInside = true;
  } else {
    streakOut = prevOut + 1; streakIn = 0;
    if (streakOut >= PHY_STREAK_FLIP) nextInside = false;
  }

  let alert = null;
  if (o.sessionOpen === true && nextInside === false && streakOut >= PHY_STREAK_ALERT) alert = 'S2';
  else if (o.sessionOpen === false && nextInside === true && streakIn >= PHY_STREAK_ALERT) alert = 'S1';

  return { inside: nextInside, streakIn, streakOut, alert };
}

// 29차 자정 확인 배너에 붙는 물리 근거 문구 (31차 시너지)
// inside: true = 학원 신호 감지(밤샘 근거), false = 학원 밖(퇴실 누락 근거), null/기타 = 근거 없음
export function overnightEvidenceSuffix(inside) {
  if (inside === true) return ' (물리 근거: 학원 신호 감지 중 — 밤샘 가능성 높음)';
  if (inside === false) return ' (물리 근거: 학원 신호 없음 — 퇴실 누락 가능성 높음)';
  return '';
}

// ===== 36차: 월 마감 임박 경고 규칙 (자바 MonthlyDeadlineCheck와 동일 규칙 — 상수/공식 변경 시 양쪽 수정) =====
// (월 필수 − 누적) ÷ 남은 날(오늘 포함)이 12시간/일에 근접하면 미리 알림.
//   level 2: 오늘 기준 필요 페이스가 이미 12h/일 이상 (매일 상한을 채워도 목표 불가)
//   level 1(전전날 경고): 2일 뒤부터 필요 페이스가 12h/일 이상 — 지금 페이스를 올려야 함
export function monthlyDeadlineAlert(recognizedMin, requiredHours, daysLeftIncludingToday) {
  const requiredMin = requiredHours * 60;
  const rem = Math.max(0, requiredMin - recognizedMin);
  if (rem <= 0 || !Number.isFinite(rem) || daysLeftIncludingToday < 1) return null;
  const perDay = rem / daysLeftIncludingToday;
  if (perDay >= SERVER_DAILY_CAP_MINUTES) {
    return { level: 2, requiredPerDayMin: Math.ceil(perDay), daysLeft: daysLeftIncludingToday };
  }
  if (daysLeftIncludingToday > 2 && rem / (daysLeftIncludingToday - 2) >= SERVER_DAILY_CAP_MINUTES) {
    return { level: 1, requiredPerDayMin: Math.ceil(perDay), daysLeft: daysLeftIncludingToday };
  }
  return null;
}

// ===== 45차: 캘린더 날짜 상세(모달) =====
// 특정 날짜의 원본 세션 목록 (기록 없음/미래/파싱 전은 빈 배열)
export function getDaySessions(parsed, dateStr) {
  const list = parsed?.rawDetailList || [];
  const day = list.find(d => d && d.date === dateStr);
  return (day && Array.isArray(day.sessions)) ? day.sessions : [];
}

// 세션 한 건의 표시 상태 분류: normal | open(유효 개방=입실 중) | stale_exit(낡은 미퇴실) | no_entry(입실 누락)
// minutes는 출입 쌍이 유효(exit >= entry)할 때만
export function describeDaySession(session, dateStr, todayStr, nowMs = Date.now()) {
  const entryMin = timeStrToMinutes(session?.entry_time);
  const exitMin = timeStrToMinutes(session?.exit_time);
  if (session?.is_missing === true && session?.missing_type === 'entry') {
    return { kind: 'no_entry', entryMin, exitMin, minutes: null };
  }
  if (entryMin !== null && exitMin === null) {
    const ts = parseEntryTimestamp(dateStr, session.entry_time);
    const open = dateStr === todayStr && isOpenSessionFresh(ts, nowMs);
    return { kind: open ? 'open' : 'stale_exit', entryMin, exitMin: null, minutes: null };
  }
  const valid = entryMin !== null && exitMin !== null && exitMin >= entryMin;
  return { kind: 'normal', entryMin, exitMin, minutes: valid ? exitMin - entryMin : null };
}

// ===== 47차: 실제 체류(원시) 시간 — 서버 인정(12h 캡)과 분리 =====
// 세션 목록의 실제 체류 합 (출입 쌍이 유효한 완료 세션만)
export function rawStayMinutesFromSessions(sessions) {
  let sum = 0;
  for (const s of sessions || []) {
    const d = describeDaySession(s, '', '');
    if (d.kind === 'normal' && d.minutes !== null) sum += d.minutes;
  }
  return sum;
}

// 특정 날짜의 실제 체류 분
export function rawStayMinutesForDate(parsed, dateStr) {
  return rawStayMinutesFromSessions(getDaySessions(parsed, dateStr));
}

// 오늘 실제 체류 = 원시 세션 합 + 진행 중 세션 경과 (인정 캡 미적용 — 체류 상한 초과 알림/캘린더 초과 표시 기준)
export function rawStayTodayMinutes(parsed, nowMs = Date.now()) {
  const todayStr = getTodayString();
  let sum = rawStayMinutesForDate(parsed, todayStr);
  if (parsed?.isCurrentlyIn && parsed.entryTimestamp) {
    sum += Math.max(0, Math.floor((nowMs - parsed.entryTimestamp) / 60000));
  }
  return sum;
}
