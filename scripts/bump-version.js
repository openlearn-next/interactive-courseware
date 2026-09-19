/**
 * 自动递进补丁版本脚本 (scripts/bump-version.js)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const pkgPath = path.join(rootDir, 'package.json');
const indexPath = path.join(rootDir, 'src', 'index.ts');
const manifestPath = path.join(rootDir, 'manifest.json');

// 1. 读取并更新 package.json 中的版本号
const pkgRaw = fs.readFileSync(pkgPath, 'utf-8');
const pkg = JSON.parse(pkgRaw);

const currentVersion = pkg.version || '1.0.0';
const versionParts = currentVersion.split('.').map(Number);
versionParts[2] = (versionParts[2] || 0) + 1; // 补丁版本 +1
const newVersion = versionParts.join('.');

pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');

// 2. 同步更新 src/index.ts 中的 manifest.version
if (fs.existsSync(indexPath)) {
  let indexContent = fs.readFileSync(indexPath, 'utf-8');
  indexContent = indexContent.replace(
    /version:\s*['"][^'"]+['"]/,
    `version: '${newVersion}'`
  );
  fs.writeFileSync(indexPath, indexContent, 'utf-8');
}

// 3. 同步更新根目录 manifest.json 的 version（打包 ZIP 时直接读取该文件）
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  manifest.version = newVersion;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
}

console.log(`🚀 [Version Bump] 成功递进补丁版本号: ${currentVersion} ➔ v${newVersion}`);
