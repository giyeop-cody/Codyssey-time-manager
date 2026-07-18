// ============================================================
// shared-attendance.js 단위 테스트 (node:test + assert)
// 실행: npm run test:js  (node --test tests/)
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SERVER_DAILY_CAP_MINUTES,
  timeToMinutes,
  minutesToHHMM,
  durationToMinutes,
  timeStrToMinutes,
  parseEntryTimestamp,
  elapsedSinceEntry,
  recognizedToday,
  recognizedMonthly,
  projectedMonthly,
  parseAttendance,
  applyOvernightFromPrevMonth,
  isOpenSessionFresh,
  MAX_OPEN_SESSION_MS,
  parseEvalNoticeAlarms,
  filterNewEvalNotices,
  unescapeAlarmHtml,
  getTodayString,
  describeLoginServerError,
  shouldRetryTrimmedPassword,
  buildAlarmName,
  legacyAlarmName,
  parseAlarmName,
  ALARM_PREFIX,
  LEGACY_ALARM_PREFIX
} from '../web/js/shared-attendance.js';

// ===== 픽스처 헬퍼 (오늘 날짜 기준으로 동적 생성 → 날짜 독립적) =====
const today = getTodayString();
const [T_YEAR, T_MONTH] = today.split('-').map(Number);

// 전월 (1월이면 전년 12월)
const pmDate = new Date(T_YEAR, T_MONTH - 2, 1);
const PM_Y = pmDate.getFullYear();
const PM_M = String(pmDate.getMonth() + 1).padStart(2, '0');

function dayEntry(date, totalDuration, sessions = []) {
  return { date, daily_total_duration: totalDuration, sessions };
}

function session(entryTime, exitTime, isMissing = false, missingType = null) {
  return { entry_time: entryTime, exit_time: exitTime, is_missing: isMissing, missing_type: missingType };
}

// ===== 기본 변환 =====
test('timeToMinutes: HH:MM → 분', () => {
  assert.equal(timeToMinutes('09:30'), 570);
  assert.equal(timeToMinutes('0:05'), 5);
  assert.equal(timeToMinutes(''), 0);
  assert.equal(timeToMinutes(null), 0);
});

test('minutesToHHMM: 분 → HH:MM 문자열', () => {
  assert.equal(minutesToHHMM(0), '00:00');
  assert.equal(minutesToHHMM(720), '12:00');
  assert.equal(minutesToHHMM(65), '01:05');
  assert.equal(minutesToHHMM(null), '--:--');
  assert.equal(minutesToHHMM(NaN), '--:--');
});

test('durationToMinutes: HH:MM:SS / HH:MM 파싱', () => {
  assert.equal(durationToMinutes('12:00:00'), 720);
  assert.equal(durationToMinutes('01:30:00'), 90);
  assert.equal(durationToMinutes('02:15'), 135);
  assert.equal(durationToMinutes('00:00:59'), 1); // 초 반올림
  assert.equal(durationToMinutes(''), 0);
  assert.equal(durationToMinutes(undefined), 0);
  assert.equal(durationToMinutes('bad:data'), 0);
});

test('timeStrToMinutes: 파싱 불가 시 null', () => {
  assert.equal(timeStrToMinutes('08:45'), 525);
  assert.equal(timeStrToMinutes('08:45:30'), 525);
  assert.equal(timeStrToMinutes(''), null);
  assert.equal(timeStrToMinutes('--:--'), null);
});

test('parseEntryTimestamp: 날짜+시각 → 로컬 타임스탬프', () => {
  const ts = parseEntryTimestamp('2026-01-05', '09:00');
  assert.equal(ts, new Date(2026, 0, 5, 9, 0, 0).getTime());
  assert.equal(parseEntryTimestamp('2026-01-05', '09:00:00'), ts);
  assert.equal(parseEntryTimestamp(null, '09:00'), null);
  assert.equal(parseEntryTimestamp('2026-01-05', null), null);
});

// ===== 실시간 경과 =====
test('elapsedSinceEntry: entryTimestamp 기준 (자정 경계 안전)', () => {
  const now = Date.now();
  const parsed = { isCurrentlyIn: true, entryTimestamp: now - 95 * 60000, lastInTime: null };
  assert.equal(elapsedSinceEntry(parsed, now), 95);
});

test('elapsedSinceEntry: 미입실 시 0', () => {
  const parsed = { isCurrentlyIn: false, entryTimestamp: Date.now() - 60000, lastInTime: 500 };
  assert.equal(elapsedSinceEntry(parsed), 0);
});

test('elapsedSinceEntry: timestamp 없으면 lastInTime 폴리곤(당일 한정)', () => {
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const parsed = { isCurrentlyIn: true, entryTimestamp: null, lastInTime: nowMin - 30 };
  assert.equal(elapsedSinceEntry(parsed, now.getTime()), 30);
});

// ===== 서버 캡 적용 계산 (초기 요구사항: 주·일 12시간 캡) =====
test('recognizedToday: 서버 누적 + 경과, 12h 캡', () => {
  const now = Date.now();
  const base = { dailyTotal: 300, isCurrentlyIn: true, entryTimestamp: now - 60 * 60000, lastInTime: null };
  assert.equal(recognizedToday(base, now), 360);
});

test('recognizedToday: 12시간 초과분 절삭', () => {
  const now = Date.now();
  // 서버 700분 + 경과 60분 = 760 → 720 캡
  const over = { dailyTotal: 700, isCurrentlyIn: true, entryTimestamp: now - 60 * 60000, lastInTime: null };
  assert.equal(recognizedToday(over, now), SERVER_DAILY_CAP_MINUTES);
});

test('recognizedMonthly: 오늘 경과분은 남은 캡까지만 합산', () => {
  const now = Date.now();
  // 오늘 서버 700분(캡까지 20분 남음), 경과 60분 → 20분만 반영
  const parsed = { monthlyTotal: 5000, dailyTotal: 700, isCurrentlyIn: true, entryTimestamp: now - 60 * 60000, lastInTime: null };
  assert.equal(recognizedMonthly(parsed, now), 5020);
});

test('projectedMonthly: 추가시간은 캡 적용 후 오늘분으로 합산', () => {
  const now = Date.now();
  // 오늘 서버 700 + 추가 60 → 720 캡. 월 5000 - 오늘 700 + 720 = 5020
  const parsed = { monthlyTotal: 5000, dailyTotal: 700, isCurrentlyIn: false, entryTimestamp: null, lastInTime: null };
  assert.equal(projectedMonthly(parsed, 60, now), 5020);
});

test('projectedMonthly: 캡 미만이면 그대로 합산', () => {
  const parsed = { monthlyTotal: 1000, dailyTotal: 100, isCurrentlyIn: false, entryTimestamp: null, lastInTime: null };
  assert.equal(projectedMonthly(parsed, 50), 1050);
});

// ===== 파싱 =====
test('parseAttendance: 월 합산은 서버 일별 캡 값의 합', () => {
  const y = T_YEAR;
  const m = String(T_MONTH).padStart(2, '0');
  const data = { detail_list: [
    dayEntry(`${y}-${m}-02`, '11:30:00'),
    dayEntry(`${y}-${m}-03`, '12:00:00'), // 서버 캡 적용된 값
    dayEntry(today, '04:00:00')
  ] };
  const parsed = parseAttendance(data);
  assert.equal(parsed.monthlyTotal, 690 + 720 + 240);
  assert.equal(parsed.dailyTotal, 240);
});

test('parseAttendance: 다른 달 데이터는 제외', () => {
  const y = T_YEAR;
  const m = String(T_MONTH).padStart(2, '0');
  const other = PM_M === m ? `${PM_Y}-${String(Number(PM_M) + 1).padStart(2, '0')}-15` : `${PM_Y}-${PM_M}-15`;
  const data = { detail_list: [
    dayEntry(`${y}-${m}-02`, '05:00:00'),
    dayEntry(other, '09:00:00')
  ] };
  const parsed = parseAttendance(data);
  assert.equal(parsed.monthlyTotal, 300);
});

test('parseAttendance: 퇴실 누락 세션 → 현재 입실 중, 순서 뒤집힘 대응', () => {
  const data = { detail_list: [dayEntry(today, '01:00:00', [
    session('10:00', '11:00'),
    session('14:00', null, true, 'exit')
  ])] };
  // S1: 명시적 nowMs 주입 — 테스트 실행 시각에 무관하게 결정적
  const nowMs = parseEntryTimestamp(today, '23:00');
  const parsed = parseAttendance(data, new Date(), nowMs);
  assert.equal(parsed.isCurrentlyIn, true);
  assert.equal(parsed.lastInTime, 14 * 60);
  assert.equal(parsed.entryTimestamp, parseEntryTimestamp(today, '14:00'));
});

test('parseAttendance: 세션이 뒤집혀 와도 입실 시각순으로 판정', () => {
  // 퇴실누락(늦은 입실)이 먼저 오고 정상 세션이 뒤에 와도 정렬 후 판정
  const data = { detail_list: [dayEntry(today, '01:00:00', [
    session('14:00', null, true, 'exit'),
    session('09:00', '10:00')
  ])] };
  const nowMs = parseEntryTimestamp(today, '23:00'); // S1: 결정적 nowMs
  const parsed = parseAttendance(data, new Date(), nowMs);
  assert.equal(parsed.isCurrentlyIn, true);
  assert.equal(parsed.lastInTime, 14 * 60);
});

test('parseAttendance: 입실 누락(missing_type=entry) 플래그 (R5)', () => {
  const data = { detail_list: [dayEntry(today, '00:30:00', [
    session(null, '18:00', true, 'entry')
  ])] };
  const parsed = parseAttendance(data);
  assert.equal(parsed.hasMissingEntry, true);
  assert.equal(parsed.isCurrentlyIn, false);
});

test('parseAttendance: 정상 완결 세션은 입실 중 아님 + 마지막 입퇴실 기록', () => {
  const data = { detail_list: [dayEntry(today, '08:00:00', [
    session('09:00', '12:00'),
    session('13:00', '17:00')
  ])] };
  const parsed = parseAttendance(data);
  assert.equal(parsed.isCurrentlyIn, false);
  assert.equal(parsed.lastInTime, 13 * 60);
  assert.equal(parsed.lastOutTime, 17 * 60);
});

test('parseAttendance: result/data 키도 허용', () => {
  const y = T_YEAR;
  const m = String(T_MONTH).padStart(2, '0');
  for (const key of ['result', 'data']) {
    const data = { [key]: [dayEntry(`${y}-${m}-02`, '02:00:00')] };
    assert.equal(parseAttendance(data).monthlyTotal, 120);
  }
});

test('parseAttendance: 빈 응답 안전', () => {
  const parsed = parseAttendance(null);
  assert.equal(parsed.monthlyTotal, 0);
  assert.equal(parsed.isCurrentlyIn, false);
  assert.deepEqual(parseAttendance({}).dailyBreakdown, {});
});

// ===== R2: 월 경계 미퇴실 (전월 데이터에서 감지) =====
test('applyOvernightFromPrevMonth: 전월 말일 미퇴실 세션 감지', () => {
  const parsed = parseAttendance({ detail_list: [] }); // 당월 입실 중 아님
  const prevData = { detail_list: [
    dayEntry(`${PM_Y}-${PM_M}-25`, '08:00:00', [session('09:00', '17:00')]),
    dayEntry(`${PM_Y}-${PM_M}-31`, '00:00:00', [session('22:30', null, true, 'exit')])
  ] };
  // 31일이 없는 달 대비: 말일 계산
  const lastDay = new Date(PM_Y, Number(PM_M), 0).getDate();
  prevData.detail_list[1].date = `${PM_Y}-${PM_M}-${String(Math.min(31, lastDay)).padStart(2, '0')}`;

  // S1: 입실 시점 + 90분을 now로 — 전월 말일이 실제 now 기준 stale이라도 결정적으로 fresh
  const freshNow = parseEntryTimestamp(prevData.detail_list[1].date, '22:30') + 90 * 60000;
  const applied = applyOvernightFromPrevMonth(parsed, prevData, freshNow);
  assert.equal(applied, true);
  assert.equal(parsed.isCurrentlyIn, true);
  assert.equal(parsed.lastInTime, 22 * 60 + 30);
  assert.ok(parsed.entryTimestamp > 0);
});

test('applyOvernightFromPrevMonth: 이미 입실 중이면 미적용', () => {
  const parsed = { isCurrentlyIn: true, lastInTime: 600 };
  const prevData = { detail_list: [dayEntry(`${PM_Y}-${PM_M}-28`, '00:00:00', [session('23:00', null, true, 'exit')])] };
  assert.equal(applyOvernightFromPrevMonth(parsed, prevData), false);
  assert.equal(parsed.lastInTime, 600); // 변경 없음
});

test('applyOvernightFromPrevMonth: 전월에 미퇴실 없으면 미적용', () => {
  const parsed = parseAttendance({ detail_list: [] });
  const prevData = { detail_list: [dayEntry(`${PM_Y}-${PM_M}-28`, '08:00:00', [session('09:00', '17:00')])] };
  assert.equal(applyOvernightFromPrevMonth(parsed, prevData), false);
  assert.equal(parsed.isCurrentlyIn, false);
});

// ===== 알람 이름 유틸 (L11/N3 연계 — 구형 호환 포함) =====
test('buildAlarmName/parseAlarmName: 신형 라운드트립', () => {
  const name = buildAlarmName('12345', 'exit', 1080);
  assert.equal(name, `${ALARM_PREFIX}12345_exit_1080`);
  assert.deepEqual(parseAlarmName(name), { memberId: '12345', type: 'exit', endMinutes: 1080 });
});

test('parseAlarmName: goal 타입', () => {
  const name = buildAlarmName('999', 'goal', 600);
  assert.deepEqual(parseAlarmName(name), { memberId: '999', type: 'goal', endMinutes: 600 });
});

test('parseAlarmName: 구형(codyssey_exit_*) 호환 → exit 타입으로 정규화', () => {
  const legacy = legacyAlarmName('12345', 1080);
  assert.equal(legacy, `${LEGACY_ALARM_PREFIX}12345_1080`);
  assert.deepEqual(parseAlarmName(legacy), { memberId: '12345', type: 'exit', endMinutes: 1080 });
});

test('parseAlarmName: 잘못된 입력은 null', () => {
  assert.equal(parseAlarmName(''), null);
  assert.equal(parseAlarmName(null), null);
  assert.equal(parseAlarmName('random_string'), null);
  assert.equal(parseAlarmName('codyssey_alarm__exit_abc'), null); // endMinutes 비숫자
  assert.equal(parseAlarmName('codyssey_exit_123'), null); // 필드 부족
});

test('신형 이름은 구형과 다르게 생성됨 (마이그레이션 대상 판별 가능)', () => {
  const legacy = legacyAlarmName('12345', 1080);
  const modern = buildAlarmName('12345', 'exit', 1080);
  assert.notEqual(legacy, modern);
  // 둘 다 같은 의미로 파싱됨
  assert.deepEqual(parseAlarmName(legacy), parseAlarmName(modern));
});

// ===== K11: formatEndMinutes =====
test('formatEndMinutes: 당일은 HH:MM, 24시간 초과는 N일 후 표기', async () => {
  const { formatEndMinutes } = await import('../web/js/shared-attendance.js');
  assert.equal(formatEndMinutes(1080), '18:00');
  assert.equal(formatEndMinutes(0), '00:00');
  assert.equal(formatEndMinutes(1439), '23:59');
  assert.equal(formatEndMinutes(1440), '1일 후 00:00');
  assert.equal(formatEndMinutes(1560), '1일 후 02:00');
  assert.equal(formatEndMinutes(2885), '2일 후 00:05');
  assert.equal(formatEndMinutes(null), '--:--');
  assert.equal(formatEndMinutes(NaN), '--:--');
});

// ===== K3: isAlarmStale (지연 발화 판정) =====
test('isAlarmStale: 15분 초과 지연만 stale', async () => {
  const { isAlarmStale, ALARM_STALE_WINDOW_MS } = await import('../web/js/shared-attendance.js');
  const now = Date.now();
  assert.equal(isAlarmStale(now - 5 * 60000, now), false);   // 5분 지연 → 정상 발화
  assert.equal(isAlarmStale(now - ALARM_STALE_WINDOW_MS - 1, now), true); // 창구 1ms 초과 → stale
  assert.equal(isAlarmStale(now - 24 * 60 * 60000, now), true); // 하루 지연 → stale
  assert.equal(isAlarmStale(now + 60000, now), false);       // 미래 시각 → 아님
  assert.equal(isAlarmStale(0, now), false);                 // 정보 없음 → 정상 간주
  assert.equal(isAlarmStale(null, now), false);
});

// ===== 문제2: equivalentAlarmNames (이름 재계산 없는 해제용 신/구형 쌍) =====
test('equivalentAlarmNames: 신형 이름 → [신형, 구형] 쌍', async () => {
  const { equivalentAlarmNames } = await import('../web/js/shared-attendance.js');
  assert.deepEqual(
    equivalentAlarmNames('codyssey_alarm_100_exit_1080'),
    ['codyssey_alarm_100_exit_1080', 'codyssey_exit_100_1080']
  );
});

test('equivalentAlarmNames: 구형 이름 → [신형, 구형] 동일 쌍 (순서 무관 의미)', async () => {
  const { equivalentAlarmNames } = await import('../web/js/shared-attendance.js');
  const names = equivalentAlarmNames('codyssey_exit_100_1080');
  assert.ok(names.includes('codyssey_exit_100_1080'));
  assert.ok(names.includes('codyssey_alarm_100_exit_1080'));
  assert.equal(names.length, 2);
});

test('equivalentAlarmNames: goal 타입도 대응 + 파싱 불가도 자기 자신은 반환', async () => {
  const { equivalentAlarmNames } = await import('../web/js/shared-attendance.js');
  const names = equivalentAlarmNames('codyssey_alarm_7_goal_1560');
  assert.ok(names.includes('codyssey_alarm_7_goal_1560'));
  assert.ok(names.includes('codyssey_exit_7_1560')); // 구형은 exit 단일 타입
  assert.deepEqual(equivalentAlarmNames('some_random_alarm'), ['some_random_alarm']);
  assert.deepEqual(equivalentAlarmNames(''), []);
  assert.deepEqual(equivalentAlarmNames(null), []);
});

// ===== G1: 입·퇴실 처리 감지 (detectGateEvents 계열) =====
import {
  normalizeHHMM,
  snapshotSessionsByDate,
  detectGateEvents,
  formatGateEventMessage,
  gateEventKey,
  GATE_EVENT_MAX_AGE_MS,
  GATE_EVENT_MAX_PER_PASS,
  EVAL_ALARM_PREFIX,
  buildEvalAlarmName,
  parseEvalAlarmName,
  validateEvalAlarm
} from '../web/js/shared-attendance.js';

// 고정 기준 시각 (테스트 결정성 확보): 2026-07-17 12:00 로컬
const G_NOW = new Date(2026, 6, 17, 12, 0, 0).getTime();
const G_TODAY = '2026-07-17';
const G_YESTERDAY = '2026-07-16';

test('normalizeHHMM: 초 절삭/한자리 패딩/불량 입력', () => {
  assert.equal(normalizeHHMM('09:12:30'), '09:12');
  assert.equal(normalizeHHMM('9:05'), '09:05');
  assert.equal(normalizeHHMM(null), null);
  assert.equal(normalizeHHMM('bad'), null);
  assert.equal(normalizeHHMM('31:00'), null); // 시 상한 초과
  assert.equal(normalizeHHMM('10:60'), null); // 분 상한 초과
});

test('snapshotSessionsByDate: 지정 날짜만 [entry, exit|null] 쌍으로, 입실 누락 제외, 정렬', () => {
  const raw = { detail_list: [
    { date: G_TODAY, sessions: [
      session('14:00', null, true, 'exit'),      // 입실 중
      session('09:12:45', '12:30:10'),           // 초 포함 → 절삭
      session(null, '20:00', true, 'entry')      // 입실 누락 → 제외
    ] },
    { date: G_YESTERDAY, sessions: [ session('09:00', '18:00') ] },
    { date: '2026-07-01', sessions: [ session('09:00', '10:00') ] } // 미요청 날짜 → 제외
  ] };
  const snap = snapshotSessionsByDate(raw, [G_TODAY, G_YESTERDAY, '2026-07-15']);
  assert.deepEqual(snap[G_TODAY], [['09:12', '12:30'], ['14:00', null]]); // 정렬 + 정규화
  assert.deepEqual(snap[G_YESTERDAY], [['09:00', '18:00']]);
  assert.deepEqual(snap['2026-07-15'], []); // 데이터 없는 요청 날짜는 빈 배열
  assert.equal(snap['2026-07-01'], undefined);
});

test('snapshotSessionsByDate: rawDetailList 배열 직접 전달도 지원', () => {
  const list = [ { date: G_TODAY, sessions: [ session('09:00', null) ] } ];
  const snap = snapshotSessionsByDate(list, [G_TODAY]);
  assert.deepEqual(snap[G_TODAY], [['09:00', null]]);
});

test('detectGateEvents: 최초 스냅샷(null)은 조용히 채택 — 이벤트 없음', () => {
  const next = { [G_TODAY]: [['09:12', null]] };
  assert.deepEqual(detectGateEvents(null, next, G_NOW), []);
  assert.deepEqual(detectGateEvents(undefined, next, G_NOW), []);
});

test('detectGateEvents: 새 입실 세션 → entry 이벤트', () => {
  const prev = { [G_TODAY]: [] };
  const next = { [G_TODAY]: [['09:12', null]] };
  const events = detectGateEvents(prev, next, G_NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'entry');
  assert.equal(events[0].entry, '09:12');
  assert.equal(events[0].dateStr, G_TODAY);
});

test('detectGateEvents: 열린 세션에 퇴실 시각이 채워짐 → exit 이벤트', () => {
  const prev = { [G_TODAY]: [['09:12', null]] };
  const next = { [G_TODAY]: [['09:12', '11:55']] };
  const events = detectGateEvents(prev, next, G_NOW);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'exit');
  assert.equal(events[0].exit, '11:55');
  assert.equal(events[0].entry, '09:12');
});

test('detectGateEvents: 동일 스냅샷 재비교 → 이벤트 없음 (중복 알림 방지)', () => {
  const dates = { [G_TODAY]: [['09:12', '11:55']], [G_YESTERDAY]: [['09:00', '18:00']] };
  assert.deepEqual(detectGateEvents(dates, dates, G_NOW), []);
});

test('detectGateEvents: MAX_AGE보다 오래된 변화는 알림 대상 아님', () => {
  // 어제 06:00 입실 (기준시각 대비 30시간 전) — 최초 동기화가 늦었을 뿐
  const prev = { [G_YESTERDAY]: [] };
  const next = { [G_YESTERDAY]: [['06:00', null]] };
  assert.deepEqual(detectGateEvents(prev, next, G_NOW), []);
});

test(`detectGateEvents: 한 번에 ${GATE_EVENT_MAX_PER_PASS}걸까지만 (폭주 방지)`, () => {
  const prev = { [G_TODAY]: [] };
  const next = { [G_TODAY]: [['07:00', '07:30'], ['08:00', '08:30'], ['09:00', '09:30'], ['10:00', '10:30'], ['11:00', null]] };
  const events = detectGateEvents(prev, next, G_NOW);
  assert.equal(events.length, GATE_EVENT_MAX_PER_PASS);
  // 모든 세션이 "새 entry"이므로 각 세션당 entry 이벤트만 발생 (최신 3건 유지)
  assert.equal(events[events.length - 1].entry, '11:00');
});

test('detectGateEvents: 야간 세션 퇴실(퇴실<입실)은 익일 시각으로 계산', () => {
  const prev = { [G_TODAY]: [['23:30', null]] };
  const next = { [G_TODAY]: [['23:30', '01:20']] };
  // G_NOW(7/17 12:00) 기준 과거로 계산되나 atMs가 당일 01:20+24h(=7/18 01:20)로 미래 →
  // 미래 이벤트도 제외되어야 함 (nowMs - atMs < 0 이면 필터... 실제: 미래는 경과 음수) 
  const events = detectGateEvents(prev, next, new Date(2026, 6, 18, 2, 0, 0).getTime());
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'exit');
  // 익일 시각이입실일 01:20보다 뒤(24h 경과 반영)인지 확인
  const sameDayTs = new Date(2026, 6, 17, 1, 20).getTime();
  assert.ok(events[0].atMs > sameDayTs, '퇴실 시각이 익일로 보정되어야 함');
});

test('formatGateEventMessage/gateEventKey: 문구와 id 규칙', () => {
  const entryMsg = formatGateEventMessage({ type: 'entry', dateStr: G_TODAY, entry: '09:12' }, G_TODAY);
  assert.equal(entryMsg.title, '✅ 코디세이 입실 처리');
  assert.equal(entryMsg.body, '입실 처리됨: 09:12');

  const exitMsg = formatGateEventMessage({ type: 'exit', dateStr: G_YESTERDAY, entry: '09:00', exit: '18:30' }, G_TODAY);
  assert.equal(exitMsg.title, '🏁 코디세이 퇴실 처리');
  assert.ok(exitMsg.body.includes('[7월 16일]'));
  assert.ok(exitMsg.body.includes('퇴실 처리됨: 18:30 (입실 09:00)'));

  assert.equal(
    gateEventKey({ type: 'exit', dateStr: G_YESTERDAY, entry: '09:00', exit: '18:30' }),
    'gate_2026-07-16_exit_18:30'
  );
});

// ===== E1: 평가 알람 이름/검증 =====
test('평가 알람 이름: build/parse 왕복 + 네임스페이스 분리', () => {
  const name = buildEvalAlarmName('eabc123');
  assert.equal(name, `${EVAL_ALARM_PREFIX}eabc123`);
  assert.deepEqual(parseEvalAlarmName(name), { evalId: 'eabc123' });
  // 퇴실/목표 알람 이름 해석기와 충돌하지 않음
  assert.equal(parseAlarmName(name), null);
  assert.equal(parseEvalAlarmName('codyssey_alarm_100_exit_1080'), null);
  assert.equal(parseEvalAlarmName('codyssey_eval_'), null); // id 없음
  assert.equal(parseEvalAlarmName(null), null);
});

test('validateEvalAlarm: 미래/과거/입력 오류 판정', () => {
  const when = G_NOW + 60 * 60000; // 1시간 후
  assert.equal(validateEvalAlarm(when, 30, G_NOW), null);      // 정상 (30분 전)
  assert.equal(validateEvalAlarm(when, 0, G_NOW), null);       // 0분 전(정각) 허용
  assert.equal(validateEvalAlarm(G_NOW - 60000, 30, G_NOW), 'past');     // 평가가 과거
  assert.equal(validateEvalAlarm(when, 120, G_NOW), 'past');   // 사전 알림 시각이 과거
  assert.equal(validateEvalAlarm(when, -5, G_NOW), 'invalid'); // 음수 분
  assert.equal(validateEvalAlarm(when, 2000, G_NOW), 'invalid'); // 24시간 초과
  assert.equal(validateEvalAlarm(NaN, 30, G_NOW), 'invalid');
  assert.equal(validateEvalAlarm(0, 30, G_NOW), 'invalid');
});

// ===== E2: 평가 일정 자동 연동 파서 (scheduleAllList 해석) =====
import {
  findInstCd,
  extractEvalDateTimeMs,
  parseScheduleRows,
  diffEvalItems,
  isEvalConfirmed,
  mergeDetailLists,
  EVAL_AUTO_ID_PREFIX
} from '../web/js/shared-attendance.js';

test('findInstCd: 중첩 어디든 instCd/instCode 탐색', () => {
  assert.equal(findInstCd({ result: { mbrId: '1', instCd: 'INST001' } }), 'INST001');
  assert.equal(findInstCd({ result: { inst: { instCode: 'ABC' } } }), 'ABC');
  assert.equal(findInstCd({ result: { list: [ { x: 1 }, { instCd: 'IN_9' } ] } }), 'IN_9');
  assert.equal(findInstCd({ result: { mbrId: '1' } }), null);
  assert.equal(findInstCd(null), null);
  assert.equal(findInstCd('INST001'), null); // 객체 아님
});

test('extractEvalDateTimeMs: 전체 일시 필드', () => {
  const ms = extractEvalDateTimeMs({ scdlBgngDt: '2026.07.20 14:00' });
  assert.equal(ms, new Date(2026, 6, 20, 14, 0).getTime());
  const ms2 = extractEvalDateTimeMs({ evlBgngDt: '2026-07-20 09:30:00' });
  assert.equal(ms2, new Date(2026, 6, 20, 9, 30).getTime());
});

test('extractEvalDateTimeMs: 날짜+시각 분리 필드 (YYYYMMDD + HHmm 포함)', () => {
  const ms = extractEvalDateTimeMs({ scdlDe: '2026.07.20', scdlTime: '14:00' });
  assert.equal(ms, new Date(2026, 6, 20, 14, 0).getTime());
  const ms2 = extractEvalDateTimeMs({ scdlYmd: '20260720', scdlHm: '1430' });
  assert.equal(ms2, new Date(2026, 6, 20, 14, 30).getTime());
});

test('extractEvalDateTimeMs: 스캔 폴곤 + 파싱 불가 시 null', () => {
  const ms = extractEvalDateTimeMs({ weirdField: '평가일 2026-07-20 14:00 시작' });
  assert.equal(ms, new Date(2026, 6, 20, 14, 0).getTime());
  assert.equal(extractEvalDateTimeMs({ scdlDe: '없음', scdlTime: '없음' }), null);
  assert.equal(extractEvalDateTimeMs({}), null);
  assert.equal(extractEvalDateTimeMs(null), null);
});

test('parseScheduleRows: R/A 구분, 취소 코드 제외, 고유키/제목 폴곤, 정렬', () => {
  const rows = [
    { evlNo: '101', evlDegr: '1', reqDetail: 'R||', scdlReqUsr: '김피평', lcorsNm: '알고리즘', scdlDe: '2026.07.22', scdlTime: '10:00', fixedCd: '00002' },
    { evlNo: '102', evlDegr: '1', reqDetail: 'A||', scdlReqUsr: '이수강', scdlDe: '2026.07.20', scdlTime: '14:00' },
    { evlNo: '103', reqDetail: 'R||', scdlReqUsr: '김피평', scdlDe: '2026.07.21', scdlTime: '09:00', fixedCd: '00005' }, // 요청취소 → 제외
    { evlNo: '104', reqDetail: 'R||', scdlReqUsr: '김피평', scdlDe: '2026.07.23', scdlTime: '09:00', fixedCd: '00006' }, // 완료 → 제외
    { evlNo: '105', reqDetail: 'R||', scdlReqUsr: '김피평', scdlDe: '몰라', scdlTime: '몰라' } // 파싱 불가 → 스킵 집계
  ];
  const { items, skipped, sampleKeys } = parseScheduleRows(rows);
  assert.equal(items.length, 2);
  assert.equal(skipped, 1);
  assert.ok(Array.isArray(sampleKeys) && sampleKeys.includes('evlNo'));
  // 시각순 정렬: 7/20 14:00 (A) 먼저
  assert.equal(items[0].role, 'A');
  assert.ok(items[0].title.includes('평가자: 이수강'));
  assert.equal(items[1].role, 'R');
  assert.ok(items[1].title.includes('피평가자: 김피평'));
  assert.ok(items[1].title.includes('알고리즘'));
  assert.equal(items[1].key, '101_1'); // evlNo_evlDegr
});

test('parseScheduleRows: id 없으면 날짜+행 정보로 폴곤 키 생성 + 중복 제거', () => {
  const whenMs = new Date(2026, 6, 20, 14, 0).getTime();
  const rows = [
    { reqDetail: 'R||', scdlReqUsr: '김', scdlDe: '2026.07.20', scdlTime: '14:00' },
    { reqDetail: 'R||', scdlReqUsr: '김', scdlDe: '2026.07.20', scdlTime: '14:00' } // 완전 동일 → 1건
  ];
  const { items } = parseScheduleRows(rows);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, `${whenMs}_R___김`.replace(/[^A-Za-z0-9_.-]/g, '_'));
  // 자동 알람 이름 규칙
  assert.ok(buildEvalAlarmName(EVAL_AUTO_ID_PREFIX + items[0].key).startsWith(EVAL_ALARM_PREFIX));
});

// ===== 12차: usr 프론트엔드 번들 실측 스키마 (S1) =====
// 호출: POST https://api.usr.codyssey.kr/schedule/scheduleAllList/?…&scheduleType=request (본문 없음)
// 행 식별: scdlGubunCd==='EV', 시각: bgngYmd+bgngTm, 제목: title||scdlGubunNm,
// 역할: reqDetail 첫 토큰(R=피평가자/A=평가자), 고유키: mtlEvlSn 우선

test('parseScheduleRows: 실측 스키마(EV 행) — bgngYmd+bgngTm, mtlEvlSn, title, reqDetail 토큰', () => {
  const rows = [
    { scdlGubunCd: 'EV', fixedCd: '00002', bgngYmd: '2026.07.20', bgngTm: '14:00',
      title: '알고리즘 과제 평가', scdlReqUsr: '김코디', reqDetail: 'R||35||P||7||3', mtlEvlSn: '35' },
    { scdlGubunCd: 'EV', fixedCd: '00001', bgngYmd: '2026.07.21', bgngTm: '10:30',
      scdlGubunNm: '동료평가', scdlReqUsr: '박수련', reqDetail: 'A||42||P||7||3||1' } // mtlEvlSn 키 없음 → reqDetail 토큰 폴곤
  ];
  const { items, skipped, nonEv, sampleKeys } = parseScheduleRows(rows);
  assert.equal(items.length, 2);
  assert.equal(skipped, 0);
  assert.equal(nonEv, 0);
  // 첫 행: 시작 시각 정확, 고유키 mtlEvlSn, 제목 title 우선 + 피평가자 라벨
  assert.equal(items[0].whenMs, new Date(2026, 6, 20, 14, 0).getTime());
  assert.equal(items[0].key, '35');
  assert.ok(items[0].title.includes('알고리즘 과제 평가'));
  assert.ok(items[0].title.includes('피평가자: 김코디'));
  assert.equal(items[0].role, 'R');
  // 둘째 행: reqDetail 두 번째 토큰으로 키 폴곤, scdlGubunNm 제목 폴곤, 평가자 라벨
  assert.equal(items[1].key, '42');
  assert.ok(items[1].title.includes('동료평가'));
  assert.ok(items[1].title.includes('평가자: 박수련'));
  assert.equal(items[1].role, 'A');
  // 진단: sampleKeys는 EV 행의 키 목록
  assert.ok(Array.isArray(sampleKeys) && sampleKeys.includes('scdlGubunCd'));
});

test('parseScheduleRows: EV가 아닌 행(AM/EXAM/MT)은 nonEv로만 집계, 취소 상태 EV는 제외', () => {
  const rows = [
    { scdlGubunCd: 'AM', bgngYmd: '2026.07.20', bgngTm: '09:00', title: '오전 점호' },
    { scdlGubunCd: 'EXAM', bgngYmd: '2026.07.21', bgngTm: '15:00', title: '1차 시험' },
    { scdlGubunCd: 'EV', fixedCd: '00004', bgngYmd: '2026.07.22', bgngTm: '14:00', title: '거절된 평가' }, // 거절 → 제외
    { scdlGubunCd: 'EV', fixedCd: '00006', bgngYmd: '2026.07.23', bgngTm: '14:00', title: '완료된 평가' }, // 완료 → 제외
    { scdlGubunCd: 'EV', fixedCd: '00003', bgngYmd: '2026.07.24', bgngTm: '14:00', title: '진행중 평가', mtlEvlSn: '77' }
  ];
  const { items, nonEv, skipped } = parseScheduleRows(rows);
  assert.equal(nonEv, 2);      // AM + EXAM
  assert.equal(skipped, 0);
  assert.equal(items.length, 1); // 진행중(00003)만 알람 대상
  assert.equal(items[0].key, '77');
  assert.equal(items[0].title, '진행중 평가 (평가)'); // reqDetail 없음 → 역할 라벨 기본 '평가'
});

test('parseScheduleRows: 2자리 연도(YY/MM/DD) 폴곤 + scdlBgngDt(일시형) 폴곤', () => {
  const rows = [
    { scdlGubunCd: 'EV', mtlEvlSn: '88', bgngYmd: '26/07/25', bgngTm: '16:00', title: '레거시 표기 평가' },
    { scdlGubunCd: 'EV', mtlEvlSn: '89', scdlBgngDt: '2026-07-26 11:30', title: '일시형 필드 평가' }
  ];
  const { items } = parseScheduleRows(rows);
  assert.equal(items.length, 2);
  assert.equal(items[0].whenMs, new Date(2026, 6, 25, 16, 0).getTime());
  assert.equal(items[1].whenMs, new Date(2026, 6, 26, 11, 30).getTime());
});

// ===== 13차: C2 — fixedCd 상태를 항목에 보존 → 협의중(00001)은 조용히 등록, 확정 전환 감지 =====
test('parseScheduleRows: 항목에 state(fixedCd) 보존 + isEvalConfirmed 규칙', () => {
  const rows = [
    { scdlGubunCd: 'EV', mtlEvlSn: '91', fixedCd: '00001', bgngYmd: '2026.07.20', bgngTm: '14:00', title: '협의중 평가' },
    { scdlGubunCd: 'EV', mtlEvlSn: '92', fixedCd: '00002', bgngYmd: '2026.07.21', bgngTm: '14:00', title: '확정 평가' },
    { scdlGubunCd: 'EV', mtlEvlSn: '93', bgngYmd: '2026.07.22', bgngTm: '14:00', title: '상태 미상 평가' } // fixedCd 없음
  ];
  const { items } = parseScheduleRows(rows);
  assert.equal(items.length, 3);
  assert.equal(items[0].state, '00001');
  assert.equal(items[1].state, '00002');
  assert.equal(items[2].state, '');
  assert.equal(isEvalConfirmed(items[0].state), false); // 협의중 → 조용히
  assert.equal(isEvalConfirmed(items[1].state), true);  // 확정 → 알림
  assert.equal(isEvalConfirmed(items[2].state), true);  // 미상 → 알림
});

// W2: 원샷 알림 키에 박힌 시각으로 id를 결정적으로 계산하는 규칙 (배경: clear 시 다른 id)
// — notificationIdFor는 adapter 남부 함수라 규칙만 로컬 모사해 검증
test('원샷 알림 id 규칙: 키의 시각 재사용 + 카운터 네임스페이스와 분리(W2/W3)', () => {
  const oneshotId = (idKey) => {
    const embedded = Number(idKey.split('_')[1]) || Date.now();
    return (1000000000 + (embedded % 1000000000)) | 0;
  };
  const key = 'notif_1721234567890';
  assert.equal(oneshotId(key), oneshotId(key)); // create/clear 동일 id (W2)
  assert.ok(oneshotId(key) >= 1000000000);       // 1e9 대역 (W3)
  assert.ok(oneshotId(key) < 2000000000);
  const counterId = 1001; // NOTIF_ID_BASE+1
  assert.ok(oneshotId(key) !== counterId);
});

test('diffEvalItems: added/removed/changed(시각·lead·제목) 판정', () => {
  const prev = [
    { key: 'a', whenMs: 100, title: 't1', leadMinutes: 30, name: 'codyssey_eval_auto_a' },
    { key: 'b', whenMs: 200, title: 't2', leadMinutes: 30, name: 'codyssey_eval_auto_b' },
    { key: 'c', whenMs: 300, title: 't3', leadMinutes: 30, name: 'codyssey_eval_auto_c' }
  ];
  const next = [
    { key: 'a', whenMs: 100, title: 't1' },      // 동일
    { key: 'b', whenMs: 250, title: 't2' },      // 시각 변경
    { key: 'd', whenMs: 400, title: 't4' }       // 신규
  ];
  const diff = diffEvalItems(prev, next, 30);
  assert.deepEqual(diff.added.map(i => i.key), ['d']);
  assert.deepEqual(diff.removed.map(i => i.key), ['c']);
  assert.deepEqual(diff.changed.map(i => i.key), ['b']);
  assert.equal(diff.changed[0].name, 'codyssey_eval_auto_b'); // 기존 알람 이름 승계

  // lead 변경만으로도 changed
  const diff2 = diffEvalItems([{ key: 'a', whenMs: 100, title: 't1', leadMinutes: 30, name: 'n' }],
    [{ key: 'a', whenMs: 100, title: 't1' }], 60);
  assert.equal(diff2.changed.length, 1);
  assert.deepEqual(diffEvalItems(prev, next, 30).added.length, 1);
});
// ===== S1(14차): 13시간 이상 경과한 미퇴실 세션은 낡은 기록 — 입실 중/실시간 누적에서 제외 =====
test('isOpenSessionFresh: 13시간 경계 + 미래 시각', () => {
  const base = new Date(2026, 6, 18, 22, 0, 0).getTime();
  assert.equal(isOpenSessionFresh(base - 13 * 3600 * 1000, base), true);  // 정확히 13h → 인정
  assert.equal(isOpenSessionFresh(base - (13 * 3600 * 1000 + 1), base), false); // 초과 → 낡음
  assert.equal(isOpenSessionFresh(base + 60000, base), false); // 미래 시각 방어
  assert.equal(isOpenSessionFresh(null, base), false);
  assert.equal(MAX_OPEN_SESSION_MS, 13 * 60 * 60 * 1000);
});

test('parseAttendance(S1): 어제 10:03 미퇴실 세션은 입실 중 아님 — 12시간 캡 표시 방지', () => {
  // 사용자 제보 재현: 입실 중이 아닌데 12시간 채움 + '입실 10:03' 표시
  const data = { detail_list: [
    dayEntry('2026-07-17', '08:00:00', [session('10:03', null, true, 'exit')]) // 퇴실 누락
  ] };
  const target = new Date(2026, 6, 18); // 7월 파싱 대상
  const nowMs = new Date(2026, 6, 18, 22, 3, 0).getTime(); // 36시간 경과 시점
  const parsed = parseAttendance(data, target, nowMs);
  assert.equal(parsed.isCurrentlyIn, false);         // 입실 중이면 안 됨
  assert.equal(parsed.entryTimestamp, null);
  assert.equal(parsed.staleOpenSession.dateStr, '2026-07-17'); // 진단 정보는 남김
  assert.equal(parsed.staleOpenSession.entry, '10:03');
  // 실시간 누적 0 — 서버 확정분(dailyTotal) 외에 살아있는 누적이 없어야 함 (12시간 캡 표시 방지)
  assert.equal(elapsedSinceEntry(parsed, nowMs), 0);
  assert.equal(recognizedToday(parsed, nowMs), parsed.dailyTotal); // TZ 무관 불변식
  assert.equal(recognizedMonthly(parsed, nowMs), parsed.monthlyTotal); // 월도 서버 확정분 그대로
});

test('parseAttendance(S1): 8시간 전 미퇴실 세션은 여전히 입실 중 (정상 진행)', () => {
  const data = { detail_list: [
    dayEntry(today, '02:00:00', [session('09:00', null, true, 'exit')])
  ] };
  const nowMs = parseEntryTimestamp(today, '17:00'); // 입실 후 8시간
  const parsed = parseAttendance(data, new Date(), nowMs);
  assert.equal(parsed.isCurrentlyIn, true);
  assert.equal(parsed.staleOpenSession, null);
  assert.equal(elapsedSinceEntry(parsed, nowMs), 8 * 60);
});

test('parseAttendance(S1): 낡은 세션과 새 개방 세션이 섞여도 새 세션만 입실 중', () => {
  const data = { detail_list: [
    dayEntry('2026-07-17', '08:00:00', [session('10:03', null, true, 'exit')]), // 낡음
    dayEntry('2026-07-18', '02:00:00', [session('14:00', null, true, 'exit')])  // 새 세션
  ] };
  const nowMs = new Date(2026, 6, 18, 22, 3, 0).getTime();
  const parsed = parseAttendance(data, new Date(2026, 6, 18), nowMs);
  assert.equal(parsed.isCurrentlyIn, true);
  assert.equal(parsed.lastInTime, 14 * 60);
  assert.ok(parsed.staleOpenSession); // 낡은 세션은 진단에 기록
});

test('applyOvernightFromPrevMonth(S1): 전월 미퇴실이 13시간 이상 경과하면 미적용', () => {
  const parsed = parseAttendance({ detail_list: [] });
  const prevData = { detail_list: [
    dayEntry(`${PM_Y}-${PM_M}-28`, '00:00:00', [session('10:03', null, true, 'exit')])
  ] };
  const staleNow = parseEntryTimestamp(`${PM_Y}-${PM_M}-28`, '10:03') + 40 * 3600 * 1000; // 40시간 후
  assert.equal(applyOvernightFromPrevMonth(parsed, prevData, staleNow), false);
  assert.equal(parsed.isCurrentlyIn, false);
  assert.equal(parsed.staleOpenSession.entry, '10:03'); // 낡은 세션 진단 기록
});

test('elapsedSinceEntry(S1): stale entryTimestamp는 이중 방어로 0 + 13h 상한 캡', () => {
  const now = Date.now();
  const stale = { isCurrentlyIn: true, entryTimestamp: now - 20 * 3600 * 1000, lastInTime: null };
  assert.equal(elapsedSinceEntry(stale, now), 0); // freshness 게이트
  // parsed에 freshness 없이 직접 주입된 경우의 상한 확인용 — 12.9h는 그대로
  const near = { isCurrentlyIn: true, entryTimestamp: now - 774 * 60000, lastInTime: null };
  assert.equal(elapsedSinceEntry(near, now), 774);
});

// ===== S4(14차): findInstCd 숫자형 수용 =====
test('findInstCd(S4): 숫자형 instCd도 문자열로 반환', () => {
  assert.equal(findInstCd({ result: { instCd: 21 } }), '21');
  assert.equal(findInstCd({ result: { instCd: '00021' } }), '00021'); // 문자열 우선 (앞자리 0 보존)
  assert.equal(findInstCd({ result: { instCd: 0 } }), '0'); // 숫자는 그대로 문자열화
});
// ===== E3(15차): 알림함(alarmList) 평가 감지 — 사용자 제공 실측 샘플 기반 =====
function noticeRow(over) {
  return Object.assign({
    regDt: '2026-07-14 11:45', pstartSn: 686132,
    pstartTitlNm: '동료평가자로 지정 되었습니다.',
    pstartCn: '안녕하세요.&lt;br/&gt;동료평가 일정이 지정되어 아래와 같이 안내 드립니다.&lt;br/&gt;&lt;평가일정&gt;&lt;br/&gt;요청자 : 김우종(woojuro3@naver.com)&lt;br/&gt;Discord ID : wilderif&lt;br/&gt;평가예정일시 : 2026-07-14 15:00:00&lt;br/&gt;프로젝트명 : AI/SW 기초 (AI/SW Basic)&lt;br/&gt;학습과정명 : 클라우드와 AI API (Cloud &amp; AI API)&lt;br/&gt;단위문제명 : AI 기반 Git 커밋 &amp; PR 자동 생성기 개발',
    ntcDivCd: '00101', sysDivCd: '00017', readYn: 'N'
  }, over);
}

test('unescapeAlarmHtml: 엔티티/br 디코드', () => {
  const t = unescapeAlarmHtml('a&lt;br/&gt;b &amp; c&lt;br&gt;d');
  assert.equal(t, 'a\nb & c\nd');
});

test('parseEvalNoticeAlarms: 00017 동료평가자 지정 → 시각/역할/요청자 추출', () => {
  const items = parseEvalNoticeAlarms([noticeRow({})], new Date(2026, 6, 14, 12, 0).getTime());
  assert.equal(items.length, 1);
  const it = items[0];
  assert.equal(it.key, 'notice_686132');
  assert.equal(it.role, 'A'); // 동료평가자
  assert.equal(it.requester, '김우종'); // (이메일) 분리
  assert.equal(it.project, 'AI/SW 기초 (AI/SW Basic)');
  assert.equal(it.discordId, 'wilderif');
  assert.equal(it.whenMs, new Date(2026, 6, 14, 15, 0, 0).getTime());
  assert.equal(it.past, false); // 12:00 기준 미래
  assert.equal(it.title, 'AI/SW 기초 (AI/SW Basic) (평가자 · 요청자: 김우종)');
});

test('parseEvalNoticeAlarms: 종료(00020)·포인트(00057) 계열은 제외', () => {
  const rows = [
    noticeRow({ pstartSn: 1, pstartTitlNm: 'AI/SW 기초 과정이 평가종료 되었습니다.', sysDivCd: '00020',
      pstartCn: '...평가종료일시 :2026-07-14 13:45...' }), // 평가"종료"일시 — 본문 신호 없음
    noticeRow({ pstartSn: 2, pstartTitlNm: '포인트 획득 알림', sysDivCd: '00057',
      pstartCn: '100 포인트를 획득하셨습니다!' }),
    noticeRow({ pstartSn: 3, pstartTitlNm: '레벨업 알림', sysDivCd: '00055', pstartCn: '3 레벨이 되었습니다.' })
  ];
  const items = parseEvalNoticeAlarms(rows);
  assert.equal(items.length, 0);
});

test('parseEvalNoticeAlarms: 과거 알림은 past 표시, sn 없는 행/형식 불량은 스킵', () => {
  const rows = [
    noticeRow({}), // 15:00 — 기준시각보다 과거
    noticeRow({ pstartSn: null }),
    noticeRow({ pstartSn: 9, pstartCn: '평가예정일시 : 형식이상' })
  ];
  const items = parseEvalNoticeAlarms(rows, new Date(2026, 6, 14, 18, 0).getTime());
  assert.equal(items.length, 1);
  assert.equal(items[0].past, true);
});

test('filterNewEvalNotices: seen 캐시에 없는 것만 반환', () => {
  const items = parseEvalNoticeAlarms([
    noticeRow({ pstartSn: 100 }), noticeRow({ pstartSn: 101 })
  ], new Date(2026, 6, 14, 10, 0).getTime());
  const fresh = filterNewEvalNotices({ '100': { whenMs: 1 } }, items);
  assert.deepEqual(fresh.map(i => i.pstartSn), ['101']);
});


// ===== L2(16차): 로그인 서버 오류 해석 =====

test('describeLoginServerError: E0001 잠금 매핑', () => {
  const r1 = describeLoginServerError(401, { message_code: 'E0001', success: false, message: 'locked' });
  assert.ok(/10분간 로그인이 제한/.test(r1));
  const r2 = describeLoginServerError(401, { message: '5회 이상 입력정보가 틀려 10분간 로그인이 제한됩니다.' });
  assert.ok(/10분간 로그인이 제한/.test(r2));
});

test('describeLoginServerError: "등록되지 않은 회원입니다" → 비밀번호 안내로 해석', () => {
  // 실측(부록 3): 등록된 이메일 + 비번 불일치 시 서버가 복내는 문구
  const r = describeLoginServerError(401, { message_code: 'E0000', success: false, message: '등록되지 않은 회원입니다.' });
  assert.ok(/비밀번호가 일치하지 않거나/.test(r), r);
  assert.ok(/비밀번호 찾기/.test(r), r);
  assert.ok(/소셜 계정/.test(r), r);
  assert.ok(/서버 응답: 등록되지 않은 회원입니다\./.test(r), '원문 보존');
});

test('describeLoginServerError: 그 외 문구는 null (호출부가 원문 사용)', () => {
  assert.equal(describeLoginServerError(401, { message_code: 'E0000', success: false, message: '입력하신 아이디 혹은 비밀번호가 일치하지 않습니다.' }), null);
  assert.equal(describeLoginServerError(500, null), null);
  assert.equal(describeLoginServerError(0, {}), null);
});

test('shouldRetryTrimmedPassword: 공백 포함 + 인증 오류일 때만 재시도', () => {
  assert.equal(shouldRetryTrimmedPassword('pass ', '등록되지 않은 회원입니다.'), true);
  assert.equal(shouldRetryTrimmedPassword(' pass', '입력하신 아이디 혹은 비밀번호가 일치하지 않습니다.'), true);
  assert.equal(shouldRetryTrimmedPassword('pass', '등록되지 않은 회원입니다.'), false);
  assert.equal(shouldRetryTrimmedPassword('pass ', '네트워크 오류'), false);
  assert.equal(shouldRetryTrimmedPassword(null, '등록되지 않은 회원입니다.'), false);
});
