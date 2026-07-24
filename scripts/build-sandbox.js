// ============================================================
// 샌드박스 단일 파일 빌드 스크립트
// web/popup.html + popup.css + shared-attendance.js + popup.js + sandbox/harness.js
// → sandbox/popup-sandbox.html (외부 네트워크 없이 미리보기/브라우저에서 실행 가능)
//
// 실행: node scripts/build-sandbox.js
// ※ web/ 소스를 수정하면 다시 실행할 것 (생성물은 커밋 대상 아님)
// ============================================================
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// --- 소스 로드 ---
const htmlSrc = read('web/popup.html');
const css = read('web/css/popup.css');
const sharedSrc = read('web/js/shared-attendance.js');
const popupSrc = read('web/js/popup.js');
const harnessSrc = read('sandbox/harness.js');

// --- 모듈 스트립 (단일 스크립트 스코프로 병합) ---
// shared-attendance: export 접두어 제거
const shared = sharedSrc.replace(/^export /gm, '');
// popup: 상단 import 블록 제거 (shared 심볼은 같은 스코프에 이미 존재)
const popupStripped = popupSrc.replace(
  /^import \{[\s\S]*?\} from '\.\/shared-attendance\.js';\s*/m,
  ''
);
if (/^import /m.test(popupStripped)) {
  console.error('popup.js에서 제거되지 않은 import가 남아 있습니다');
  process.exit(1);
}
if (/^export /m.test(shared)) {
  console.error('shared-attendance.js에서 제거되지 않은 export가 남아 있습니다');
  process.exit(1);
}

// --- 샌드박스 전용 CSS ---
const sandboxCss = `
#sb-panel{background:#1e293b;color:#e2e8f0;padding:10px 12px;border-bottom:2px solid #4ec9b0;font-size:12px;font-family:sans-serif}
#sb-panel .sb-title{font-weight:700;margin-bottom:6px}
#sb-panel .sb-row{display:flex;flex-wrap:wrap;gap:6px}
#sb-panel button{font-size:11px;padding:4px 8px;border:1px solid #475569;background:#334155;color:#f8fafc;border-radius:6px;cursor:pointer}
#sb-panel button:hover{background:#475569}
#sb-panel .sb-log{margin-top:6px;color:#94a3b8;font-size:10px;min-height:12px;word-break:break-all}
#sb-panel .sb-hint{margin-top:4px;color:#64748b;font-size:10px}
#sb-toasts{position:fixed;right:8px;bottom:8px;z-index:99999;display:flex;flex-direction:column;gap:6px}
.sb-toast{background:#0f172a;color:#f1f5f9;border:1px solid #4ec9b0;border-radius:8px;padding:8px 10px;font-size:12px;opacity:0;transform:translateY(6px);transition:.3s;max-width:280px;box-shadow:0 4px 12px rgba(0,0,0,.3);font-family:sans-serif}
.sb-toast.show{opacity:1;transform:none}
`;

// --- HTML 조립 ---
let out = htmlSrc;
out = out.replace('<title>코디세이 출입 현황 알리미</title>', '<title>[샌드박스] 코디세이 출입 현황 알리미</title>');
out = out.replace(
  '<link rel="stylesheet" href="./css/popup.css">',
  `<style>\n${css}\n${sandboxCss}\n</style>`
);
// capacitor-adapter → 하네스가 대체 (외부 스크립트 제거)
out = out.replace(/<script type="module" src="\.\/js\/capacitor-adapter\.js"><\/script>\s*/, '');
out = out.replace(
  /<script type="module" src="\.\/js\/popup\.js"><\/script>\s*/,
  () => `<script type="module">\n${shared}\n\n${harnessSrc}\n\n${popupStripped}\n</script>\n`
);

if (out.includes('./js/') || out.includes('./css/')) {
  console.error('외부 참조가 남아 있습니다 (./js/ 또는 ./css/)');
  process.exit(1);
}

const moduleCode = `${shared}\n\n${harnessSrc}\n\n${popupStripped}`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sbx-'));
const tmpFile = path.join(tmpDir, 'module-check.mjs');
fs.writeFileSync(tmpFile, moduleCode);
try {
  execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
} catch (e) {
  console.error('조립된 모듈 문법 오류:\n' + String(e.stderr || e.message).split('\n').slice(0, 8).join('\n'));
  process.exit(1);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

fs.writeFileSync(path.join(ROOT, 'sandbox', 'popup-sandbox.html'), out);
// 46차: PNG 아이콘 복사 (sandbox에서 상대 경로 icons/ 참조용)
try {
  fs.cpSync(path.join(ROOT, 'web', 'icons'), path.join(ROOT, 'sandbox', 'icons'), { recursive: true });
  console.log('OK sandbox/icons 아이콘 복사');
} catch (e) { console.warn('icons copy skip:', e.message); }
console.log(`OK sandbox/popup-sandbox.html 생성 (${(out.length / 1024).toFixed(1)} KB, 모듈 문법 검사 통과)`);
