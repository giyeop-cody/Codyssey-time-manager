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
export function applyOvernightFromPrevMonth(parsed, prevMonthData) {
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
