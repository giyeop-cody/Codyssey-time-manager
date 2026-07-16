// ============================================================
// JS 문법 검사 스크립트 (CI에서 실행)
// web/js 이하 모든 .js 파일을 node --check로 검증합니다.
// ============================================================
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOTS = [path.join(__dirname, '..', 'web', 'js'), path.join(__dirname)];

function collectJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectJsFiles(full));
    } else if (entry.name.endsWith('.js') && entry.name !== 'check-js.js') {
      out.push(full);
    }
  }
  return out;
}

let failed = 0;
const files = [...new Set(ROOTS.flatMap(collectJsFiles))];

// R6 관련: ES 모듈(import/export)이 포함된 .js 파일은 `node --check`가 거부하므로
// 내용을 임시 .mjs 파일로 복사해 모듈 모드로 검사합니다.
const os = require('os');
const MODULE_RE = /(^|\n)\s*(import\s|export\s)/;
const tmpFiles = [];

function checkTarget(file) {
  const src = fs.readFileSync(file, 'utf8');
  if (MODULE_RE.test(src)) {
    const tmp = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'checkjs-')),
      path.basename(file, '.js') + '.mjs'
    );
    fs.writeFileSync(tmp, src);
    tmpFiles.push(path.dirname(tmp));
    return tmp;
  }
  return file;
}

for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', checkTarget(file)], { stdio: 'pipe' });
    console.log(`OK   ${path.relative(process.cwd(), file)}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${path.relative(process.cwd(), file)}`);
    console.error(String(e.stderr || e.message).split('\n').slice(0, 6).join('\n'));
  }
}

for (const dir of tmpFiles) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 정리 실패 무시 */ }
}

if (failed > 0) {
  console.error(`\n${failed}개 파일에서 문법 오류가 발견되었습니다.`);
  process.exit(1);
}
console.log(`\n${files.length}개 파일 문법 검사 통과`);
