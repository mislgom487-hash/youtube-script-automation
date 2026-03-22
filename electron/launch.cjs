/**
 * Electron 런처 — ELECTRON_RUN_AS_NODE 환경변수를 제거하고 electron을 시작합니다.
 * VSCode 터미널 등에서 ELECTRON_RUN_AS_NODE=1 이 설정된 경우에도 정상 동작합니다.
 */
const { spawn } = require('child_process');
const path = require('path');

const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;

const electronBin = require('../node_modules/electron');
const projectDir = path.join(__dirname, '..');

const child = spawn(electronBin, [projectDir], {
  env,
  stdio: 'inherit',
  detached: false
});

child.on('close', (code) => {
  process.exit(code || 0);
});

process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
