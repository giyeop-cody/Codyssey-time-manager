// ============================================================
// 중계 서버 + 실측 평가 스키마 종단검증 (스텁 코디세이 서버 기반)
// 흐름: [이 스크립트] ─브라우저 대용(vm: shared-attendance + relay_harness)─>
//       relay_server.py(서브프로세스, env로 스텁 주소 주입) ─> Node 스텁 코디세이
// 검증: 로그인 → SYNC_EVAL_ALARMS(실측 스키마 reqList) → 알람 등록/재등록/해제,
//       nonEv·skipped·sampleKeys 진단값, EVAL_SCHEDULE rows 축약 필드
// 실행: node sandbox/test_relay_e2e.mjs  (또는 npm run test:relay)
// ============================================================
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(ROOT, '..');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); }
}

// ---------- 미래 날짜 도우미 ----------
function ymdDot(d) {
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}
function inDays(n, h, m) {
  const d = new Date(); d.setDate(d.getDate() + n); d.setHours(h, m, 0, 0); return d;
}

// ---------- 스텁 코디세이 (실측 스키마 응답) ----------
// 시나리오를 바꿔가며 동기화 재실행 검증
const d1 = inDays(3, 14, 0);  // EV R(피평가자) — 3일 뒤 14:00
const d2 = inDays(4, 10, 30); // EV A(평가자) — 4일 뒤 10:30
const d3 = inDays(3, 9, 0);   // AM / EXAM 등
let scenario = 'A';

function evalRows() {
  if (scenario === 'A') {
    return [
      { scdlGubunCd: 'AM', bgngYmd: ymdDot(d3), bgngTm: '09:00', title: '오전 점호' },
      { scdlGubunCd: 'EXAM', bgngYmd: ymdDot(d3), bgngTm: '15:00', title: '1차 시험' },
      { scdlGubunCd: 'EV', fixedCd: '00002', bgngYmd: ymdDot(d1), bgngTm: '14:00',
        title: '알고리즘 과제 평가', scdlReqUsr: '김코디', reqDetail: 'R||35||P||7||3', mtlEvlSn: '35' },
      { scdlGubunCd: 'EV', fixedCd: '00001', bgngYmd: ymdDot(d2), bgngTm: '10:30',
        scdlGubunNm: '동료평가', scdlReqUsr: '박수련', reqDetail: 'A||42||P||7||3||1' },
      { scdlGubunCd: 'EV', fixedCd: '00004', bgngYmd: ymdDot(d2), bgngTm: '16:00', title: '거절된 평가' }, // 거절 → 제외
      { scdlGubunCd: 'EV', fixedCd: '00006', bgngYmd: ymdDot(d2), bgngTm: '17:00', title: '완료된 평가' }, // 완료 → 제외
      { scdlGubunCd: 'EV', fixedCd: '00002', bgngYmd: '', bgngTm: '', title: '시간 미정 평가' }            // 파싱 불가 → skipped
    ];
  }
  // 시나리오 B: 35번 16:00으로 변경, 42번 취소(00005)
  const d1b = inDays(3, 16, 0);
  return [
    { scdlGubunCd: 'EV', fixedCd: '00003', bgngYmd: ymdDot(d1b), bgngTm: '16:00',
      title: '알고리즘 과제 평가', scdlReqUsr: '김코디', reqDetail: 'R||35||P||7||3', mtlEvlSn: '35' },
    { scdlGubunCd: 'EV', fixedCd: '00005', bgngYmd: ymdDot(d2), bgngTm: '10:30',
      scdlGubunNm: '동료평가', scdlReqUsr: '박수련', reqDetail: 'A||42||P||7||3||1' }
  ];
}

// ---------- E3 알림함 시나리오 (사용자 제공 실측 스키마) ----------
// 900001: 42번 평가(d2 10:30)와 같은 시각 → 스케줄 채널과 dedup (알림함 알람 생기면 안 됨)
// 900002: 별도 미래 시각 → 신규 알림 + N분 전 알람 등록
// 그 외: 평가종료(00020)·포인트(00057)는 무시
function ymdHms(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:00`;
}
const dn1 = inDays(4, 10, 30); // 42번과 동일 시각
const dn2 = inDays(6, 15, 0);  // 새로운 평가 시각
function noticeRow(sn, titl, cn, sysCd) {
  return { pstartSn: sn, pstartTitlNm: titl, pstartCn: cn, sysDivCd: sysCd,
    ntcDivCd: '00101', readYn: 'N', instCd: '0000373', mbrId: 'tester01',
    regDt: '2026-07-14 11:45' };
}
function noticeBody(whenD, requester) {
  return '안녕하세요.&lt;br/&gt;동료평가 일정이 지정되어 아래와 같이 안내 드립니다.&lt;br/&gt;'
    + '&lt;평가일정&gt;&lt;br/&gt;요청자 : ' + requester + '(woo@naver.com)&lt;br/&gt;'
    + 'Discord ID : wilderif&lt;br/&gt;평가예정일시 : ' + ymdHms(whenD) + '&lt;br/&gt;'
    + '프로젝트명 : AI/SW 기초 (AI/SW Basic)&lt;br/&gt;학습과정명 : 클라우드와 AI API&lt;br/&gt;'
    + '단위문제명 : AI 기반 Git 커밋 자동 생성기';
}
function noticeRows() {
  return [
    noticeRow(900001, '동료평가자로 지정 되었습니다.', noticeBody(dn1, '김우종'), '00017'),
    noticeRow(900002, '동료평가자로 지정 되었습니다.', noticeBody(dn2, '이수영'), '00017'),
    noticeRow(900003, 'AI/SW 기초 과정이 평가종료 되었습니다.',
      '...평가종료일시 :2026-07-14 13:45...', '00020'),
    noticeRow(900004, '포인트 획득 알림', '100 포인트를 획득하셨습니다!', '00057')
  ];
}

const stub = createServer((req, res) => {
  const u = new URL(req.url, 'http://stub');
  const send = (obj, extraHeaders = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(200, { 'Content-Type': 'application/json', ...extraHeaders });
    res.end(body);
  };
  if (req.method === 'POST' && u.pathname === '/rest/login/pre-check') {
    return send({ result: { from: 'stubform' } });
  }
  if (req.method === 'POST' && u.pathname === '/authenticate') {
    return send({ result: 'ok' }, { 'Set-Cookie': 'JSESSIONID=stub-session; Path=/' });
  }
  if (u.pathname === '/rest/user/info/detail') {
    return send({ result: { mbrId: 'tester01', mbrNm: '테스터', member: { instCd: '0000373' } } });
  }
  if (u.pathname === '/rest/secom/detail') {
    return send({ detail_list: [] });
  }
  if (u.pathname === '/schedule/scheduleAllList/') {
    return send({ result: { reqList: evalRows(), academicList: [], timeList: [] } });
  }
  if (u.pathname === '/alarm/alarmList/list') {
    return send({ result: { alarmCount: noticeRows().length, list: noticeRows(),
      paginator: { total: noticeRows().length, currentPage: 1, totalPage: 1, pagePerRows: 30 } } });
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'stub 404', path: u.pathname }));
});

// ---------- 자유 포트 2개 확보 ----------
function freePort() {
  return new Promise(resolve => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function main() {
  const stubPort = await freePort();
  const relayPort = await freePort();
  await new Promise(r => stub.listen(stubPort, '127.0.0.1', r));
  const stubBase = `http://127.0.0.1:${stubPort}`;
  console.log(`[e2e] 스텁 코디세이: ${stubBase}`);

  // ---------- 중계 서버 기동 (스텁 주소 env 주입, kv/쿠키 초기화로 격리) ----------
  for (const f of ['relay_kv.json', 'relay_cookies.txt']) {
    try { fs.unlinkSync(path.join(ROOT, f)); } catch { /* 없으면 무시 */ }
  }
  const relay = spawn('python3', [path.join(ROOT, 'relay_server.py'), '--port', String(relayPort)], {
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      CODYSSEY_AMS_BASE: stubBase,
      CODYSSEY_USR_BASE: stubBase,
      CODYSSEY_EVAL_BASE: stubBase
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  relay.stderr.on('data', d => process.stderr.write(`[relay:err] ${d}`));
  if (process.env.RELAY_DEBUG) relay.stdout.on('data', d => process.stdout.write(`[relay] ${d}`));
  const relayBase = `http://127.0.0.1:${relayPort}`;

  const cleanup = (code) => { relay.kill(); stub.close(); process.exit(code); };
  process.on('SIGINT', () => cleanup(130));

  // 중계 서버 기동 대기
  let up = false;
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(`${relayBase}/`); if (r.ok) { up = true; break; } } catch { /* 재시도 */ }
    await new Promise(r => setTimeout(r, 300));
  }
  if (!up) { console.error('[e2e] 중계 서버 기동 실패'); cleanup(2); }
  console.log(`[e2e] 중계 서버: ${relayBase}`);

  // ---------- 브라우저 대용: shared-attendance + relay_harness 를 vm에서 실행 ----------
  const sharedSrc = fs.readFileSync(path.join(REPO, 'web/js/shared-attendance.js'), 'utf8')
    .replace(/^export /gm, '');
  const harnessSrc = fs.readFileSync(path.join(ROOT, 'relay_harness.js'), 'utf8');

  const sandboxCtx = {
    console,
    setTimeout, clearTimeout,
    setInterval: () => 0, clearInterval: () => {},
    fetch: (p, o) => fetch(p.startsWith('http') ? p : relayBase + p, o),
    document: {
      readyState: 'complete',
      getElementById: () => null,
      addEventListener: () => {},
      createElement: () => ({ id: '', className: '', textContent: '',
        classList: { add: () => {}, remove: () => {} }, remove: () => {}, appendChild: () => {} }),
      body: { appendChild: () => {}, prepend: () => {} }
    }
  };
  sandboxCtx.window = sandboxCtx;
  vm.createContext(sandboxCtx);
  vm.runInContext(sharedSrc + '\n;\n' + harnessSrc, sandboxCtx, { filename: 'harness.bundle.js' });

  const chrome = sandboxCtx.chrome;
  if (!chrome?.runtime?.sendMessage) { console.error('[e2e] 하네스 로드 실패'); cleanup(2); }
  const send = (message) => new Promise(resolve => chrome.runtime.sendMessage(message, resolve));

  // ---------- 1) 로그인 (네이티브 경로 → 스텁) ----------
  console.log('\n[1] 로그인');
  await sandboxCtx.CodysseyNative.preCheckLogin('tester01');
  await sandboxCtx.CodysseyNative.authenticate('tester01', 'pw', 'stubform');
  const mid = await send({ type: 'FETCH_MEMBER_ID' });
  check('로그인 후 memberId=tester01', mid.success && mid.memberId === 'tester01', mid);

  // ---------- 2) EVAL_SCHEDULE 축약 필드 (샌드박스 실데이터 확인용) ----------
  console.log('\n[2] EVAL_SCHEDULE 응답');
  const ev = await send({ type: 'EVAL_SCHEDULE', instCd: '0000373',
    fromYmd: ymdDot(new Date()), toYmd: ymdDot(inDays(30, 0, 0)) });
  check('EVAL_SCHEDULE 성공', ev.success === true, ev.error);
  check('rows 축약 포함(필드명 검증용)', Array.isArray(ev.rows) && ev.rows.some(r => r.scdlGubunCd === 'EV' && r.mtlEvlSn === '35'), ev.rows);
  check('host가 스텁(=USR 게이트웨이 경유)', typeof ev.host === 'string');

  // ---------- 3) 평가 일정 자동 동기 (1차) ----------
  console.log('\n[3] SYNC_EVAL_ALARMS — 시나리오 A (EV 2건 유효)');
  const s1 = await send({ type: 'SYNC_EVAL_ALARMS' });
  check('동기화 성공, 추가 2건', s1.ok && s1.added === 2, s1);

  const kvGet = async (key) => (await (await fetch(`${relayBase}/kv?key=${encodeURIComponent(key)}`)).json()).value;
  const alarms1 = await kvGet('alarms');
  const a35 = (alarms1 || []).find(a => a.name === 'codyssey_eval_auto_35');
  const a42 = (alarms1 || []).find(a => a.name === 'codyssey_eval_auto_42');
  check('알람 codyssey_eval_auto_35 등록', !!a35, (alarms1 || []).map(a => a.name));
  check('알람 codyssey_eval_auto_42 등록', !!a42);
  check('35번 발화 시각 = 시작 30분 전', a35 && a35.time === d1.getTime() - 30 * 60000, a35 && a35.time);
  check('42번 발화 시각 = 시작 30분 전', a42 && a42.time === d2.getTime() - 30 * 60000, a42 && a42.time);
  check('35번 제목 = title 우선 + 피평가자 라벨', a35 && a35.evalTitle === '알고리즘 과제 평가 (피평가자: 김코디)', a35 && a35.evalTitle);
  check('42번 제목 = scdlGubunNm 폴곤 + 평가자 라벨', a42 && a42.evalTitle === '동료평가 (평가자: 박수련)', a42 && a42.evalTitle);
  check('출입(비평가) 알람이 생기지 않음', (alarms1 || []).every(a => a.type === 'eval'), (alarms1 || []).map(a => a.type));

  const st1 = await kvGet('eval_sync_state');
  check('상태 nonEv=2 (AM/EXAM 제외)', st1 && st1.nonEv === 2, st1 && st1.nonEv);
  check('상태 skipped=1 (시간 미정 행)', st1 && st1.skipped === 1, st1 && st1.skipped);
  check('상태 sampleKeys에 scdlGubunCd', st1 && Array.isArray(st1.sampleKeys) && st1.sampleKeys.includes('scdlGubunCd'), st1 && st1.sampleKeys);
  check('상태 instCd 자동 추출 0000373', st1 && st1.instCd === '0000373', st1 && st1.instCd);
  check('상태 items 2건 저장', st1 && Array.isArray(st1.items) && st1.items.length === 2);

  // ---------- 4) 평가 일정 자동 동기 (2차 — 변경·취소) ----------
  console.log('\n[4] SYNC_EVAL_ALARMS — 시나리오 B (35 회 16:00 변경, 42 취소)');
  scenario = 'B';
  const s2 = await send({ type: 'SYNC_EVAL_ALARMS' });
  check('재동기화 성공, 변경 1건·해제 1건', s2.ok && s2.changed === 1 && s2.removed === 1, s2);
  const alarms2 = await kvGet('alarms');
  const b35 = (alarms2 || []).find(a => a.name === 'codyssey_eval_auto_35');
  const b42 = (alarms2 || []).find(a => a.name === 'codyssey_eval_auto_42');
  const d1b = inDays(3, 16, 0);
  check('35번 새 시각으로 재등록', b35 && b35.time === d1b.getTime() - 30 * 60000, b35 && b35.time);
  check('42번 알람 해제됨', !b42, (alarms2 || []).map(a => a.name));

  // ---------- 5) E3 알림함 채널 (신규 감지 캐시 + dedup + N분 전 알람) ----------
  console.log('\n[5] E3 알림함 채널 — 신규 900002 등록, 900001 스케줄 dedup');
  const seen1 = await kvGet('eval_notice_seen');
  check('seen 캐시에 900001/900002 기록',
    !!(seen1 && seen1.ids && seen1.ids['900001'] && seen1.ids['900002']), seen1 && seen1.ids);
  check('종료(900003)/포인트(900004)는 seen 미기록',
    !(seen1.ids['900003'] || seen1.ids['900004']));
  const alarms3 = await kvGet('alarms');
  const n2 = (alarms3 || []).filter(a => a.name === 'codyssey_eval_auto_notice_900002');
  check('900002 알람 1건 등록', n2.length === 1, (alarms3 || []).map(a => a.name));
  check('900002 발화 시각 = 시작 30분 전', n2[0] && n2[0].time === dn2.getTime() - 30 * 60000, n2[0] && n2[0].time);
  check('900002 제목 = 프로젝트명 + 평가자/요청자 라벨',
    n2[0] && n2[0].evalTitle === 'AI/SW 기초 (AI/SW Basic) (평가자 · 요청자: 이수영)', n2[0] && n2[0].evalTitle);
  check('900001 알람 미등록 (스케줄 채널이 42번으로 커버)',
    !(alarms3 || []).some(a => a.name === 'codyssey_eval_auto_notice_900001'));

  console.log('\n[6] 재동기화 — seen 캐시로 알람/알림 중복 없음');
  const s3 = await send({ type: 'SYNC_EVAL_ALARMS' });
  const alarms4 = await kvGet('alarms');
  check('재동기화 성공', s3.ok === true, s3);
  check('900002 알람이 여전히 1걸뿐',
    (alarms4 || []).filter(a => a.name === 'codyssey_eval_auto_notice_900002').length === 1);
  check('알림함 신규 0건 (두 번째는 조용)',
    (s3.noticeFresh === 0), s3.noticeFresh);

  // ---------- 결과 ----------
  console.log(`\n[e2e] PASS ${passed} / FAIL ${failed}`);
  cleanup(failed ? 1 : 0);
}

main().catch(e => { console.error('[e2e] 오류:', e); process.exit(2); });
