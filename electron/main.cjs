const { app, BrowserWindow, dialog, shell, globalShortcut } = require('electron');
const path = require('path');
const { fork } = require('child_process');
const fs = require('fs');
const net = require('net');

let mainWindow = null;
let serverProcess = null;
let serverPort = 3001;
let isQuitting = false;
let userDataPath = null;
let logPath = null;

function writeLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { if (logPath) fs.appendFileSync(logPath, line); } catch (e) {}
  console.log(msg);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port, '127.0.0.1');
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 100; port++) {
    if (await isPortAvailable(port)) return port;
  }
  return startPort;
}

function getServerScript() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server-bundle', 'index.js');
  }
  return path.join(__dirname, '..', 'server', 'index.js');
}

async function startServer() {
  serverPort = await findAvailablePort(3001);

  const serverScript = getServerScript();

  serverProcess = fork(serverScript, [], {
    env: {
      ...process.env,
      PORT: String(serverPort),
      ELECTRON_USER_DATA: userDataPath,
      ELECTRON_MODE: 'true',
      DIST_PATH: app.isPackaged
        ? path.join(process.resourcesPath, 'dist')
        : path.join(__dirname, '..', 'dist'),
      RESOURCES_PATH: process.resourcesPath
    },
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  });

  serverProcess.stdout.on('data', (data) => {
    writeLog('[Server] ' + data.toString().trim());
  });

  serverProcess.stderr.on('data', (data) => {
    writeLog('[Server Error] ' + data.toString().trim());
  });

  serverProcess.on('error', (err) => {
    writeLog('[Server fork Error] ' + err.message);
  });

  return new Promise((resolve, reject) => {
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('서버 시작 타임아웃 (30초)'));
      }
    }, 30000);

    serverProcess.on('message', (msg) => {
      if (msg === 'ready') {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          writeLog('[Server] 준비 완료');
          resolve();
        }
      } else if (msg === 'restart-requested') {
        writeLog('[Server] 재시작 요청 수신 (복원 등)');
        restartServer();
      }
    });

    serverProcess.on('exit', (code, signal) => {
      writeLog(`[Server] 프로세스 종료 — 코드: ${code}, 시그널: ${signal}`);
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(`서버 프로세스가 시작 중 종료되었습니다 (코드: ${code})`));
      }
    });
  });
}

async function restartServer() {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }

  await new Promise((r) => setTimeout(r, 2000));

  try {
    await startServer();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);
    }
  } catch (err) {
    console.error('[Server] 재시작 실패:', err);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: '미슬곰 유튜브 분석 프로그램',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false
    },
    show: false,
    backgroundColor: '#1a1a2e'
  });

  mainWindow.setMenuBarVisibility(false);

  mainWindow.loadURL(`http://127.0.0.1:${serverPort}`);

  // 키보드 단축키
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // F5 — 새로고침
    if (input.key === 'F5') {
      mainWindow.reload();
      event.preventDefault();
    }
    // Ctrl+R — 새로고침
    if (input.control && input.key === 'r') {
      mainWindow.reload();
      event.preventDefault();
    }
    // Ctrl+Shift+I — 개발자 도구 (디버깅용)
    if (input.control && input.shift && input.key === 'I') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(async () => {
  // app.ready 이후에만 getPath 호출 가능 (Electron 28+)
  userDataPath = app.getPath('userData');
  logPath = path.join(userDataPath, 'error.log');
  writeLog('=== 앱 시작 ===');
  writeLog('userDataPath: ' + userDataPath);
  writeLog('resourcesPath: ' + process.resourcesPath);

  const dataDir = path.join(userDataPath, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const userDbPath = path.join(dataDir, 'yadam.db');
  if (!fs.existsSync(userDbPath)) {
    // 설치된 리소스에서 DB 복사 (첫 실행 시에만)
    const resourceDbPath = path.join(process.resourcesPath, 'data', 'yadam.db');
    if (fs.existsSync(resourceDbPath)) {
      fs.copyFileSync(resourceDbPath, userDbPath);
    }
  }

  try {
    writeLog('서버 시작 중...');
    writeLog('서버 스크립트: ' + (app.isPackaged
      ? path.join(process.resourcesPath, 'server-bundle', 'index.js')
      : 'dev mode'));
    await startServer();
    writeLog('서버 시작 완료 — 창 생성');
    createWindow();
  } catch (error) {
    writeLog('[FATAL] 서버 시작 실패: ' + error.message);
    dialog.showErrorBox(
      '서버 시작 실패',
      `서버를 시작할 수 없습니다.\n\n${error.message}\n\n로그 파일: ${logPath}`
    );
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
});

app.on('window-all-closed', () => {
  isQuitting = true;
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});
