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
  getTodayString,
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
  const parsed = parseAttendance(data);
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
  const parsed = parseAttendance(data);
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

  const applied = applyOvernightFromPrevMonth(parsed, prevData);
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
