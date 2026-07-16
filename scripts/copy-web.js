const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', '..', 'codyssey-attendance-notifier');
const DEST_DIR = path.join(__dirname, '..', 'web');

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.log(`Source not found: ${src}`);
    return;
  }

  const entries = fs.readdirSync(src, { withFileTypes: true });

  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
      console.log(`Copied: ${entry.name}`);
    }
  }
}

// html 폴더 내용을 web 루트로 복사 (index.html이 루트에 오도록)
const htmlSrc = path.join(SRC_DIR, 'html');
const htmlDest = DEST_DIR;

console.log('Copying web assets...');
copyRecursive(path.join(SRC_DIR, 'css'), path.join(DEST_DIR, 'css'));
copyRecursive(path.join(SRC_DIR, 'js'), path.join(DEST_DIR, 'js'));
copyRecursive(path.join(SRC_DIR, 'icons'), path.join(DEST_DIR, 'icons'));

// html 파일을 루트로 이동
if (fs.existsSync(htmlSrc)) {
  const htmlFiles = fs.readdirSync(htmlSrc);
  for (const file of htmlFiles) {
    fs.copyFileSync(
      path.join(htmlSrc, file),
      path.join(htmlDest, file)
    );
    console.log(`Copied HTML: ${file}`);
  }
}

// manifest.json 복사 (아이콘용)
if (fs.existsSync(path.join(SRC_DIR, 'manifest.json'))) {
  fs.copyFileSync(
    path.join(SRC_DIR, 'manifest.json'),
    path.join(DEST_DIR, 'manifest.json')
  );
}

console.log('Web assets copied successfully!');