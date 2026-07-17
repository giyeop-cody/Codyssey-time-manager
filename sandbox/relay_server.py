#!/usr/bin/env python3
# ============================================================
# 코디세이 출입 현황 알리미 — 로컬 중계 서버 (개발/테스트용)
#
# 팝업(web/popup.html + popup.js)을 일반 브라우저 탭에서 "진짜 백엔드"에 붙여 실행.
# 브라우저 탭 ──▶ http://localhost:8787 (이 서버) ──▶ 코디세이 실서버
#
# 역할:
#  1) 로그인 중계 (api.ams.codyssey.kr) + 세션 쿠키 보관 (코드에 비밀번호 미저장)
#  2) 출입/멤버/평가 일정 API 프록시 (쿠키 포함, 5분 캐시 — 익스텐션과 동일 규칙)
#  3) chrome.runtime 메시지 라우팅 (background.js의 축소판: 알람 저장/발화, 설정, 상태 조회)
#  4) 알람 발화 스케줄러 (시각이 되면 /events 폴로 팝업에 ALARM_TRIGGERED 전달)
#  5) 단일 파일 대시보드 서빙 (web/ 소스를 읽어 인라인 변환 — Node 불필요, 파이썬만 필요)
#
# 사용:
#   python sandbox/relay_server.py              # http://localhost:8787 열기
#   python sandbox/relay_server.py --save-session   # 재시작필요핻 캐시 세션 쿠키 유지
#
# ※ 개인 로컬 전용. 0.0.0.0 바인딩/외부 공유 금지 (세션 쿠키가 곧 계정 권한).
# ※ 생성되는 relay_kv.json / relay_cookies.txt 는 자격 정보 포함 → 커밋 금지 (.gitignore 등록)
# ============================================================

import argparse
import http.cookiejar
import http.server
import json
import os
import re
import threading
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
WEB_DIR = os.path.join(ROOT, '..', 'web')
KV_FILE = os.path.join(ROOT, 'relay_kv.json')
SESSION_FILE = os.path.join(ROOT, 'relay_cookies.txt')

# env 오버라이드는 스텁 서버 종단검증(test_relay_e2e.mjs)용 — 실사용 시 건드리지 않음
AMS_BASE = os.environ.get('CODYSSEY_AMS_BASE') or 'https://api.ams.codyssey.kr'
USR_BASE = os.environ.get('CODYSSEY_USR_BASE') or 'https://api.usr.codyssey.kr'
# 평가 API 호스트 — 2026-07-17 usr 프론트엔드 번들 실측으로 확정 (usr SPA가
# baseURL=https://api.usr.codyssey.kr/ 로 'schedule/scheduleAllList/' 호출).
# 레거시 명세(api.codyssey.kr)는 현 배포에서 404, codyssey.kr은 정적 SPA 호스트.
LMS_BASE = os.environ.get('CODYSSEY_EVAL_BASE') or USR_BASE

CACHE_TTL_SEC = 300  # 5분 (익스텐션 background.js와 동일)

LOCK = threading.RLock()
KV = {}
CACHE = {}
EVENTS = []
JAR = None
SAVE_SESSION = False


# ---------- KV 저장소 (settings/alarms/gate/eval 상태) ----------
def kv_load():
    global KV
    try:
        with open(KV_FILE, 'r', encoding='utf-8') as f:
            KV = json.load(f)
    except Exception:
        KV = {}


def kv_save():
    try:
        tmp = KV_FILE + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(KV, f, ensure_ascii=False)
        os.replace(tmp, KV_FILE)
    except Exception as e:
        print('[relay] KV 저장 실패:', e)


def kv_get(key, default=None):
    with LOCK:
        return KV.get(key, default)


def kv_set(key, value):
    with LOCK:
        KV[key] = value
        kv_save()


def kv_del(*keys):
    with LOCK:
        for k in keys:
            KV.pop(k, None)
        kv_save()


# ---------- HTTP (세션 쿠키 포함) ----------
class AuthRequired(Exception):
    pass


def init_jar(save_session):
    global JAR
    if save_session:
        JAR = http.cookiejar.MozillaCookieJar(SESSION_FILE)
        try:
            JAR.load(ignore_discard=True, ignore_expires=True)
        except Exception:
            pass
    else:
        JAR = http.cookiejar.CookieJar()


def opener():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(JAR))


def jar_save():
    if SAVE_SESSION and JAR is not None:
        try:
            JAR.save(ignore_discard=True, ignore_expires=True)
        except Exception:
            pass


def http_request(url, method='GET', data=None, headers=None, timeout=15):
    """(status, final_url, text) 반환. 세션 만료 리다이렉트는 AuthRequired."""
    req = urllib.request.Request(url, method=method, data=data)
    req.add_header('Accept', 'application/json')
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        res = opener().open(req, timeout=timeout)
        status = res.status
        final_url = res.geturl()
        text = res.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as e:
        status = e.code
        final_url = e.geturl() or url
        try:
            text = e.read().decode('utf-8', 'replace')
        except Exception:
            text = ''
    except Exception as e:
        raise ConnectionError(str(e))
    jar_save()
    # 세션 만료 감지 (background.js의 AUTH_REQUIRED 판정과 유사)
    # ※ 'login'이 URL에 포함된지 "리다이렉트가 실제로 일어났을 때"만 판정한다 —
    #   /rest/login/pre-check 처럼 원래 login이 들어간 정상 호출을 오인하지 않도록
    redirected = (final_url or url) != url
    if redirected and 'login' in (final_url or '').lower():
        raise AuthRequired()
    if status in (401, 403):
        raise AuthRequired()
    return status, final_url, text


def json_or_none(text):
    try:
        return json.loads(text)
    except Exception:
        return None


# ---------- 코디세이 API ----------
def fetch_member_info():
    _, _, text = http_request(f'{USR_BASE}/rest/user/info/detail')
    data = json_or_none(text)
    if not isinstance(data, dict):
        raise AuthRequired()
    return data


def extract_member_id(info):
    result = (info or {}).get('result') or (info or {}).get('data') or info or {}
    return (result.get('mbrId') or result.get('memberId') or result.get('userId')
            or result.get('id') or result.get('no') or None)


def ensure_member_id():
    mid = kv_get('member_id')
    if mid:
        return mid
    info = fetch_member_info()
    mid = extract_member_id(info)
    if mid:
        kv_set('member_id', str(mid))
    return str(mid) if mid else None


def fetch_attendance(member_id, year, month, force=False):
    key = f'att_{member_id}_{year}_{month}'
    with LOCK:
        cached = CACHE.get(key)
        if not force and cached and time.time() - cached[0] < CACHE_TTL_SEC:
            return cached[1]
    url = (f'{USR_BASE}/rest/secom/detail?mbrId={member_id}'
           f'&year={year}&month={int(month):02d}')
    _, _, text = http_request(url)
    data = json_or_none(text)
    if not isinstance(data, dict) or 'detail_list' not in data:
        raise AuthRequired()  # 로그인 페이지 HTML 등
    with LOCK:
        CACHE[key] = (time.time(), data)
    return data


def fetch_eval_schedule(member_id, inst_cd, from_ymd, to_ymd):
    qs = urllib.parse.urlencode({
        'mbrId': member_id, 'instCd': inst_cd,
        'bgngYmd': from_ymd, 'endYmd': to_ymd, 'scheduleType': 'request'
    })
    # 실측(usr 번들): axios post(url, null, {params}) — 본문 없이 쿼리스트링만 전송
    _, _, text = http_request(
        f'{LMS_BASE}/schedule/scheduleAllList/?{qs}', method='POST')
    data = json_or_none(text)
    if not isinstance(data, dict):
        raise AuthRequired()
    return data


def fetch_eval_alarm_list(page=1, page_per_rows=30):
    # E3(15차): 알림함 목록 — 실측 페이로드 {"page":N,"pagePerRows":M} (사용자 제공 명세)
    body = json.dumps({'page': page, 'pagePerRows': page_per_rows}).encode('utf-8')
    _, _, text = http_request(
        f'{LMS_BASE}/alarm/alarmList/list', method='POST', data=body,
        headers={'Content-Type': 'application/json'})
    data = json_or_none(text)
    if not isinstance(data, dict):
        raise AuthRequired()
    return data


def summarize_eval_rows(raw):
    """샌드박스 실데이터 확인용 — reqList 각 행의 핵심 필드만 축약."""
    rows = (((raw or {}).get('result') or {}).get('reqList'))
    if not isinstance(rows, list):
        return None
    keep = ('scdlGubunCd', 'fixedCd', 'bgngYmd', 'bgngTm', 'title',
            'scdlGubunNm', 'reqDetail', 'scdlReqUsr', 'mtlEvlSn')
    return [{k: r.get(k) for k in keep if k in r} for r in rows[:50]]


# ---------- 알람 엔진 ----------
def get_alarms():
    alarms = kv_get('alarms', [])
    now = time.time() * 1000
    fresh = [a for a in alarms if a.get('time', 0) > now]
    if len(fresh) != len(alarms):
        kv_set('alarms', fresh)  # K8 자가정비와 동일
    return fresh


def upsert_alarm(entry):
    alarms = [a for a in get_alarms() if a.get('name') != entry['name']]
    alarms.append(entry)
    kv_set('alarms', alarms)


def cancel_alarms(names):
    names = set(names or [])
    keep = [a for a in get_alarms() if a.get('name') not in names]
    kv_set('alarms', keep)


def alarm_loop():
    while True:
        try:
            now = time.time() * 1000
            # ※ get_alarms()(K8 자가정비)는 시간 지난 알람을 조용히 삭제하므로
            #   발화 판정은 원본 저장 목록에서 직접 해야 한다
            alarms = kv_get('alarms', [])
            fired = [a for a in alarms if a.get('time', 0) <= now]
            if fired:
                cancel_alarms([a['name'] for a in fired])
                with LOCK:
                    for a in fired:
                        EVENTS.append({'type': 'ALARM_TRIGGERED',
                                       'label': a.get('label', '알람'),
                                       'alarmType': a.get('type', 'exit'),
                                       'at': now})
                    del EVENTS[:-100]
        except Exception as e:
            print('[relay] 알람 루프 오류:', e)
        time.sleep(3)


# ---------- 단일 파일 페이지 조립 (build-sandbox.js의 파이썬판) ----------
def read(rel):
    with open(os.path.join(WEB_DIR, rel), 'r', encoding='utf-8') as f:
        return f.read()


def build_page():
    html = read('popup.html')
    css = read('css/popup.css')
    shared = re.sub(r'^export ', '', read('js/shared-attendance.js'), flags=re.M)
    popup = re.sub(r"^import \{[\s\S]*?\} from '\./shared-attendance\.js';\s*", '',
                   read('js/popup.js'), flags=re.M)
    with open(os.path.join(ROOT, 'relay_harness.js'), 'r', encoding='utf-8') as f:
        harness = f.read()

    html = html.replace('<title>코디세이 출입 현황 알리미</title>',
                        '<title>[중계] 코디세이 출입 현황 알리미</title>')
    html = html.replace('<link rel="stylesheet" href="./css/popup.css">',
                        '<style>\n' + css + RELAY_CSS + '\n</style>')
    html = re.sub(r'<script type="module" src="\./js/capacitor-adapter\.js"></script>\s*',
                  '', html)
    # ※ 치환값에 \d 등 이스케이프가 많아 re.sub의 그룹 참조(\1…) 해석을 피하려고
    #   반드시 함수형 치환 사용 (문자열 치환 시 bad escape 오류 발생)
    html = re.sub(r'<script type="module" src="\./js/popup\.js"></script>\s*',
                  lambda m: ('<script type="module">\n' + shared + '\n\n' + harness
                             + '\n\n' + popup + '\n</script>\n'),
                  html)
    return html


RELAY_CSS = '''
#relay-banner{background:#0f3d33;color:#b7f5e6;padding:8px 12px;font:12px sans-serif;border-bottom:2px solid #4ec9b0}
#relay-toasts{position:fixed;right:8px;bottom:8px;z-index:99999;display:flex;flex-direction:column;gap:6px}
.relay-toast{background:#0f172a;color:#f1f5f9;border:1px solid #4ec9b0;border-radius:8px;padding:8px 10px;font:12px sans-serif;max-width:300px;opacity:0;transform:translateY(6px);transition:.3s;box-shadow:0 4px 12px rgba(0,0,0,.3)}
.relay-toast.show{opacity:1;transform:none}
'''


# ---------- 메시지 라우팅 ----------
def json_response(handler, obj, status=200):
    body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(body)))
    handler.send_header('Cache-Control', 'no-store')
    handler.end_headers()
    handler.wfile.write(body)


def handle_msg(msg):
    t = msg.get('type')

    if t == 'FETCH_MEMBER_ID':
        mid = ensure_member_id()
        if mid:
            return {'success': True, 'memberId': mid}
        return {'success': False, 'error': 'NOT_LOGGED_IN'}

    if t == 'MEMBER_INFO_RAW':
        return {'success': True, 'info': fetch_member_info()}

    if t == 'CLEAR_MEMBER_ID':
        kv_del('member_id')
        with LOCK:
            CACHE.clear()
        return {'success': True}

    if t == 'GET_STATUS':
        mid = ensure_member_id()
        if not mid:
            return {'success': False, 'error': 'NOT_LOGGED_IN'}
        now = time.localtime()
        raw = fetch_attendance(mid, now.tm_year, now.tm_mon, msg.get('force') is True)
        return {'success': True, 'memberId': mid, 'raw': raw,
                'settings': kv_get('settings', {}), 'alarms': get_alarms()}

    if t == 'FETCH_ATTENDANCE':
        mid = ensure_member_id()
        if not mid:
            return {'success': False, 'error': 'NOT_LOGGED_IN'}
        raw = fetch_attendance(mid, msg.get('year'), msg.get('month'), msg.get('force') is True)
        return {'success': True, 'raw': raw}

    if t == 'GET_SETTINGS':
        return {'success': True, 'settings': kv_get('settings', {})}

    if t == 'UPDATE_SETTINGS':
        merged = dict(kv_get('settings', {}))
        merged.update(msg.get('settings') or {})
        kv_set('settings', merged)
        return {'success': True}

    if t == 'SET_ALARM':
        end_minutes = msg.get('endMinutes')
        alarm_type = msg.get('alarmType') or 'exit'
        label = msg.get('label') or '알림'
        midnight = time.localtime()
        base = time.mktime((midnight.tm_year, midnight.tm_mon, midnight.tm_mday, 0, 0, 0,
                            midnight.tm_wday, midnight.tm_yday, midnight.tm_isdst))
        target = int((base + end_minutes * 60) * 1000)
        if target <= time.time() * 1000:
            return {'success': False, 'reason': 'past'}
        mid = ensure_member_id() or 'unknown'
        name = f'codyssey_alarm_{mid}_{alarm_type}_{end_minutes}'
        upsert_alarm({'name': name, 'time': target, 'label': label,
                      'endMinutes': end_minutes, 'type': alarm_type, 'createdAt': int(time.time() * 1000)})
        return {'success': True, 'alarmName': name, 'triggerTime': target}

    if t == 'SET_EVAL_ALARM':
        name = msg.get('alarmName')
        when_ms = msg.get('whenMs')
        lead = msg.get('leadMinutes')
        if not name or not when_ms:
            return {'success': False, 'error': 'invalid'}
        now_ms = time.time() * 1000
        if when_ms <= now_ms:
            return {'success': False, 'reason': 'past'}
        # lead가 이미 지났으면 즉시 알림(5초 후) — 곧 시작할 평가도 등록 가능 (앱/익스텐션과 동일 정책)
        trigger = max(when_ms - lead * 60000, now_ms + 5000)
        title = (msg.get('title') or '평가').strip() or '평가'
        upsert_alarm({'name': name, 'time': trigger, 'label': f'📋 {title}',
                      'endMinutes': None, 'type': 'eval', 'evalTitle': title,
                      'evalWhen': when_ms, 'leadMinutes': lead,
                      'auto': msg.get('auto') is True, 'createdAt': int(time.time() * 1000)})
        return {'success': True, 'alarmName': name, 'triggerTime': trigger}

    if t == 'GET_ALARMS':
        return {'success': True, 'alarms': get_alarms()}

    if t == 'CANCEL_ALARM':
        cancel_alarms(msg.get('names') or [])
        return {'success': True}

    if t == 'EVAL_SCHEDULE':
        mid = ensure_member_id()
        if not mid:
            return {'success': False, 'error': 'NOT_LOGGED_IN'}
        raw = fetch_eval_schedule(mid, msg.get('instCd'), msg.get('fromYmd'), msg.get('toYmd'))
        # 샌드박스 실데이터 확인용 축약 (필드명/상태코드 검증) — 원문 raw도 그대로 전달
        return {'success': True, 'raw': raw, 'rows': summarize_eval_rows(raw),
                'host': LMS_BASE}

    if t == 'EVAL_ALARM_LIST':
        mid = ensure_member_id()
        if not mid:
            return {'success': False, 'error': 'NOT_LOGGED_IN'}
        raw = fetch_eval_alarm_list(msg.get('page') or 1, msg.get('pagePerRows') or 30)
        return {'success': True, 'raw': raw, 'host': LMS_BASE}

    if t == 'LOCAL_NOTIFY':
        return {'success': True}  # 팝업(하네스)이 직접 표시

    if t == 'SYNC_EVAL_ALARMS':
        return {'success': True}  # 하네스 클라이언트가 수행 (이 엔드포인트는 폴곤)

    if t == 'LOGOUT':
        with LOCK:
            if JAR is not None:
                JAR.clear()
            CACHE.clear()
        jar_save()
        kv_del('member_id', 'alarms', 'eval_sync_state', 'eval_inst_cd')
        # 게이트 스냅샷 등 gate_snapshot_* 접두어 키도 정리
        with LOCK:
            gate_keys = [k for k in KV.keys() if k.startswith('gate_snapshot_')]
        kv_del(*gate_keys)
        return {'success': True}

    return {'success': False, 'error': f'unknown type: {t}'}


def handle_native(path, body):
    if path == '/native/preCheckLogin':
        payload = json.dumps({'userId': body.get('userId', '')}).encode('utf-8')
        _, _, text = http_request(f'{AMS_BASE}/rest/login/pre-check',
                                  method='POST', data=payload,
                                  headers={'Content-Type': 'application/json'})
        return {'success': True, 'body': json_or_none(text) or {}}

    if path == '/native/authenticate':
        form = urllib.parse.urlencode({
            'userId': body.get('userId', ''),
            'password': body.get('password', ''),
            'from': body.get('from', '')
        }).encode('utf-8')
        _, final_url, text = http_request(f'{AMS_BASE}/authenticate',
                                          method='POST', data=form,
                                          headers={'Content-Type': 'application/x-www-form-urlencoded',
                                                   'Origin': AMS_BASE,
                                                   'Referer': AMS_BASE + '/'})
        parsed = json_or_none(text)
        if isinstance(parsed, dict):
            failed = (parsed.get('success') is False
                      or (isinstance(parsed.get('code'), (int, float)) and parsed.get('code') >= 400))
            return {'success': not failed, 'body': parsed}
        # 로그인 페이지로 되돌아온 경우
        if 'login' in (final_url or '').lower():
            return {'success': False, 'body': {'message': '로그인 실패'}}
        return {'success': True, 'body': {}}

    return {'success': False, 'error': 'unknown native endpoint'}


# ---------- HTTP 서버 ----------
class RelayHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print('[relay]', fmt % args)

    def _read_body(self):
        length = int(self.headers.get('Content-Length') or 0)
        raw = self.rfile.read(length) if length else b'{}'
        try:
            return json.loads(raw.decode('utf-8') or '{}')
        except Exception:
            return {}

    def do_GET(self):
        if self.path in ('/', '/index.html'):
            try:
                html = build_page().encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(html)))
                self.end_headers()
                self.wfile.write(html)
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(f'페이지 조립 실패: {e}'.encode('utf-8'))
            return
        if self.path.startswith('/events'):
            with LOCK:
                events = EVENTS[:]
                EVENTS.clear()
            json_response(self, {'events': events, 'now': int(time.time() * 1000)})
            return
        if self.path.startswith('/kv?'):
            qs = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            key = (qs.get('key') or [''])[0]
            json_response(self, {'success': True, 'value': kv_get(key)})
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        body = self._read_body()
        try:
            if self.path == '/msg':
                json_response(self, handle_msg(body))
                return
            if self.path == '/kv':
                kv_set(body.get('key'), body.get('value'))
                json_response(self, {'success': True})
                return
            if self.path.startswith('/native/'):
                json_response(self, handle_native(self.path, body))
                return
        except AuthRequired:
            json_response(self, {'success': False, 'error': 'NOT_LOGGED_IN'})
            return
        except ConnectionError as e:
            json_response(self, {'success': False, 'error': f'NETWORK_ERROR: {e}'})
            return
        except Exception as e:
            json_response(self, {'success': False, 'error': str(e)})
            return
        self.send_response(404)
        self.end_headers()


def main():
    global SAVE_SESSION
    ap = argparse.ArgumentParser(description='코디세이 출입 팝업 로컬 중계 서버')
    ap.add_argument('--host', default='127.0.0.1', help='바인딩 주소 (기본 127.0.0.1 — 외부 노출 금지)')
    ap.add_argument('--port', type=int, default=8787)
    ap.add_argument('--save-session', action='store_true', help='세션 쿠키를 파일에 저장 (재시작 후에도 로그인 유지)')
    args = ap.parse_args()

    SAVE_SESSION = args.save_session
    init_jar(args.save_session)
    kv_load()

    threading.Thread(target=alarm_loop, daemon=True).start()

    server = http.server.ThreadingHTTPServer((args.host, args.port), RelayHandler)
    print(f'[relay] 중계 서버 시작: http://{args.host}:{args.port}')
    print('[relay] 브라우저에서 위 주소를 열고 로그인하세요. 종료: Ctrl+C')
    print('[relay] ※ 로컬 전용 — 세션 쿠키=계정 권한, 외부 공유/배포 금지')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n[relay] 종료')


if __name__ == '__main__':
    main()
