// ============================================================
// 중계 하네스 — popup.html/popup.js를 일반 브라우저 탭에서 실행하되
// 백엔드는 로컬 파이썬 중계 서버(relay server). 실제 코디세이 데이터로 동작.
// - chrome.runtime.sendMessage → 필요 시 클라이언트에서 계산(진짜 shared-attendance) 후
//   최소 요청만 /msg로 전달. GET_STATUS/FETCH_ATTENDANCE의 파싱, 알람 이름 규칙,
//   입·퇴실 감지, 평가 일정 동기는 여기서 background.js/adapter와 같은 규칙으로 수행
// - 로그인: popup은 CodysseyNative 경로를 타도록 중계 (CORS 우회)
// ============================================================

const RY = {
  lastSyncAt: 0,
  evalInFlight: null,
  memberInfoCache: null
};

// ===== /msg /kv /events 헬퍼 =====
async function ryMsg(type, data = {}) {
  const res = await fetch('/msg', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, ...data })
  });
  return res.json();
}

async function ryKvGet(key) {
  const res = await fetch('/kv?key=' + encodeURIComponent(key));
  const j = await res.json();
  return j ? j.value : null;
}

async function ryKvSet(key, value) {
  await fetch('/kv', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value })
  });
}

// ===== 알림 (브라우저 Notification 우선, 실패 시 토스트) =====
function ryToast(title, body) {
  let box = document.getElementById('relay-toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'relay-toasts';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'relay-toast';
  el.textContent = `${title} — ${body}`;
  box.appendChild(el);
  setTimeout(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 5000);
}

async function ryNotify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body });
      return;
    }
  } catch (e) { /* 토스트로 폴곤 */ }
  ryToast(title, body);
}

// ===== chrome 런타임 폴리필 (중계판) =====
// popup.js가 사용하는 백엔드 시맨틱스를 background.js와 같은 형태로 제공.
// 파싱/계산은 shared-attendance.js(진짜 제품 코드)를 이 스코프에서 직접 사용.
const ryRuntimeListeners = [];
function ryDispatch(message) {
  for (const fn of ryRuntimeListeners) {
    try { fn(message, {}, () => {}); } catch (e) { console.warn('[relay] listener error:', e); }
  }
}

async function ryGetStatus(message) {
  const res = await ryMsg('GET_STATUS', { force: message.force === true });
  if (!res.success) return res;

  const now = new Date();
  const parsed = parseAttendance(res.raw, now);

  // 월 경계 입실(R2/L4): 이달에 입실 중이 아니면 전월 말 확인 — background.js와 동일 경로
  if (!parsed.isCurrentlyIn) {
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevRes = await ryMsg('FETCH_ATTENDANCE', {
      year: prev.getFullYear(), month: prev.getMonth() + 1
    });
    if (prevRes.success && prevRes.raw) applyOvernightFromPrevMonth(parsed, prevRes.raw);
  }

  // G1/E2 부가 동작 — 비동기로 (응답을 막지 않음)
  ryProcessGateEvents(res.memberId, res.raw, res.settings).catch(() => {});
  rySyncEvalAlarms(res.memberId, res.settings).catch(() => {});

  return {
    success: true,
    memberId: res.memberId,
    parsed,
    settings: { ...res.settings },
    alarms: res.alarms
  };
}

async function ryFetchAttendance(message) {
  const res = await ryMsg('FETCH_ATTENDANCE', {
    year: message.year, month: message.month, force: message.force === true
  });
  if (!res.success) return res;
  const parsed = parseAttendance(res.raw, new Date(message.year, message.month - 1));
  return { success: true, parsed };
}

async function rySetEvalAlarm(message) {
  const invalid = validateEvalAlarm(Number(message.whenMs), Number(message.leadMinutes));
  if (invalid) return { success: false, reason: invalid };
  const alarmName = buildEvalAlarmName(newEvalId());
  const res = await ryMsg('SET_EVAL_ALARM', {
    alarmName,
    title: (message.title || '').toString().trim() || '평가',
    whenMs: Number(message.whenMs),
    leadMinutes: Number(message.leadMinutes)
  });
  return res;
}

async function ryCancelAlarm(message) {
  const names = new Set();
  if (message.alarmName) {
    for (const n of equivalentAlarmNames(message.alarmName)) names.add(n);
  } else {
    // endMinutes/type 경로: 목록에서 실제 이름을 찾아 해제 (background와 동일 의미)
    const list = await ryMsg('GET_ALARMS');
    const alarms = list.alarms || [];
    const type = message.alarmType || 'exit';
    const found = alarms.filter(a => a && a.endMinutes === message.endMinutes && (a.type || 'exit') === type);
    if (found.length) {
      for (const f of found) for (const n of equivalentAlarmNames(f.name)) names.add(n);
    } else {
      names.add(`codyssey_alarm_unknown_${type}_${message.endMinutes}`);
      names.add(`codyssey_exit_unknown_${message.endMinutes}`);
    }
  }
  return ryMsg('CANCEL_ALARM', { names: [...names] });
}

async function ryHandleMessage(message) {
  switch (message.type) {
    case 'GET_STATUS': return ryGetStatus(message);
    case 'FETCH_ATTENDANCE': return ryFetchAttendance(message);
    case 'SET_EVAL_ALARM': return rySetEvalAlarm(message);
    case 'CANCEL_ALARM': return ryCancelAlarm(message);
    case 'SYNC_EVAL_ALARMS': {
      const mid = await ryMsg('FETCH_MEMBER_ID');
      return rySyncEvalAlarms(mid.success ? mid.memberId : null, null);
    }
    case 'LOCAL_NOTIFY': {
      await ryNotify(message.title || '알림', message.body || '');
      return { success: true };
    }
    default: return ryMsg(message.type, message);
  }
}

window.chrome = {
  runtime: {
    sendMessage(message, callback) {
      Promise.resolve(ryHandleMessage(message))
        .then(res => { if (callback) callback(res); })
        .catch(err => { if (callback) callback({ success: false, error: err.message }); });
      return true;
    },
    onMessage: {
      addListener(fn) { if (typeof fn === 'function') ryRuntimeListeners.push(fn); }
    },
    getURL(path) { return path; }
  }
};

// ===== 로그인 (popup의 네이티브 경로 재사용 — CORS 우회) =====
window.CodysseyNative = {
  isNative: true,
  async preCheckLogin(userId) {
    const res = await fetch('/native/preCheckLogin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId })
    });
    const j = await res.json();
    if (!j.success) throw new Error((j.body && j.body.message) || '사전 인증 실패');
    return { status: 200, body: j.body || {} };
  },
  async authenticate(userId, password, from) {
    const res = await fetch('/native/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, password, from: from || '' })
    });
    const j = await res.json();
    if (!j.success) {
      const err = new Error((j.body && j.body.message) || '로그인에 실패했습니다.');
      err.body = j.body;
      throw err;
    }
    return { status: 200, body: j.body || {} };
  },
  async requestExactAlarmPermission() { return { granted: true }; }
};

// ===== G1: 입·퇴실 감지 (background.js 동일 규칙, 상태는 중계 /kv) =====
async function ryProcessGateEvents(memberId, rawData, settings) {
  if (!memberId || !rawData) return;
  const todayStr = getTodayString();
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const yesterdayStr = getTodayString(y);
  const nextDates = snapshotSessionsByDate(rawData, [todayStr, yesterdayStr]);

  const key = `gate_snapshot_${memberId}`;
  const stored = await ryKvGet(key);
  const prevDates = stored && stored.dates ? stored.dates : null;

  const gateOn = settings.gateNotifyEnabled !== false && settings.notificationsEnabled !== false;
  if (prevDates && gateOn) {
    const events = detectGateEvents(prevDates, nextDates);
    for (const event of events) {
      const m = formatGateEventMessage(event, todayStr);
      await ryNotify(m.title, m.body);
    }
  }
  await ryKvSet(key, { dates: nextDates, updatedAt: Date.now() });
}

// ===== E2: 평가 일정 자동 동기 (diff → 알람 등록/해제) =====
async function ryResolveInstCd(settings) {
  if (settings.evalInstCd) return settings.evalInstCd;
  const cached = await ryKvGet('eval_inst_cd');
  if (cached) return String(cached);
  try {
    const res = await ryMsg('MEMBER_INFO_RAW');
    if (res.success && res.info) {
      const found = findInstCd(res.info);
      if (found) {
        await ryKvSet('eval_inst_cd', found);
        return found;
      }
    }
  } catch (e) { /* 무시 */ }
  return null;
}

function ryYmdDot(d) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function ryFormatWhenKo(ms) {
  const d = new Date(ms);
  const wd = ['일', '월', '화', '수', '목', '금', '토'][d.getDay()];
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${wd}) ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function rySyncEvalAlarms(memberId, settingsIn) {
  if (RY.evalInFlight) return RY.evalInFlight;
  RY.evalInFlight = ryDoSyncEvalAlarms(memberId, settingsIn).finally(() => { RY.evalInFlight = null; });
  return RY.evalInFlight;
}

async function ryDoSyncEvalAlarms(memberId, settingsIn) {
  if (!memberId) return { ok: false, reason: 'no_member' };
  const settings = settingsIn || (await ryMsg('GET_SETTINGS')).settings || {};
  if (settings.evalAutoSyncEnabled === false) return { ok: false, reason: 'disabled' };
  const instCd = await ryResolveInstCd(settings);
  if (!instCd) return { ok: false, reason: 'no_instcd' };

  const state = await ryKvGet('eval_sync_state');
  const prevItems = (state && state.memberId === String(memberId) && Array.isArray(state.items))
    ? state.items : [];

  const from = new Date(); from.setDate(from.getDate() - 1);
  const to = new Date(); to.setDate(to.getDate() + 30);
  const res = await ryMsg('EVAL_SCHEDULE', {
    instCd, fromYmd: ryYmdDot(from), toYmd: ryYmdDot(to)
  });
  if (!res.success) return { ok: false, reason: res.error };

  const raw = res.raw || {};
  const reqList = (raw.result && (raw.result.reqList || raw.result.list)) || raw.reqList || [];
  const parsed = parseScheduleRows(reqList);
  const lead = settings.evalLeadMinutes ?? 30;
  const diff = diffEvalItems(prevItems, parsed.items, lead);

  const now = Date.now();
  const nextItems = [];
  let notified = 0;
  const notifOn = settings.notificationsEnabled !== false;

  for (const it of parsed.items) {
    const action = diff.added.some(a => a.key === it.key) ? 'add'
      : diff.changed.some(c => c.key === it.key) ? 'change' : 'keep';
    const existing = prevItems.find(p => p.key === it.key);
    const name = (existing && existing.name) || buildEvalAlarmName('auto_' + it.key);

    if (it.whenMs <= now) {
      if (existing) await ryMsg('CANCEL_ALARM', { names: [name] });
      continue;
    }

    if (action !== 'keep') {
      await ryMsg('CANCEL_ALARM', { names: [name] });
      const triggerAt = Math.max(it.whenMs - lead * 60000, now + 5000);
      await ryMsg('SET_EVAL_ALARM', {
        alarmName: name, title: it.title, whenMs: it.whenMs, leadMinutes: lead, auto: true,
        triggerOverride: triggerAt
      });
      if (notifOn && notified < 3) {
        notified++;
        await ryNotify('📋 평가 일정 감지', `${ryFormatWhenKo(it.whenMs)} — ${it.title} (${lead}분 전 알람 등록)`);
      }
    } else if (existing) {
      nextItems.push(existing);
      continue;
    }
    nextItems.push({ ...it, name, leadMinutes: lead, auto: true });
  }

  for (const rem of diff.removed) {
    if (rem.name) await ryMsg('CANCEL_ALARM', { names: [rem.name] });
    if (notifOn && notified < 3) {
      notified++;
      await ryNotify('📋 평가 일정 변경', `${rem.title || '평가'} 일정이 취소/완료되어 알람을 해제했습니다.`);
    }
  }

  await ryKvSet('eval_sync_state', {
    memberId: String(memberId), instCd, items: nextItems,
    fetchedAt: now, skipped: parsed.skipped, sampleKeys: parsed.sampleKeys || null
  });
  return { ok: true, added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length };
}

// ===== 알람 발화 이벤트 폭 (/events) =====
async function ryPollEvents() {
  try {
    const res = await fetch('/events');
    const j = await res.json();
    for (const ev of (j.events || [])) {
      if (ev.type === 'ALARM_TRIGGERED') {
        const title = ev.alarmType === 'eval' ? '📋 평가 알림' : '⏰ 코디세이 출입 알림';
        await ryNotify(title, ev.label || '알람');
        ryDispatch({ type: 'ALARM_TRIGGERED' });
      }
    }
  } catch (e) { /* 서버 재시작 중 등 — 다음 폭에 재시도 */ }
}
setInterval(ryPollEvents, 8000);
ryPollEvents();

// ===== 최상단 안내 배너 =====
function ryBanner() {
  const el = document.createElement('div');
  el.id = 'relay-banner';
  el.textContent = '🔌 중계 서버 모드 — localhost 파이썬 중계 경유, 실제 코디세이 데이터 (서버 종료 시 동작 멈춤)';
  document.body.prepend(el);
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', ryBanner);
} else {
  ryBanner();
}
