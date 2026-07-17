// ============================================================
// 샌드박스 하네스 — popup.html/popup.js를 브라우저에서 그대로 실행하기 위한
// 모의 백그라운드(background.js/capacitor-adapter 대역).
// - 모든 상태는 메모리 변수 (sandboxed iframe에서 localStorage 차단 대비)
// - shared-attendance.js의 진짜 함수(parseAttendance 등)를 같은 스코프에서 사용
// - 제어 패널로 "서버 상황"을 바꾼 뒤 앱의 ⟳ 버튼으로 반영 확인
// ============================================================

// ===== 모의 서버 상태 =====
const sb = {
  memberId: '1000271067',
  sessionActive: true,     // false면 GET_STATUS가 NOT_LOGGED_IN 반환 (로그인 화면)
  currentlyIn: true,       // 게이트 상 현재 입실 중 여부
  settings: {
    monthlyRequiredHours: 80,
    dailyMaxHours: 12,
    notificationsEnabled: true,
    soundEnabled: true,
    autoRefresh: true,
    refreshInterval: 30,
    keepAliveEnabled: false,
    gateNotifyEnabled: true,
    evalLeadMinutes: 30,
    evalAutoSyncEnabled: true,
    evalInstCd: ''
  },
  alarms: [],              // {name,time,label,endMinutes,type,...}
  timers: {},              // name -> timeout id (30분 이내 알람은 실제 발화 시연)
  notifCount: 0,
  log: []
};

// ===== 픽스처: 출입기록 detail_list 생성 =====
function sbDailyEntry(dateStr, inHm, outHm) {
  const [ih, im] = inHm.split(':').map(Number);
  const [oh, om] = outHm.split(':').map(Number);
  const dur = (oh * 60 + om) - (ih * 60 + im);
  return {
    date: dateStr,
    daily_total_duration: `${String(Math.floor(dur / 60)).padStart(2, '0')}:${String(dur % 60).padStart(2, '0')}:00`,
    sessions: [{ entry_time: inHm + ':00', exit_time: outHm + ':00', is_missing: false, missing_type: null }]
  };
}

function sbBuildDetailList(year, month) {
  const today = new Date();
  const list = [];

  for (let d = 1; d <= 31; d++) {
    const date = new Date(year, month - 1, d);
    if (date.getMonth() !== month - 1) break;
    const dow = date.getDay();
    if (dow === 0 || dow === 6) continue; // 주말 제외
    const dateStr = getTodayString(date);
    const isToday = dateStr === getTodayString();
    const isFuture = date.getTime() > today.getTime() && !isToday;
    if (isFuture) break;

    if (isToday) {
      const entryToday = { date: dateStr, daily_total_duration: '03:30:00', sessions: [
        { entry_time: '09:02:00', exit_time: '12:32:00', is_missing: false, missing_type: null }
      ] };
      if (sb.currentlyIn) {
        // 13:05 재입실 → 퇴실 누락(입실 중) 세션 추가
        entryToday.sessions.push({ entry_time: '13:05:00', exit_time: null, is_missing: true, missing_type: 'exit' });
      }
      list.push(entryToday);
    } else {
      // 평일 09:0x ~ 18:0x (날짜별로 몇 분씩 변형)
      const jitter = d % 7;
      list.push(sbDailyEntry(dateStr,
        `09:0${(jitter % 10)}`,
        `18:${String((10 + jitter * 5) % 60).padStart(2, '0')}`));
    }
  }
  return list;
}

function sbAttendanceData(year, month) {
  return { code: 200, detail_list: sbBuildDetailList(year, month) };
}

// ===== 토스트(모의 알림) =====
function sbToast(title, body) {
  let box = document.getElementById('sb-toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'sb-toasts';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'sb-toast';
  el.textContent = `${title} — ${body}`;
  box.appendChild(el);
  setTimeout(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 400); }, 4500);
}

function sbLog(text) {
  sb.log.push(text);
  if (sb.log.length > 3) sb.log.shift();
  const el = document.getElementById('sb-log');
  if (el) el.textContent = sb.log.join('  ·  ');
}

// ===== 알람 엔진 (30분 이내 알람은 실제 타이머로 발화 시연) =====
function sbArmTimer(entry) {
  const delay = entry.time - Date.now();
  if (delay > 0 && delay <= 30 * 60 * 1000) {
    sb.timers[entry.name] = setTimeout(() => sbFireAlarm(entry.name), delay);
  }
}

function sbCancelTimer(name) {
  if (sb.timers[name]) {
    clearTimeout(sb.timers[name]);
    delete sb.timers[name];
  }
}

function sbFireAlarm(name) {
  const idx = sb.alarms.findIndex(a => a.name === name);
  if (idx < 0) return;
  const entry = sb.alarms[idx];
  sb.alarms.splice(idx, 1);
  sbCancelTimer(name);
  const title = entry.type === 'eval' ? '📋 평가 알림' : '⏰ 코디세이 출입 알림';
  const body = entry.type === 'eval'
    ? `${entry.evalTitle || entry.label} — ${entry.leadMinutes ?? '?'}분 전`
    : (entry.label || '알람');
  sbToast(`[모의 발화] ${title}`, body);
  sbDispatch({ type: 'ALARM_TRIGGERED' }); // popup의 자동 갱신 경로 검증
}

// ===== chrome 런타임 폴리필 =====
const sbRuntimeListeners = [];
function sbDispatch(message) {
  for (const fn of sbRuntimeListeners) {
    try { fn(message, {}, () => {}); } catch (e) { console.warn('[sandbox] listener error', e); }
  }
}

async function sbHandleMessage(message) {
  sbLog(message.type);
  switch (message.type) {
    case 'FETCH_MEMBER_ID': {
      if (!sb.sessionActive) return { success: false, error: 'NOT_LOGGED_IN' };
      return { success: true, memberId: sb.memberId };
    }
    case 'CLEAR_MEMBER_ID':
      return { success: true };

    case 'GET_STATUS': {
      if (!sb.sessionActive) return { success: false, error: 'NOT_LOGGED_IN' };
      const now = new Date();
      const data = sbAttendanceData(now.getFullYear(), now.getMonth() + 1);
      const parsed = parseAttendance(data, now); // 진짜 파서 사용
      if (!parsed.isCurrentlyIn) {
        const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        applyOvernightFromPrevMonth(parsed, sbAttendanceData(prev.getFullYear(), prev.getMonth() + 1));
      }
      const fresh = sb.alarms.filter(a => a && a.time > Date.now());
      sb.alarms = fresh;
      return { success: true, memberId: sb.memberId, parsed, settings: { ...sb.settings }, alarms: fresh };
    }

    case 'FETCH_ATTENDANCE': {
      if (!sb.sessionActive) return { success: false, error: 'NOT_LOGGED_IN' };
      const parsed = parseAttendance(sbAttendanceData(message.year, message.month), new Date(message.year, message.month - 1));
      return { success: true, parsed };
    }

    case 'GET_SETTINGS':
      return { success: true, settings: { ...sb.settings } };

    case 'UPDATE_SETTINGS':
      sb.settings = Object.assign({}, sb.settings, message.settings);
      return { success: true };

    case 'SET_ALARM': {
      const endMinutes = message.endMinutes;
      const type = message.alarmType || 'exit';
      const target = new Date();
      target.setHours(0, 0, 0, 0);
      target.setTime(target.getTime() + endMinutes * 60000);
      if (target.getTime() <= Date.now()) return { success: false, reason: 'past' };
      const name = buildAlarmName(sb.memberId, type, endMinutes);
      sb.alarms = sb.alarms.filter(a => a.name !== name);
      sbCancelTimer(name);
      const entry = {
        name, time: target.getTime(), label: message.label || '알림',
        endMinutes, type, createdAt: Date.now()
      };
      sb.alarms.push(entry);
      sbArmTimer(entry);
      return { success: true, alarmName: name, triggerTime: target.getTime() };
    }

    case 'SET_EVAL_ALARM': {
      const invalid = validateEvalAlarm(Number(message.whenMs), Number(message.leadMinutes));
      if (invalid) return { success: false, reason: invalid };
      const triggerAt = message.whenMs - message.leadMinutes * 60000;
      const name = buildEvalAlarmName(newEvalId());
      const title = (message.title || '').trim() || '평가';
      const entry = {
        name, time: triggerAt, label: `📋 ${title}`, endMinutes: null, type: 'eval',
        evalTitle: title, evalWhen: message.whenMs, leadMinutes: message.leadMinutes,
        createdAt: Date.now()
      };
      sb.alarms = sb.alarms.filter(a => a.name !== name);
      sb.alarms.push(entry);
      sbArmTimer(entry);
      return { success: true, alarmName: name, triggerTime: triggerAt };
    }

    case 'GET_ALARMS': {
      const fresh = sb.alarms.filter(a => a && a.time > Date.now());
      sb.alarms = fresh;
      return { success: true, alarms: fresh };
    }

    case 'CANCEL_ALARM': {
      if (message.alarmName) {
        for (const n of equivalentAlarmNames(message.alarmName)) sbCancelTimer(n);
        sb.alarms = sb.alarms.filter(a => !equivalentAlarmNames(message.alarmName).includes(a.name));
      } else {
        const type = message.alarmType || 'exit';
        const found = sb.alarms.filter(a => a.endMinutes === message.endMinutes && (a.type || 'exit') === type);
        for (const f of found) sbCancelTimer(f.name);
        sb.alarms = sb.alarms.filter(a => !(a.endMinutes === message.endMinutes && (a.type || 'exit') === type));
      }
      return { success: true };
    }

    case 'SYNC_EVAL_ALARMS':
      return { success: true, result: { ok: true, added: 0, changed: 0, removed: 0, items: 0 } };

    case 'LOCAL_NOTIFY':
      sbToast(message.title || '알림', message.body || '');
      return { success: true };

    case 'LOGOUT':
      sb.sessionActive = false;
      for (const name of Object.keys(sb.timers)) sbCancelTimer(name);
      sb.alarms = [];
      return { success: true };

    default:
      return { success: false, error: 'Unknown message type (sandbox)' };
  }
}

window.chrome = {
  runtime: {
    sendMessage(message, callback) {
      Promise.resolve(sbHandleMessage(message))
        .then(res => { if (callback) callback(res); })
        .catch(err => { if (callback) callback({ success: false, error: err.message }); });
      return true;
    },
    onMessage: {
      addListener(fn) { if (typeof fn === 'function') sbRuntimeListeners.push(fn); }
    },
    getURL(path) { return path; }
  }
};

// 로그인은 codyssey.kr 네트워크 fetch를 사용 — 샌드박스용으로 해당 호출만 모의 응답
const sbNativeFetch = window.fetch ? window.fetch.bind(window) : null;
function sbFakeJsonResponse(obj, url) {
  return {
    ok: true,
    status: 200,
    url: url || 'https://api.ams.codyssey.kr/',
    json: () => Promise.resolve(obj),
    text: () => Promise.resolve(JSON.stringify(obj)),
    headers: { get: () => 'application/json' }
  };
}
window.fetch = function (url, options) {
  const u = String(url);
  if (u.includes('api.ams.codyssey.kr/rest/login/pre-check')) {
    sbLog('모의 pre-check');
    return Promise.resolve(sbFakeJsonResponse({ code: 200, result: { from: '' } }, u));
  }
  if (u.includes('api.ams.codyssey.kr/authenticate')) {
    sbLog('모의 authenticate');
    return Promise.resolve(sbFakeJsonResponse({ code: 200, result: { ok: true } }, 'https://codyssey.kr/main'));
  }
  if (u.includes('codyssey.kr')) {
    sbLog('모의 ' + u.split('codyssey.kr')[1].slice(0, 40));
    return Promise.resolve(sbFakeJsonResponse({ code: 200, result: {} }, u));
  }
  if (sbNativeFetch) return sbNativeFetch(url, options);
  return Promise.reject(new Error('network disabled (sandbox)'));
};

// 알림 권한 스텁 (iframe 샌드박스에서 Notification 생성 차단 대비)
try {
  Object.defineProperty(window, 'Notification', {
    value: {
      permission: 'granted',
      requestPermission: () => Promise.resolve('granted')
    },
    configurable: true
  });
} catch (e) { /* 실패필요 없음 */ }

// ===== 제어 패널 =====
function sbInsertEvalSample() {
  const lead = sb.settings.evalLeadMinutes ?? 30;
  const whenMs = Date.now() + 2 * 60 * 60000; // 2시간 뒤 평가
  const name = buildEvalAlarmName('auto_demo1');
  sb.alarms = sb.alarms.filter(a => a.name !== name);
  const entry = {
    name, time: whenMs - lead * 60000, label: '📋 알고리즘 중간 평가 (피평가자: 김코디)',
    endMinutes: null, type: 'eval', evalTitle: '알고리즘 중간 평가 (피평가자: 김코디)',
    evalWhen: whenMs, leadMinutes: lead, auto: true, createdAt: Date.now()
  };
  sb.alarms.push(entry);
  sbArmTimer(entry);
  sbToast('📋 평가 일정 감지 (모의)', `${entry.evalTitle} — ${lead}분 전 알람 등록`);
}

function sbInsertDemoAlarms() {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const mk = (minutes, type, label) => {
    const name = buildAlarmName(sb.memberId, type, minutes);
    sb.alarms = sb.alarms.filter(a => a.name !== name);
    sbCancelTimer(name);
    sb.alarms.push({ name, time: base.getTime() + minutes * 60000, label, endMinutes: minutes, type, createdAt: Date.now() });
  };
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  mk(nowMin + 45, 'exit', '퇴실 알림 (데모)');
  mk(nowMin + 120, 'goal', '목표 달성 알림 (데모)');
  sbToast('데모 알람', '퇴실 45분 뒤 / 목표 120분 뒤 알람을 채웠습니다');
}

function sbFireEarliestAlarm() {
  if (!sb.alarms.length) {
    sbToast('알람 없음', '먼저 알람을 추가해주세요');
    return;
  }
  const earliest = sb.alarms.slice().sort((a, b) => a.time - b.time)[0];
  sbFireAlarm(earliest.name);
}

function sbSetupPanel() {
  const panel = document.createElement('div');
  panel.id = 'sb-panel';
  panel.innerHTML = `
    <div class="sb-title">🧪 샌드박스 모드 (모의 데이터 — 실제 서버/백그라운드 아님)</div>
    <div class="sb-row" id="sb-buttons">
      <button data-sb="toggle-in">입실⇄퇴실 전환</button>
      <button data-sb="demo-alarms">데모 알람 2건 채우기</button>
      <button data-sb="eval-sample">자동 평가 감지 시뮬</button>
      <button data-sb="fire-alarm">가장 빠른 알람 즉시 발화</button>
      <button data-sb="expire">세션 만료 시뮬</button>
      <button data-sb="restore">세션 복원</button>
    </div>
    <div class="sb-log" id="sb-log"></div>
    <div class="sb-hint">상황을 바꾼 뒤 앱 내 ⟳(새로고침) 버튼으로 반영 확인 · 토글 자동 새로고침은 백그라운드 전용 로직이라 여기선 동작 안 함</div>
  `;
  document.body.prepend(panel);

  panel.addEventListener('click', (e) => {
    const key = e.target && e.target.dataset ? e.target.dataset.sb : null;
    if (!key) return;
    if (key === 'toggle-in') {
      sb.currentlyIn = !sb.currentlyIn;
      sbToast('모의 서버', sb.currentlyIn ? '입실 상태로 전환 (⟳로 반영)' : '퇴실 상태로 전환 (⟳로 반영)');
    } else if (key === 'demo-alarms') {
      sbInsertDemoAlarms();
    } else if (key === 'eval-sample') {
      sbInsertEvalSample();
    } else if (key === 'fire-alarm') {
      sbFireEarliestAlarm();
    } else if (key === 'expire') {
      sb.sessionActive = false;
      sbToast('모의 서버', '세션 만료 — ⟳ 누륾면 로그인 화면으로');
    } else if (key === 'restore') {
      sb.sessionActive = true;
      sbToast('모의 서버', '세션 복원 — 로그인 화면에서 로그인하거나 ⟳');
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', sbSetupPanel);
} else {
  sbSetupPanel();
}
