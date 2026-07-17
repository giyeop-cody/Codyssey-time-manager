// ============================================================
// 코디세이 출입기록 익스텐션 - Background Service Worker
// API: https://api.usr.codyssey.kr/rest/user/info/detail (mbrId 조회)
// API: https://api.usr.codyssey.kr/rest/secom/detail?mbrId={mbrId}&year={year}&month={month} (출입기록)
// ============================================================

// 공통 출입 로직 (단일 소스 — capacitor-adapter.js와 공유)
import {
  parseAttendance,
  applyOvernightFromPrevMonth,
  buildAlarmName,
  legacyAlarmName,
  parseAlarmName,
  equivalentAlarmNames,
  formatEndMinutes,
  isAlarmStale,
  getTodayString,
  snapshotSessionsByDate,
  detectGateEvents,
  formatGateEventMessage,
  gateEventKey,
  newEvalId,
  buildEvalAlarmName,
  parseEvalAlarmName,
  validateEvalAlarm,
  findInstCd,
  parseScheduleRows,
  diffEvalItems,
  isEvalConfirmed,
  mergeDetailLists,
  EVAL_AUTO_ID_PREFIX,
  parseEvalNoticeAlarms,
  filterNewEvalNotices,
  EVAL_NOTICE_PAGE_PER_ROWS,
  EVAL_NOTICE_DEDUP_MS,
  EVAL_NOTICE_SEEN_TTL_MS
} from './shared-attendance.js';

const CONFIG = {
  API_BASE: 'https://api.usr.codyssey.kr',
  MONTHLY_REQUIRED_HOURS: 80,
  DAILY_MAX_HOURS: 12,
  STORAGE_KEYS: {
    MEMBER_ID: 'codyssey_member_id',
    SETTINGS: 'codyssey_settings',
    CACHE: 'codyssey_cache_',
    ALARMS: 'codyssey_alarms_'
  }
};

// 기본 설정
const DEFAULT_SETTINGS = {
  monthlyRequiredHours: 80,
  dailyMaxHours: 12,
  notificationsEnabled: true,
  soundEnabled: true,
  autoRefresh: true,
  refreshInterval: 30, // 분
  keepAliveEnabled: false, // 세션 무한 연장 방지 — 사용자가 명시적으로 켜는 opt-in
  gateNotifyEnabled: true, // G1: 입·퇴실 처리 감지 알림 (요청 기능 — 기본 켬)
  evalLeadMinutes: 30, // E1: 평가 알람 기본 사전 알림 (분)
  evalAutoSyncEnabled: true, // E2: 코디세이 평가 일정 자동 연동 (E1 요청 사항)
  evalInstCd: '' // E2: instCd 자동 추출 실패 시 사용자 수동 입력
};

// ===== 스토리지 =====
async function getStorage(keys) {
  return new Promise(resolve => {
    chrome.storage.local.get(keys, resolve);
  });
}

async function setStorage(data) {
  return new Promise(resolve => {
    chrome.storage.local.set(data, resolve);
  });
}

async function getSettings() {
  const data = await getStorage([CONFIG.STORAGE_KEYS.SETTINGS]);
  return { ...DEFAULT_SETTINGS, ...(data[CONFIG.STORAGE_KEYS.SETTINGS] || {}) };
}

async function saveSettings(settings) {
  await setStorage({ [CONFIG.STORAGE_KEYS.SETTINGS]: settings });
}

async function getMemberId() {
  const data = await getStorage([CONFIG.STORAGE_KEYS.MEMBER_ID]);
  return data[CONFIG.STORAGE_KEYS.MEMBER_ID] || null;
}

async function saveMemberId(memberId) {
  await setStorage({ [CONFIG.STORAGE_KEYS.MEMBER_ID]: memberId });
}

async function getCache(key) {
  const data = await getStorage([CONFIG.STORAGE_KEYS.CACHE + key]);
  const cached = data[CONFIG.STORAGE_KEYS.CACHE + key];
  if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) { // 5분 캐시
    return cached.data;
  }
  return null;
}

async function setCache(key, data) {
  await setStorage({ [CONFIG.STORAGE_KEYS.CACHE + key]: { data, timestamp: Date.now() } });
}

// 인증 오류/로그아웃 등 세션 상태 변화 시 출석 캐시 전체 삭제 (R7)
async function clearAttendanceCaches() {
  const all = await getStorage(null);
  const keysToRemove = Object.keys(all).filter(k => k.startsWith(CONFIG.STORAGE_KEYS.CACHE));
  if (keysToRemove.length) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

// ===== API 호출 (세션 쿠키 포함) =====
// ※ 본문 없는 POST에는 options.skipContentType 사용 — Content-Type: application/json을 달면
//   실측 동작(axios post(url, null))과 달라지고 CORS simple-request 범위도 벗어남 (S4 방어)
async function fetchWithAuth(url, options = {}) {
  const { skipContentType, ...rest } = options;
  const baseOptions = {
    credentials: 'include', // 중요: 세션 쿠키(JSESSIONID) 자동 포함
    redirect: 'manual', // 302를 직접 감지하기 위해 자동 팔로우 방지
    headers: {
      'Accept': 'application/json',
      ...(skipContentType ? {} : { 'Content-Type': 'application/json' }),
      ...(rest.headers || {})
    }
  };
  let res = await fetch(url, { ...baseOptions, ...rest, headers: baseOptions.headers });

  // 정상 리다이렉트(codyssey 도메인 남부)는 1회 수동 추적 (N10)
  // ※ cross-origin 리다이렉트는 opaqueredirect라 Location을 읽을 수 없음 — 그 경우 인증 오류로 분류
  if (res.status >= 300 && res.status < 400 && res.type !== 'opaqueredirect') {
    const location = res.headers.get('location') || '';
    if (location.includes('codyssey.kr') && !/login/i.test(location)) {
      res = await fetch(location, baseOptions);
    } else {
      throw new Error('AUTH_REQUIRED');
    }
  }

  // 세션 만료 감지: 리다이렉트, 401, 로그인 페이지로의 이동
  if (res.type === 'opaqueredirect' || res.status === 302 || res.status === 301 || res.status === 401 || res.status === 403) {
    throw new Error('AUTH_REQUIRED');
  }
  if (res.url && /login/i.test(res.url)) {
    throw new Error('AUTH_REQUIRED');
  }
  return res;
}

// JSON 응답 검증 후 파싱 (로그인 페이지 HTML이 반환되는 경우 인증 오류로 분류)
async function readJsonResponse(res, apiName) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text().catch(() => '');
    if (/login|로그인/i.test(text)) throw new Error('AUTH_REQUIRED');
    throw new Error(`${apiName}_PARSE_ERROR`);
  }
  try {
    return await res.json();
  } catch (e) {
    throw new Error(`${apiName}_PARSE_ERROR`);
  }
}

// --- 1. 멤버 정보 조회 (mbrId 획득) ---
async function fetchMemberInfo() {
  const url = `${CONFIG.API_BASE}/rest/user/info/detail`;
  const res = await fetchWithAuth(url);

  if (!res.ok) {
    throw new Error(`MEMBER_INFO_API_ERROR_${res.status}`);
  }

  return await readJsonResponse(res, 'MEMBER_INFO');
}

// mbrId 추출 (응답 구조에 따라 조정 필요)
function extractMemberId(memberInfoData) {
  // 실제 응답 구조: { code: 200, result: { mbrId: "1000271067", ... } }
  if (!memberInfoData) return null;
  
  const result = memberInfoData.result || memberInfoData.data || memberInfoData;
  
  // 다양한 필드명 시도 (mbrId가 최우선)
  return result.mbrId 
      || result.memberId 
      || result.userId 
      || result.id 
      || result.no 
      || null;
}

// --- 2. 출입기록 조회 (J1: force면 5분 캐시 바이패스) ---
async function fetchAttendance(memberId, year, month, force = false) {
  const cacheKey = `attendance_${memberId}_${year}_${month}`;
  if (!force) {
    const cached = await getCache(cacheKey);
    if (cached) return cached;
  }

  // 사용자 지정 정확한 엔드포인트
  const url = `${CONFIG.API_BASE}/rest/secom/detail?mbrId=${memberId}&year=${year}&month=${String(month).padStart(2,'0')}`;
  let res;
  try {
    res = await fetchWithAuth(url);
  } catch (e) {
    // 세션 만료인데 캐시만 잔존하는 상태 방지 — 캐시 무효화 후 오류 전파 (R7)
    // Q1: memberId도 함께 폐기 — 다음 로그인(또는 다른 계정)에서 스테일 id 재사용 방지
    if (e.message === 'AUTH_REQUIRED') {
      await clearAttendanceCaches();
      await setStorage({ [CONFIG.STORAGE_KEYS.MEMBER_ID]: null });
    }
    throw e;
  }

  if (!res.ok) {
    throw new Error(`ATTENDANCE_API_ERROR_${res.status}`);
  }

  const data = await readJsonResponse(res, 'ATTENDANCE');
  await setCache(cacheKey, data);
  return data;
}

// Q1: 세션 전환(로그인 직후) 시 저장 memberId + 캐시 초기화
// — 계정 전환 시 이전 계정 데이터가 표시되던 문제 방지
async function clearSessionIdentity() {
  await setStorage({ [CONFIG.STORAGE_KEYS.MEMBER_ID]: null });
  await clearAttendanceCaches();
  await clearGateSnapshots(); // G1: 계정 바뀌면 이전 계정 스냅샷도 폐기
  // E2: 평가 동기화 상태/instCd 캐시도 계정과 함께 폐기 (등록된 자동 알람은 목록과 함께 정리됨)
  try {
    await chrome.storage.local.remove(['eval_sync_state', 'eval_inst_cd']);
  } catch (e) { /* 무시 */ }
}

// ===== G1: 입·퇴실 처리 감지 =====
const GATE_SNAP_PREFIX = 'codyssey_gate_snap_';

async function clearGateSnapshots() {
  const all = await getStorage(null);
  const keys = Object.keys(all).filter(k => k.startsWith(GATE_SNAP_PREFIX));
  if (keys.length) {
    await chrome.storage.local.remove(keys);
  }
}

// 오늘/어제 세션 스냅샷을 갱신하며 새 입·퇴실 처리 이벤트를 알림
// - 최초 실행 스냅샷은 조용히 채택 (과거 데이터로 알림 폭주 방지)
// - 알림이 꺼져 있어도 스냅샷은 갱신 (다시 켰을 때 누적분이 한꺼번에 울리지 않도록)
async function processGateEvents(memberId, rawData) {
  try {
    if (!memberId || !rawData) return;

    const todayStr = getTodayString();
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const yesterdayStr = getTodayString(y);
    const nextDates = snapshotSessionsByDate(rawData, [todayStr, yesterdayStr]);

    const key = GATE_SNAP_PREFIX + memberId;
    const stored = await getStorage([key]);
    const prevDates = stored[key] && stored[key].dates ? stored[key].dates : null;

    const settings = await getSettings();
    if (prevDates && settings.gateNotifyEnabled && settings.notificationsEnabled) {
      const events = detectGateEvents(prevDates, nextDates);
      for (const event of events) {
        const msg = formatGateEventMessage(event, todayStr);
        await showNotification(msg.title, msg.body, memberId);
        console.log(`[입퇴실 감지] ${gateEventKey(event)}`);
      }
    }

    await setStorage({ [key]: { dates: nextDates, updatedAt: Date.now() } });
  } catch (e) {
    console.warn('입·퇴실 감지 처리 실패:', e); // 감지 실패가 본래 조회를 깨면 안 됨
  }
}

// ===== E2: 평가 일정 자동 연동 =====
// API: POST https://api.usr.codyssey.kr/schedule/scheduleAllList/ (쿼리스트링, 본문 없음)
// scheduleType=request → result.reqList[] (평가 일정 행, scdlGubunCd==='EV'가 평가)
// ※ usr 프론트엔드 번들 실측(2026-07-17)으로 확정 — 레거시 명세(api.codyssey.kr/http) 아님
// 네이티브 EvalSync.java와 같은 저장 상태키(eval_sync_state)를 공유해 중복 없이 동기화
const EVAL_STATE_KEY = 'eval_sync_state';
const EVAL_INST_CD_KEY = 'eval_inst_cd';
const EVAL_SCHEDULE_API = 'https://api.usr.codyssey.kr';

function ymdDot(d) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// '7월 20일 (월) 14:00' 형태 (알림 본문용)
function formatEvalWhenKo(ms) {
  const d = new Date(ms);
  const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${wd}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function fetchEvalSchedule(memberId, instCd, fromDate, toDate) {
  const qs = `mbrId=${encodeURIComponent(memberId)}&instCd=${encodeURIComponent(instCd)}`
    + `&bgngYmd=${ymdDot(fromDate)}&endYmd=${ymdDot(toDate)}&scheduleType=request`;
  const res = await fetchWithAuth(`${EVAL_SCHEDULE_API}/schedule/scheduleAllList/?${qs}`, {
    method: 'POST', // 실측: 본문 없이 쿼리스트링만 (axios post(url, null, {params})와 동일)
    skipContentType: true // S4: 본문 없는데 JSON Content-Type을 달지 않음 (실측 동작과 동일화)
  });
  if (!res.ok) throw new Error(`EVAL_SCHEDULE_API_ERROR_${res.status}`);
  return await readJsonResponse(res, 'EVAL_SCHEDULE');
}

// instCd 해결: 설정 수동값 → 저장 캐시 → member info 재귀 탐색(발견 시 캐시) 순
async function resolveInstCd() {
  const settings = await getSettings();
  if (settings.evalInstCd) return settings.evalInstCd;
  const cached = await getStorage([EVAL_INST_CD_KEY]);
  if (cached[EVAL_INST_CD_KEY]) return cached[EVAL_INST_CD_KEY];
  try {
    const info = await fetchMemberInfo();
    const found = findInstCd(info);
    if (found) {
      await setStorage({ [EVAL_INST_CD_KEY]: found });
      return found;
    }
  } catch (e) { /* 아래 null 반환 */ }
  return null;
}

// 알람 목록(활성 알람 표시/부팅 복원/일괄 정리 재사용)에 평가 항목 upsert
async function upsertEvalAlarmEntry(memberId, entry) {
  const key = CONFIG.STORAGE_KEYS.ALARMS + memberId;
  const stored = await getStorage([key]);
  const list = (stored[key] || []).filter(a => a && a.name !== entry.name);
  list.push({
    name: entry.name,
    time: entry.time,
    label: entry.label,
    endMinutes: null,
    type: 'eval',
    evalTitle: entry.evalTitle,
    evalWhen: entry.evalWhen,
    leadMinutes: entry.leadMinutes,
    auto: entry.auto === true,
    createdAt: entry.createdAt || Date.now()
  });
  await setStorage({ [key]: list });
}

// 평가 일정 → N분 전 알람 자동 등록/변경/해제 (신규·취소 시 알림)
// - E1 수동 알람(codyssey_eval_e...)과 네임스페이스 분리 (codyssey_eval_auto_...)
// - leadMinutes 변경도 changed로 감지해 재예약 (설정 변경이 자동 알람에 반영됨)
// ※ 동시 호출(주기+GET_STATUS+설정 저장)으로 상태를 각각 읽어 "신규"를 중복 등록/알림하는
//   경합을 막기 위해 in-flight 호출을 공유한다.
// 15차(E3): 스케줄 채널(scheduleAllList) + 알림함 채널(alarmList) 이원화 —
//   한쪽(403 등) 실패필도 다른 채널로 평가를 감지한다.
let evalSyncInFlight = null;
function syncEvalAlarms(memberId) {
  if (evalSyncInFlight) return evalSyncInFlight;
  evalSyncInFlight = doSyncEvalAlarms(memberId)
    .finally(() => { evalSyncInFlight = null; });
  return evalSyncInFlight;
}

async function doSyncEvalAlarms(memberId) {
  if (!memberId) return { ok: false, reason: 'no_member' };
  const settings = await getSettings();
  if (settings.evalAutoSyncEnabled === false) return { ok: false, reason: 'disabled' };

  let schedErr = null;
  let schedInfo = null;
  let noticeErr = null;
  let noticeInfo = null;
  try {
    schedInfo = await syncEvalScheduleChannel(memberId, settings);
  } catch (e) {
    schedErr = String(e.message || 'unknown');
    console.warn('평가 일정 동기화(스케줄 채널) 실패:', schedErr);
  }
  try {
    noticeInfo = await syncEvalNoticeChannel(memberId, settings);
  } catch (e) {
    noticeErr = String(e.message || 'unknown');
    console.warn('평가 일정 동기화(알림함 채널) 실패:', noticeErr);
  }

  // S4/15차: 실패 사유 병합 기록 — 팝업이 채널별 원인 표시 (성공 채널의 오류 흔적은 제거)
  try {
    const cur = (await getStorage([EVAL_STATE_KEY]))[EVAL_STATE_KEY] || {};
    const merged = { ...cur };
    if (schedErr) { merged.lastError = schedErr; merged.lastErrorAt = Date.now(); }
    else { delete merged.lastError; delete merged.lastErrorAt; }
    if (noticeErr) { merged.alarmError = noticeErr; merged.alarmErrorAt = Date.now(); }
    else { delete merged.alarmError; delete merged.alarmErrorAt; }
    if (noticeInfo) merged.noticeFresh = noticeInfo.fresh;
    await setStorage({ [EVAL_STATE_KEY]: merged });
  } catch (e2) { /* 상태 기록 실패는 무시 */ }

  const ok = !schedErr || !noticeErr;
  return {
    ok,
    ...(schedInfo || {}),
    reason: schedErr || undefined,
    noticeError: noticeErr || undefined,
    noticeFresh: noticeInfo ? noticeInfo.fresh : undefined
  };
}

// E3(15차): 알림함(alarmList/list) 평가 감지 채널
// - 신규 알림 1건당 1회 알림 + 캐시(pstartSn), N분 전 알람 등록
// - 스케줄 채널이 이미 잡은 평가(±2분)는 조용히 캐시만 (중복 알람/알림 방지)
const EVAL_NOTICE_STATE_KEY = 'eval_notice_seen';

async function fetchEvalNoticeList(page = 1, pagePerRows = EVAL_NOTICE_PAGE_PER_ROWS) {
  const res = await fetchWithAuth(`${EVAL_SCHEDULE_API}/alarm/alarmList/list`, {
    method: 'POST',
    body: JSON.stringify({ page, pagePerRows }) // 실측 페이로드 (사용자 제공 명세)
  });
  if (!res.ok) throw new Error(`EVAL_NOTICE_API_ERROR_${res.status}`);
  return await readJsonResponse(res, 'EVAL_NOTICE');
}

async function syncEvalNoticeChannel(memberId, settings) {
  const raw = await fetchEvalNoticeList(1);
  const list = (raw && raw.result && (raw.result.list || raw.result.items)) || raw.list || [];
  const items = parseEvalNoticeAlarms(list);
  const stored = await getStorage([EVAL_NOTICE_STATE_KEY]);
  const seen = (stored[EVAL_NOTICE_STATE_KEY] && stored[EVAL_NOTICE_STATE_KEY].ids) || {};
  const fresh = filterNewEvalNotices(seen, items);
  let notified = 0;
  let scheduled = 0;

  if (fresh.length) {
    const lead = settings.evalLeadMinutes ?? 30;
    const now = Date.now();
    const alarmsKey = CONFIG.STORAGE_KEYS.ALARMS + memberId;
    const currentAlarms = ((await getStorage([alarmsKey]))[alarmsKey] || [])
      .filter(a => a && a.type === 'eval' && typeof a.evalWhen === 'number');

    for (const it of fresh) {
      seen[it.pstartSn] = { whenMs: it.whenMs, title: it.title, firstSeenAt: now };

      // E3 중복 방지: 스케줄 채널(또는 이전 pass)이 같은 평가를 이미 알람으로 잡았으면 캐시만
      const covered = currentAlarms.some(a => Math.abs(a.evalWhen - it.whenMs) <= EVAL_NOTICE_DEDUP_MS);
      if (covered) continue;
      if (it.whenMs <= now) continue; // 지나간 평가는 알람 없이 캐시만

      const name = buildEvalAlarmName(EVAL_AUTO_ID_PREFIX + it.key);
      const triggerAt = Math.max(it.whenMs - lead * 60000, now + 5000);
      await chrome.alarms.create(name, { when: triggerAt });
      await upsertEvalAlarmEntry(memberId, {
        name,
        time: triggerAt,
        label: `📋 ${it.title}`,
        evalTitle: it.title,
        evalWhen: it.whenMs,
        leadMinutes: lead,
        auto: true,
        state: it.state || ''
      });
      currentAlarms.push({ evalWhen: it.whenMs, type: 'eval' }); // 동일 pass 내 중복 방지
      scheduled++;
      if (settings.notificationsEnabled && notified < 3) {
        notified++;
        await showNotification(
          '📋 평가 일정 감지',
          `${formatEvalWhenKo(it.whenMs)} — ${it.title} (알림함 감지 · ${lead}분 전 알람 등록)`,
          memberId
        );
      }
    }

    // seen 캐시 프루닝 + 저장
    const cutoff = Date.now() - EVAL_NOTICE_SEEN_TTL_MS;
    for (const k of Object.keys(seen)) {
      if ((seen[k].firstSeenAt || 0) < cutoff) delete seen[k];
    }
    await setStorage({ [EVAL_NOTICE_STATE_KEY]: { ids: seen, updatedAt: Date.now() } });
  }
  return { ok: true, fresh: fresh.length, notified, scheduled, total: items.length };
}

// 채널1: scheduleAllList (기존 E2 로직)
async function syncEvalScheduleChannel(memberId, settings) {
  const instCd = await resolveInstCd();
  if (!instCd) throw new Error('no_instcd'); // 오케스트레이터가 알림함 채널은 계속 진행
  try {
    const stateRaw = await getStorage([EVAL_STATE_KEY]);
    const state = stateRaw[EVAL_STATE_KEY] || null;
    const prevItems = (state && state.memberId === String(memberId) && Array.isArray(state.items))
      ? state.items : [];

    // C1: 조회 범위를 어제~+365일로 — 30일 밖 평가도 잡히는 즉시 알람 등록 ("평가가 잡혔을 때" 기대 충족)
    const from = new Date(); from.setDate(from.getDate() - 1);
    const to = new Date(); to.setDate(to.getDate() + 365);
    const raw = await fetchEvalSchedule(memberId, instCd, from, to);
    const reqList = (raw && raw.result && (raw.result.reqList || raw.result.list)) || raw.reqList || [];
    const parsed = parseScheduleRows(reqList);
    const lead = settings.evalLeadMinutes ?? 30;
    const diff = diffEvalItems(prevItems, parsed.items, lead);

    const now = Date.now();
    const nextItems = [];
    let notified = 0;

    for (const it of parsed.items) {
      const action = diff.added.some(a => a.key === it.key) ? 'add'
        : diff.changed.some(c => c.key === it.key) ? 'change' : 'keep';
      const existing = prevItems.find(p => p.key === it.key);
      const name = (existing && existing.name) || buildEvalAlarmName(EVAL_AUTO_ID_PREFIX + it.key);

      // 지나간 평가: 예약·목록 모두 정리하고 상태에서도 제외
      if (it.whenMs <= now) {
        if (existing) await cancelAlarmByName(name);
        continue;
      }

      if (action !== 'keep') {
        await cancelAlarmByName(name); // 변경 시 이전 예약 정리 후 재예약
        // lead가 이미 지났으면 즉시 알림(5초 후) — 방금 잡힌 곧 시작할 평가도 알림 누락 없이
        const triggerAt = Math.max(it.whenMs - lead * 60000, now + 5000);
        await chrome.alarms.create(name, { when: triggerAt });
        await upsertEvalAlarmEntry(memberId, {
          name,
          time: triggerAt,
          label: `📋 ${it.title}`,
          evalTitle: it.title,
          evalWhen: it.whenMs,
          leadMinutes: lead,
          auto: true,
          state: it.state || ''
        });
        // C2: 협의중(00001)은 조용히 등록 — 확정/진행(00002/00003) 또는 상태 미상일 때만 "감지" 알림
        if (settings.notificationsEnabled && notified < 3 && isEvalConfirmed(it.state)) {
          notified++;
          await showNotification(
            '📋 평가 일정 감지',
            `${formatEvalWhenKo(it.whenMs)} — ${it.title} (${lead}분 전 알람 등록)`,
            memberId
          );
        }
      } else if (existing) {
        // C2: 협의중 → 확정/진행 전환은 알람 변경 없이 "확정" 알림만
        const prevState = existing.state || '';
        if (!isEvalConfirmed(prevState) && isEvalConfirmed(it.state)
            && settings.notificationsEnabled && notified < 3) {
          notified++;
          await showNotification(
            '📋 평가 확정',
            `${formatEvalWhenKo(it.whenMs)} — ${it.title} 평가가 확정되었습니다. (${lead}분 전 알람 유지)`,
            memberId
          );
        }
        nextItems.push({ ...existing, ...it, name: existing.name });
        continue;
      }
      nextItems.push({ ...it, name, leadMinutes: lead, auto: true });
    }

    for (const rem of diff.removed) {
      if (rem.name) await cancelAlarmByName(rem.name);
      if (settings.notificationsEnabled && notified < 3) {
        notified++;
        await showNotification(
          '📋 평가 일정 변경',
          `${rem.title || '평가'} 일정이 취소/완료되어 알람을 해제했습니다.`,
          memberId
        );
      }
    }

    await setStorage({
      [EVAL_STATE_KEY]: {
        memberId: String(memberId),
        instCd,
        items: nextItems,
        fetchedAt: now,
        skipped: parsed.skipped,
        nonEv: parsed.nonEv || 0, // 평가 아닌 행 수 (AM/EXAM/MT 등)
        sampleKeys: parsed.sampleKeys || null // 필드명 보정용 진단 (첫 EV 행의 키 목록)
      }
    });
    return { ok: true, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, items: nextItems.length };
  } catch (e) {
    throw e; // 실패 병합 기록은 오케스트레이터(doSyncEvalAlarms)에서 일원 처리
  }
}

// GET_STATUS 팝업 표시용 평가 동기화 상태 요약 (S4/15차: 알림함 채널 오류 포함)
function summarizeEvalSyncState(state) {
  if (!state) return { fetchedAt: 0, items: 0, lastError: null, alarmError: null };
  return {
    fetchedAt: state.fetchedAt || 0,
    items: Array.isArray(state.items) ? state.items.length : 0,
    lastError: state.lastError || null,
    alarmError: state.alarmError || null, // 15차(E3): 알림함 채널 오류
    noticeFresh: state.noticeFresh || 0
  };
}

// ===== 알람 관리 (이름 생성/파싱은 shared-attendance.js 단일 소스 사용) =====
async function scheduleExitAlarm(memberId, endMinutes, label = '퇴실 시간', type = 'exit') {
  const now = Date.now();
  const target = new Date();
  target.setHours(0, 0, 0, 0);
  target.setTime(target.getTime() + endMinutes * 60000); // 24시간 초과분은 자동으로 다음 날
  const delay = target.getTime() - now;

  if (delay <= 0) return { success: false, reason: 'past' };

  const alarmName = buildAlarmName(memberId, type, endMinutes);
  
  // 기존 알람 제거 후 재생성 (알람 목록에서도 중복 제거)
  await chrome.alarms.clear(alarmName);
  await chrome.alarms.create(alarmName, { when: target.getTime() });
  
  const alarms = await getStorage([CONFIG.STORAGE_KEYS.ALARMS + memberId]);
  const alarmList = (alarms[CONFIG.STORAGE_KEYS.ALARMS + memberId] || [])
    .filter(a => a.name !== alarmName);
  alarmList.push({
    name: alarmName,
    time: target.getTime(),
    label,
    endMinutes,
    type,
    createdAt: now
  });
  await setStorage({ [CONFIG.STORAGE_KEYS.ALARMS + memberId]: alarmList });

  return { success: true, alarmName, triggerTime: target.getTime() };
}

async function cancelExitAlarm(memberId, endMinutes, type = 'exit') {
  const alarmName = buildAlarmName(memberId, type, endMinutes);
  const legacyName = legacyAlarmName(memberId, endMinutes);
  await chrome.alarms.clear(alarmName);
  // 구형 이름으로 저장된 경우도 함께 정리 (N3 유령 알람 방지)
  await chrome.alarms.clear(legacyName);
  
  const alarms = await getStorage([CONFIG.STORAGE_KEYS.ALARMS + memberId]);
  const alarmList = (alarms[CONFIG.STORAGE_KEYS.ALARMS + memberId] || [])
    .filter(a => a.name !== alarmName && a.name !== legacyName);
  await setStorage({ [CONFIG.STORAGE_KEYS.ALARMS + memberId]: alarmList });
}

// 문제2 수정: 저장된 "실제 이름"으로 해제 — 신/구형 이름 모두 정리하고,
// 어떤 계정 키에 저장됐든 알람 저장소 전수 스캔으로 확실히 제거
async function cancelAlarmByName(alarmName) {
  const names = equivalentAlarmNames(alarmName);
  for (const n of names) {
    try { await chrome.alarms.clear(n); } catch (e) { /* 무시 */ }
  }

  const all = await getStorage(null);
  const alarmKeys = Object.keys(all).filter(k => k.startsWith(CONFIG.STORAGE_KEYS.ALARMS));
  for (const key of alarmKeys) {
    const list = all[key] || [];
    const kept = list.filter(a => !a || !names.includes(a.name));
    if (kept.length !== list.length) {
      await setStorage({ [key]: kept });
    }
  }
}

async function getActiveAlarms(memberId) {
  const alarms = await getStorage([CONFIG.STORAGE_KEYS.ALARMS + memberId]);
  const list = alarms[CONFIG.STORAGE_KEYS.ALARMS + memberId] || [];
  // K8: 발화하지 못한 채 지나간 알람(브라우저 꺼짐 중 소실 등)은 읽을 때 자가정비
  const now = Date.now();
  const fresh = list.filter(a => !a || typeof a.time !== 'number' || a.time > now);
  if (fresh.length !== list.length) {
    await setStorage({ [CONFIG.STORAGE_KEYS.ALARMS + memberId]: fresh });
  }
  // 구형 항목 정규화 (type/createdAt 기본값 보강 — N3)
  return fresh.map(a => ({
    ...a,
    type: a.type || 'exit',
    createdAt: a.createdAt || a.time
  }));
}

// ===== 알림 표시 =====
async function showNotification(title, body, memberId) {
  const settings = await getSettings();
  if (!settings.notificationsEnabled) return;

  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title,
      message: body,
      priority: 2,
      requireInteraction: true
    });
  } catch (e) {
    console.warn('Notification failed:', e);
  }
}

// 알람 리스너
chrome.alarms.onAlarm.addListener(async (alarm) => {
  // E1: 평가 알람 — 이름 규칙이 달라 전용 분기
  if (parseEvalAlarmName(alarm.name)) {
    await handleEvalAlarmFired(alarm);
    return;
  }

  const parsedName = parseAlarmName(alarm.name);
  if (!parsedName) return;

  const { memberId, type, endMinutes } = parsedName;

  // K3: 브라우저가 꺼져 있던 사이 지나간 알람이 재시작 시 늦게 발화되면
  // (예: 전날 18:00 알림이 다음날 아침에 울림) 알림은 생략하고 목록만 정리
  if (isAlarmStale(alarm.scheduledTime)) {
    console.log(`[알람] 예정 시각 대비 크게 지연된 발화 무시: ${alarm.name}`);
    await cancelExitAlarm(memberId, endMinutes, type);
    return;
  }

  const what = type === 'goal' ? '목표 달성 시간' : '퇴실 시간';

  await showNotification(
    '⏰ 코디세이 출입 알림',
    `설정한 ${formatEndMinutes(endMinutes)} ${what}이 되었습니다.`, // K11: 포맷 단일 소스
    memberId
  );

  // 알람 울린 후 정리
  await cancelExitAlarm(memberId, endMinutes, type);

  // 팝업이 열리면 업데이트 알림
  chrome.runtime.sendMessage({ type: 'ALARM_TRIGGERED', memberId, endMinutes, alarmType: type }).catch(() => {});
});

// E1: 평가 알람 발화 처리
// - 브라우저가 꺼져 있던 사이 예정 시각이 지난 경우: 평가 시작 전이면 늦게라도 알림,
//   평가 시작이 (5분 이상) 지났으면 알림 없이 정리만 (K3 정책의 평가판)
async function handleEvalAlarmFired(alarm) {
  // 저장 목록(어떤 계정 키든)에서 평가 정보를 찾는다
  let info = null;
  try {
    const all = await getStorage(null);
    const alarmKeys = Object.keys(all).filter(k => k.startsWith(CONFIG.STORAGE_KEYS.ALARMS));
    for (const key of alarmKeys) {
      const list = all[key] || [];
      const found = list.find(a => a && a.name === alarm.name);
      if (found) { info = found; break; }
    }
  } catch (e) { /* 무시 */ }

  const title = (info && info.evalTitle) || '평가';
  const lead = (info && typeof info.leadMinutes === 'number') ? info.leadMinutes : null;
  const evalWhen = info && info.evalWhen ? info.evalWhen : 0;

  // 평가 시작이 이미 5분 이상 지났으면 사전 알림으로서 의미가 없음 → 알림 생략
  const expired = evalWhen > 0
    ? Date.now() > evalWhen + 5 * 60 * 1000
    : isAlarmStale(alarm.scheduledTime);
  if (!expired) {
    const leadText = lead === 0 ? '지금 시작' : lead !== null ? `${lead}분 전` : '알림';
    const whenText = evalWhen
      ? `${String(new Date(evalWhen).getHours()).padStart(2, '0')}:${String(new Date(evalWhen).getMinutes()).padStart(2, '0')} 시작`
      : '';
    await showNotification(
      '📋 평가 알림',
      `${title} — ${leadText}${whenText ? ` (${whenText})` : ''}`,
      null
    );
  }

  // 발화된 평가 알람은 목록에서 제거 (유령 방지 — exit 알람과 동일 정책)
  await cancelAlarmByName(alarm.name);
  chrome.runtime.sendMessage({ type: 'ALARM_TRIGGERED', evalAlarm: true }).catch(() => {});
}

// ===== 메시지 핸들러 =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message.type) {
        // --- 상태 조회 (메인) ---
        case 'GET_STATUS': {
          let memberId = await getMemberId();
          
          // 저장된 mbrId 없으면 API로 조회
          if (!memberId) {
            try {
              const memberInfo = await fetchMemberInfo();
              memberId = extractMemberId(memberInfo);
              if (memberId) {
                await saveMemberId(memberId);
              }
            } catch (e) {
              if (e.message === 'AUTH_REQUIRED') {
                sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
                return;
              }
              console.warn('Member info fetch failed:', e);
            }
          }
          
          if (!memberId) {
            sendResponse({ success: false, error: 'NO_MEMBER_ID' });
            return;
          }

          const now = new Date();
          const force = message.force === true;
          // J1: force면 캐시 바이패스 (수동 새로고침 의도 존중)
          const data = await fetchAttendance(memberId, now.getFullYear(), now.getMonth() + 1, force);
          const parsed = parseAttendance(data, now);

          // 전월 데이터가 필요한 경우를 한 번의 조회로 합침:
          // ①이달에 입실 중이 아님(R2/L4 월 경계 입실 확인) ②월 초 1~2일(G1 '어제'가 전월에 걸침 — B8 공백)
          // W7: force 새로고침 시 전월도 캐시 바이패스 (기존엔 당월만 force라 전월이 낡은 캐시였음)
          let gateSource = data;
          if (!parsed.isCurrentlyIn || now.getDate() <= 2) {
            try {
              const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
              const prevData = await fetchAttendance(memberId, prev.getFullYear(), prev.getMonth() + 1, force);
              if (!parsed.isCurrentlyIn) applyOvernightFromPrevMonth(parsed, prevData);
              if (now.getDate() <= 2) gateSource = mergeDetailLists(prevData, data);
            } catch (e) {
              console.warn('전월 데이터 확인 실패:', e);
            }
          }

          // G1: 새 조회 결과로 입·퇴실 처리 이벤트 감지 (스냅샷 중복 제거로 다중 호출 안전)
          processGateEvents(memberId, gateSource).catch(() => {});
          // E2: 평가 일정 자동 연동 (상태 diff로 다중 호출 안전)
          syncEvalAlarms(memberId).catch(() => {});

          const settings = await getSettings();
          const alarms = await getActiveAlarms(memberId);
          // S4: 평가 연동 상태도 함께 반환 — 팝업이 실패 원인(403/세션 만료/instCd 등)을 표시
          const evalState = (await getStorage([EVAL_STATE_KEY]))[EVAL_STATE_KEY] || null;
          sendResponse({
            success: true, memberId, parsed, settings, alarms,
            evalSync: summarizeEvalSyncState(evalState)
          });
          break;
        }

        // --- 멤버 ID 직접 조회 (수동 새로고침용) ---
        case 'FETCH_MEMBER_ID': {
          try {
            const memberInfo = await fetchMemberInfo();
            const memberId = extractMemberId(memberInfo);
            if (memberId) {
              await saveMemberId(memberId);
              sendResponse({ success: true, memberId, raw: memberInfo });
            } else {
              sendResponse({ success: false, error: 'MBR_ID_NOT_FOUND_IN_RESPONSE', raw: memberInfo });
            }
          } catch (e) {
            sendResponse({ success: false, error: e.message });
          }
          break;
        }

        // --- 콘텐츠 스크립트에서 감지된 mbrId 저장 ---
        case 'DETECT_MEMBER_ID': {
          if (message.memberId) {
            await saveMemberId(message.memberId);
            sendResponse({ success: true, memberId: message.memberId });
          } else {
            sendResponse({ success: false, error: 'NO_MEMBER_ID' });
          }
          break;
        }

        // --- 출입기록 조회 (캘린더용 - 특정 년월) ---
        case 'FETCH_ATTENDANCE': {
          let memberId = message.memberId || await getMemberId();
          
          if (!memberId) {
            // 자동으로 멤버 정보 조회 시도
            try {
              const memberInfo = await fetchMemberInfo();
              memberId = extractMemberId(memberInfo);
              if (memberId) await saveMemberId(memberId);
            } catch (e) {
              sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
              return;
            }
          }
          
          if (!memberId) {
            sendResponse({ success: false, error: 'NO_MEMBER_ID' });
            return;
          }
          
          const { year, month } = message;
          const data = await fetchAttendance(memberId, year, month, message.force === true);
          const parsed = parseAttendance(data, new Date(year, month - 1));
          sendResponse({ success: true, parsed });
          break;
        }

        // --- Q1: 세션 전환(로그인 직후) — 저장 memberId + 캐시 폐기 ---
        case 'CLEAR_MEMBER_ID': {
          await clearSessionIdentity();
          sendResponse({ success: true });
          break;
        }

        case 'SET_ALARM': {
          const memberId = await getMemberId();
          if (!memberId) {
            sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
            return;
          }
          const { endMinutes, label, alarmType } = message;
          const result = await scheduleExitAlarm(memberId, endMinutes, label, alarmType || 'exit');
          sendResponse(result);
          break;
        }

        // --- E1: 평가 알람 등록 (평가 시각 - N분에 1회 알림) ---
        case 'SET_EVAL_ALARM': {
          const memberId = await getMemberId();
          if (!memberId) {
            sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
            return;
          }
          const title = (message.title || '').toString().trim() || '평가';
          const whenMs = Number(message.whenMs);
          const leadMinutes = Number(message.leadMinutes);

          const invalid = validateEvalAlarm(whenMs, leadMinutes);
          if (invalid) {
            sendResponse({ success: false, reason: invalid });
            break;
          }

          const triggerAt = whenMs - leadMinutes * 60000;
          const alarmName = buildEvalAlarmName(message.evalId || newEvalId());

          await chrome.alarms.clear(alarmName);
          await chrome.alarms.create(alarmName, { when: triggerAt });

          // 활성 알람 목록에 함께 저장 (부팅 복원/일괄 정리/해제 파이프라인 재사용)
          const alarmsRes = await getStorage([CONFIG.STORAGE_KEYS.ALARMS + memberId]);
          const alarmList = (alarmsRes[CONFIG.STORAGE_KEYS.ALARMS + memberId] || [])
            .filter(a => a.name !== alarmName);
          alarmList.push({
            name: alarmName,
            time: triggerAt,
            label: `📋 ${title}`,
            endMinutes: null,
            type: 'eval',
            evalTitle: title,
            evalWhen: whenMs,
            leadMinutes,
            createdAt: Date.now()
          });
          await setStorage({ [CONFIG.STORAGE_KEYS.ALARMS + memberId]: alarmList });

          sendResponse({ success: true, alarmName, triggerTime: triggerAt });
          break;
        }

        // --- E2: 평가 일정 수동 1회 동기화 (설정 저장 직후 등) ---
        case 'SYNC_EVAL_ALARMS': {
          const memberId = await getMemberId();
          const result = await syncEvalAlarms(memberId);
          sendResponse({ success: result.ok !== false, result });
          break;
        }

        // --- 알람 해제 ---
        case 'CANCEL_ALARM': {
          // 문제2 수정: memberId로 이름을 재계산하지 않고 "목록에 저장된 실제 이름"으로 해제.
          // (세션 만료/계정 전환 등으로 memberId가 달라도 저장된 알람과 반드시 일치)
          if (message.alarmName) {
            await cancelAlarmByName(message.alarmName);
            sendResponse({ success: true });
            break;
          }
          // 하위 호환(endMinutes/type): 목록에서 해당 항목의 실제 이름을 우선 찾아 해제
          const memberId = await getMemberId();
          if (!memberId) {
            sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
            return;
          }
          const { endMinutes, alarmType } = message;
          const stored = await getStorage([CONFIG.STORAGE_KEYS.ALARMS + memberId]);
          const listForFind = stored[CONFIG.STORAGE_KEYS.ALARMS + memberId] || [];
          const found = listForFind.find(a =>
            a && a.endMinutes === endMinutes && (a.type || 'exit') === (alarmType || 'exit'));
          if (found && found.name) {
            await cancelAlarmByName(found.name);
          } else {
            await cancelExitAlarm(memberId, endMinutes, alarmType || 'exit');
          }
          sendResponse({ success: true });
          break;
        }

        // --- 팝업 발신 로컬 알림 (chrome.notifications로 라우팅) ---
        case 'LOCAL_NOTIFY': {
          await showNotification(message.title || '알림', message.body || '', null);
          sendResponse({ success: true });
          break;
        }

        // --- 알람 목록 ---
        case 'GET_ALARMS': {
          const memberId = await getMemberId();
          if (!memberId) {
            sendResponse({ success: false, error: 'NOT_LOGGED_IN' });
            return;
          }
          const alarms = await getActiveAlarms(memberId);
          sendResponse({ success: true, alarms });
          break;
        }

        // --- 설정 저장 ---
        case 'UPDATE_SETTINGS': {
          await saveSettings(message.settings);
          await syncKeepAliveAlarm(); // J2: keep-alive 토글을 알람에 즉시 반영
          await syncPeriodicSyncAlarm(); // 감지/평가 토글을 주기 알람에 즉시 반영
          // E2: 평가 연동 토글/기본 시점(분) 변경을 자동 알람에 즉시 반영 (lead 변경 시 재예약)
          getMemberId()
            .then(id => (id ? syncEvalAlarms(id) : null))
            .catch(() => {});
          sendResponse({ success: true });
          break;
        }

        // --- 설정 조회 ---
        case 'GET_SETTINGS': {
          const settings = await getSettings();
          sendResponse({ success: true, settings });
          break;
        }

        // --- 로그아웃 ---
        case 'LOGOUT': {
          await clearSessionIdentity(); // Q1: memberId + 캐시 폐기 공통화
          // Q4: keep-alive도 해제 — 로그아웃 상태에서 계속 핑 쏘지 않도록
          const settingsAtLogout = await getSettings();
          if (settingsAtLogout.keepAliveEnabled) {
            settingsAtLogout.keepAliveEnabled = false;
            await saveSettings(settingsAtLogout);
          }
          await syncKeepAliveAlarm(); // J2 알람도 해제
          await syncPeriodicSyncAlarm(); // Q4 연계 — 로그아웃 후 불필요한 주기 알람 해제
          const all = await getStorage(null);
          const keysToRemove = Object.keys(all).filter(k => k.startsWith(CONFIG.STORAGE_KEYS.CACHE));
          if (keysToRemove.length) {
            await chrome.storage.local.remove(keysToRemove);
          }
          // M3: 예약된 알람도 전부 정리 (chrome 알람 + 저장 목록)
          // 저장 목록에 없는 구형/유령 알람까지 포함해 codyssey_ 접두어 알람 전부 해제 (K12)
          try {
            const chromeAlarms = await chrome.alarms.getAll();
            for (const ca of chromeAlarms) {
              if (ca.name.startsWith('codyssey_')) {
                try { await chrome.alarms.clear(ca.name); } catch (e) { /* 무시 */ }
              }
            }
          } catch (e) { /* 무시 */ }
          const alarmKeysToRemove = Object.keys(all).filter(k => k.startsWith(CONFIG.STORAGE_KEYS.ALARMS));
          if (alarmKeysToRemove.length) {
            await chrome.storage.local.remove(alarmKeysToRemove);
          }
          // 서버 세션 쿠키(JSESSIONID 등)도 함께 삭제 — 로그아웃 후 자동 재로그인 방지
          try {
            const cookies = await chrome.cookies.getAll({ domain: 'codyssey.kr' });
            await Promise.all(cookies.map(c =>
              chrome.cookies.remove({
                url: `https://${c.domain.replace(/^\./, '')}${c.path}`,
                name: c.name
              }).catch(() => {})
            ));
          } catch (e) {
            console.warn('세션 쿠키 삭제 실패:', e);
          }
          sendResponse({ success: true });
          break;
        }
      }
    } catch (error) {
      console.error('Background error:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();
  return true; // 비동기 응답
});

// ===== 설치/업데이트 시 =====
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    await saveSettings(DEFAULT_SETTINGS);
    console.log('코디세이 출입기록 익스텐션 설치됨');
  }
  // L8: 구형 알람(codyssey_exit_*)을 신형으로 1회 마이그레이션
  await migrateLegacyAlarms();
});

// 구형 알람 마이그레이션: 저장소 항목과 실제 chrome 알람을 신형 이름으로 변환 (L8)
async function migrateLegacyAlarms() {
  try {
    const all = await getStorage(null);
    const alarmKeys = Object.keys(all).filter(k => k.startsWith(CONFIG.STORAGE_KEYS.ALARMS));

    for (const key of alarmKeys) {
      const list = all[key] || [];
      let changed = false;
      for (const alarm of list) {
        if (!alarm || typeof alarm.name !== 'string') continue;
        const parsed = parseAlarmName(alarm.name);
        if (!parsed) continue;
        const newName = buildAlarmName(parsed.memberId, parsed.type, parsed.endMinutes);
        if (alarm.name !== newName) {
          const scheduledTime = alarm.time;
          await chrome.alarms.clear(alarm.name);
          // 남은 시간이 있으면 신형 이름으로 재등록
          if (scheduledTime && scheduledTime > Date.now()) {
            await chrome.alarms.create(newName, { when: scheduledTime });
          }
          alarm.name = newName;
          alarm.type = parsed.type;
          changed = true;
        }
      }
      if (changed) {
        await setStorage({ [key]: list });
      }
    }

    // 저장소에 없는 구형 chrome 알람도 스캔해 정리/변환
    const chromeAlarms = await chrome.alarms.getAll();
    for (const ca of chromeAlarms) {
      if (!ca.name.startsWith('codyssey_')) continue;
      const parsed = parseAlarmName(ca.name);
      if (parsed) {
        const newName = buildAlarmName(parsed.memberId, parsed.type, parsed.endMinutes);
        if (ca.name !== newName) {
          await chrome.alarms.clear(ca.name);
          await chrome.alarms.create(newName, { when: ca.scheduledTime });
        }
      }
    }
  } catch (e) {
    console.warn('구형 알람 마이그레이션 실패:', e);
  }
}

// 주기적 백그라운드 동기화 (G1: 입·퇴실 감지 / E2: 평가 연동)
// 필요한 기능이 하나도 없으면 알람 자체를 만들지 않음 — 배터리·트래픽 보호, keep-alive 핑과도 역할 분리
async function syncPeriodicSyncAlarm() {
  try {
    const settings = await getSettings();
    // keepAlive '단독'은 keepalive_ping(25분)이 담당하므로 여기서는 감지/평가 연동만
    const need = settings.gateNotifyEnabled !== false
      || settings.evalAutoSyncEnabled !== false;
    const existing = await chrome.alarms.get('periodic_sync');
    if (need && !existing) {
      chrome.alarms.create('periodic_sync', { periodInMinutes: 15 });
    } else if (!need && existing) {
      await chrome.alarms.clear('periodic_sync');
    }
  } catch (e) { console.warn('periodic_sync 동기화 실패:', e); }
}
syncPeriodicSyncAlarm(); // SW 기동 시점에 설정과 알람 상태 일치

// J2: keep-alive 핑을 서비스 워커 알람으로 관리 — 팝업 생명주기와 무관하게 동작.
// (기존 popup.js 타이머는 팝업이 열린 동안에만 유효 → 설정과 실제 동작이 어긋났음)
const KEEPALIVE_ALARM = 'keepalive_ping';
async function syncKeepAliveAlarm() {
  try {
    const settings = await getSettings();
    const existing = await chrome.alarms.get(KEEPALIVE_ALARM);
    // 입·퇴실 감지 또는 평가 연동이 켜져 있으면 15분 주기 인증 조회가 세션을 유지하므로
    // 별도 핑은 keepAlive '단독'일 때만 생성 (B4/W6 — 핑 중복 제거)
    const solo = settings.keepAliveEnabled
      && settings.gateNotifyEnabled === false
      && settings.evalAutoSyncEnabled === false;
    if (solo && !existing) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 25 });
    } else if (!solo && existing) {
      await chrome.alarms.clear(KEEPALIVE_ALARM);
    }
  } catch (e) {
    console.warn('keep-alive 알람 동기화 실패:', e);
  }
}
syncKeepAliveAlarm(); // SW 기동 시점에 설정과 알람 상태 일치

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'periodic_sync') {
    const memberId = await getMemberId();
    if (!memberId) return;
    const settings = await getSettings();
    if (settings.gateNotifyEnabled !== false) {
      try {
        // G1: 캐시 무효화만 하던 주기 동기화를 실제 조회 + 입·퇴실 감지로 전환
        const now = new Date();
        const data = await fetchAttendance(memberId, now.getFullYear(), now.getMonth() + 1, true);
        // B8: 월 초 1~2일은 전월 말 데이터를 합쳐 '어제'(전월) 스냅샷 비교 공백 방지
        let gateSource = data;
        if (now.getDate() <= 2) {
          try {
            const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            const prevData = await fetchAttendance(memberId, prev.getFullYear(), prev.getMonth() + 1);
            gateSource = mergeDetailLists(prevData, data);
          } catch (e) { /* 당월 데이터만으로 계속 진행 */ }
        }
        await processGateEvents(memberId, gateSource);
        // keepAlive가 켜져 있어도 이 인증 조회가 세션을 유지하므로 별도 핑은 만들지 않음 (B4/W6)
      } catch (e) {
        console.warn('주기 입·퇴실 감지 실패:', e.message);
      }
    }
    if (settings.evalAutoSyncEnabled !== false) {
      await syncEvalAlarms(memberId).catch(() => {}); // E2: 평가 일정도 주기 동기화
    }
  }
  // J2: keep-alive 핑 — 세션 터치 (응답 본문은 불필요, 만료 시 정리)
  // ※ 입·퇴실 감지/평가 연동이 하나라도 켜져 있으면 15분 주기 인증 조회가 세션을 유지하므로
  //   이 알람은 keepAlive '단독' 케이스에만 생성됨 (W6 중복 핑 제거)
  if (alarm.name === KEEPALIVE_ALARM) {
    const settings = await getSettings();
    if (!settings.keepAliveEnabled) {
      await chrome.alarms.clear(KEEPALIVE_ALARM);
      return;
    }
    try {
      await fetchMemberInfo();
    } catch (e) {
      if (e.message === 'AUTH_REQUIRED') {
        await clearSessionIdentity(); // Q1: 만료 시 식별자/캐시 폐기
      }
      console.warn('[KeepAlive] ping 실패:', e.message);
    }
  }
});