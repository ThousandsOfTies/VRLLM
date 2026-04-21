import { defineConfig } from 'vite';
import { spawn } from 'child_process';
import { createConnection } from 'net';
import path from 'path';
import os from 'os';

const AIVIS_PORT = 10101;

// AivisSpeech Engine の実行ファイルパス候補
const AIVIS_PATHS = [
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'AivisSpeech', 'AivisSpeech-Engine', 'run.exe'),
  'C:\\Program Files\\AivisSpeech\\AivisSpeech-Engine\\run.exe',
];

/** ポートが応答しているか確認 */
function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.setTimeout(1000);
    socket.on('connect', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
}

/** AivisSpeech Engine が起動するまで最大 30 秒待つ */
function waitForEngine(port, retries = 30) {
  return new Promise(async (resolve, reject) => {
    for (let i = 0; i < retries; i++) {
      if (await isPortOpen(port)) return resolve();
      await new Promise(r => setTimeout(r, 1000));
    }
    reject(new Error('AivisSpeech Engine の起動タイムアウト'));
  });
}

let aivisProcess = null;

/** Vite プラグイン: AivisSpeech Engine 自動起動 */
function aivisAutoStart() {
  return {
    name: 'aivis-auto-start',
    async buildStart() {
      // すでに起動中なら何もしない
      if (await isPortOpen(AIVIS_PORT)) {
        console.log('\x1b[32m✓ AivisSpeech Engine はすでに起動しています\x1b[0m');
        return;
      }

      // 実行ファイルを探す
      const { existsSync } = await import('fs');
      const exePath = AIVIS_PATHS.find(p => existsSync(p));
      if (!exePath) {
        console.warn('\x1b[33m⚠ AivisSpeech Engine が見つかりません。手動で起動してください。\x1b[0m');
        return;
      }

      console.log('\x1b[36m⏳ AivisSpeech Engine を起動中...\x1b[0m');
      aivisProcess = spawn(exePath, ['--cors_policy_mode', 'all'], {
        detached: false,
        stdio: 'ignore',
        windowsHide: true,
      });
      aivisProcess.unref();

      try {
        await waitForEngine(AIVIS_PORT);
        console.log('\x1b[32m✓ AivisSpeech Engine 起動完了 (http://localhost:10101)\x1b[0m');
      } catch (e) {
        console.warn('\x1b[33m⚠ ' + e.message + '\x1b[0m');
      }
    },
    closeBundle() {
      if (aivisProcess) {
        aivisProcess.kill();
        aivisProcess = null;
      }
    },
  };
}

export default defineConfig({
  plugins: [aivisAutoStart()],
  base: process.env.GITHUB_PAGES
    ? `/${process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'AI-LiveTalk'}/`
    : '/',
  server: {
    port: 5173,
    proxy: {
      '/aivis': {
        target: 'http://localhost:10101',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/aivis/, ''),
      },
    },
  },
});
