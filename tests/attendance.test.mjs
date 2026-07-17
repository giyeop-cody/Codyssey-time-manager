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
