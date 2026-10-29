import { cp, mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { buildDesktop, root } from './build.mjs';

// A directory package, with Electron + supported standalone Node. Models/Conda
// remain external so packaging never copies training assets or credentials.
await buildDesktop();
const destination = path.join(root, 'release/DeskAI2');
await mkdir(destination, { recursive: true });
await cp(path.join(root, 'node_modules/electron/dist'), destination, { recursive: true,
  filter: file => !file.endsWith(path.sep + 'electron.exe') });
await cp(path.join(root, 'node_modules/electron/dist/electron.exe'), path.join(destination, 'DeskAI.exe'));
await cp(process.execPath, path.join(destination, 'node.exe'));
const appRoot = path.join(destination, 'resources/app');
await mkdir(appRoot, { recursive: true });
for (const relative of ['.cache/desktop-main', '.cache/desktop-renderer', 'config', 'services/tts']) {
  await cp(path.join(root, relative), path.join(appRoot, relative), { recursive: true,
    filter: file => !file.includes('__pycache__') });
}
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
const packages = Object.entries(lock.packages).filter(([name, metadata]) => name.startsWith('node_modules/') && !metadata.dev)
  .map(([name]) => name).sort((a, b) => a.length - b.length);
const copied = [];
for (const relative of packages) {
  if (copied.some(parent => relative.startsWith(parent + '/'))) continue;
  try { await access(path.join(root, relative)); } catch { continue; } // optional packages for other platforms
  await cp(path.join(root, relative), path.join(appRoot, relative), { recursive: true });
  copied.push(relative);
}
await writeFile(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'deskai-desktop', version: '0.3.0', main: 'bootstrap.cjs', type: 'module' }, null, 2));
await writeFile(path.join(appRoot, 'bootstrap.cjs'), `const path = require('node:path');
const fs = require('node:fs');
const { app, dialog } = require('electron');
const directory = path.dirname(process.execPath);
try {
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'deskai-runtime.json'), 'utf8'));
  if (typeof config.assetRoot !== 'string' || !config.assetRoot) throw new Error('assetRoot 未配置');
  process.env.DESKAI_PROJECT_ROOT = __dirname;
  process.env.DESKAI_ASSET_ROOT = path.resolve(directory, config.assetRoot);
  process.env.DESKAI_NODE_EXECUTABLE = path.join(directory, 'node.exe');
  import('./.cache/desktop-main/apps/desktop/src/main.js').catch(error => {
    app.whenReady().then(() => { dialog.showErrorBox('DeskAI 启动失败', String(error.message).slice(0, 500)); app.exit(1); });
  });
} catch (error) {
  app.whenReady().then(() => { dialog.showErrorBox('DeskAI 运行资源设置', '请修改应用旁的 deskai-runtime.json，assetRoot 指向包含 assets、runtime、.conda 的目录。\\n' + String(error.message).slice(0, 500)); app.exit(1); });
}
`);
const configPath = path.join(destination, 'deskai-runtime.json');
try { await access(configPath); } catch { await writeFile(configPath, JSON.stringify({ assetRoot: '../..' }, null, 2)); }
await writeFile(path.join(destination, '启动DeskAI.cmd'), '@echo off\r\nstart "" "%~dp0DeskAI.exe"\r\n');
await writeFile(path.join(destination, '运行说明.txt'), '双击 DeskAI.exe 或 启动DeskAI.cmd。无需编译或分别启动服务。\r\n本包包含 Electron、独立 Node 与应用依赖；大模型、GPT-SoVITS runtime、Conda 留在外部。\r\n首次移动本包后，修改 deskai-runtime.json 的 assetRoot，指向包含 assets、runtime、.conda 的原资源目录；相对路径以本包为准。\r\n配置模型账号使用原 dsh Web 设置，凭据由 dsh 管理。\r\n关闭窗口默认隐藏到托盘；退出请用托盘菜单。系统睡眠后需要重新开始会话。\r\n真实麦克风、扬声器与 AEC 需要实际设备验收。\r\n');
console.log('可运行目录包：' + destination);
