#!/usr/bin/env node
// 一键自动登录：直接读取本机 Chrome/Edge 已登录的会话（零交互），提交给看板
// 适用：Docker 部署（宿主机跑）或本地快速补会话
//
// 用法：
//   node auto-login.mjs --provider ark [--dashboard http://127.0.0.1:8899]
//   provider: ark | zhipu | minimax
//
// 原理：用 Playwright 以 headless 方式打开你的 Chrome 真实配置目录
//       （里面存着你已登录各控制台的会话 cookie），直接读出并提交。
//       无需扫码、无需输验证码——前提是你的 Chrome 里该平台仍是登录态。
// 注意：若 Chrome 正在运行（配置被锁），先关闭 Chrome 再执行。
import { startLogin, loginStatus } from './lib/login.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const provider = get('provider', '');
const dashboard = String(get('dashboard', 'http://127.0.0.1:8899')).replace(/\/+$/, '');
const profile = process.env.CHROME_USER_DATA_DIR || '';

const PROVIDERS = ['ark', 'zhipu', 'minimax'];
if (!PROVIDERS.includes(provider)) {
  console.error('用法: node auto-login.mjs --provider <ark|zhipu|minimax> [--dashboard http://127.0.0.1:8899]');
  process.exit(1);
}

/** 探测本机 Chrome/Edge 配置目录（Linux） */
function detectProfile() {
  if (profile && fs.existsSync(profile)) return profile;
  const home = os.homedir();
  const candidates = [
    path.join(home, '.config/google-chrome'),
    path.join(home, '.config/microsoft-edge'),
    path.join(home, '.config/chromium'),
    path.join(home, 'snap/chromium/current/.config/chromium'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'Default'))) return c;
  }
  return null;
}

/** 复制 cookie 相关文件到临时配置（Chrome 正在运行时也能读） */
function copyCookieProfile(src, tmp) {
  const rels = ['Local State', 'Default/Cookies', 'Default/Network/Cookies', 'Default/Preferences'];
  let copied = 0;
  for (const rel of rels) {
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      const s = path.join(src, rel + suffix);
      const d = path.join(tmp, rel + suffix);
      if (fs.existsSync(s)) {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d);
        copied++;
      }
    }
  }
  return copied > 0;
}

async function main() {
  const dir = detectProfile();
  if (!dir) {
    console.error('未找到 Chrome/Edge 配置目录。可设置环境变量 CHROME_USER_DATA_DIR 指定。');
    process.exit(1);
  }
  console.log(`[auto-login] 使用 Chrome 配置: ${dir}`);
  console.log(`[auto-login] 正在读取「${provider}」的已登录会话…（headless，约 10 秒）`);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-auto-'));
  let usedDir = dir;
  try {
    await startLogin(provider, tmpDir, { profile: usedDir });
  } catch (e) {
    // Chrome 正在运行导致配置被锁 → 复制 cookie 文件到临时配置再试
    if (/ProcessSingleton|SingletonLock|profile.*in use|in use/i.test(String(e.message))) {
      console.log('[auto-login] Chrome 正在运行，复制会话文件到临时配置…');
      const tmpProfile = path.join(tmpDir, 'profile');
      if (copyCookieProfile(dir, tmpProfile)) {
        usedDir = tmpProfile;
        try {
          await startLogin(provider, tmpDir, { profile: usedDir });
        } catch (e2) {
          console.error('[auto-login] ❌ 复制配置启动失败:', e2.message);
          process.exit(1);
        }
      } else {
        console.error('[auto-login] ❌ 无法复制会话文件:', e.message);
        process.exit(1);
      }
    } else {
      console.error('[auto-login] ❌ 启动失败:', e.message);
      console.error('[auto-login] 若 Chrome 正在运行导致配置被锁，请先关闭 Chrome 再试；或改用交互式: node login-helper.mjs --provider ' + provider);
      process.exit(1);
    }
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    let st;
    try {
      st = await loginStatus(provider, tmpDir, { noSave: true });
    } catch (e) {
      console.error('[auto-login] 检测失败:', e.message);
      break;
    }
    if (st.ok && st.fields) {
      console.log(`[auto-login] ✅ 读取到会话: ${Object.keys(st.fields).join(', ')}`);
      const res = await fetch(`${dashboard}/api/auth/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: provider, fields: st.fields }),
      });
      const j = await res.json();
      if (j.ok) {
        console.log(`[auto-login] ✅ 已提交 ${j.changed} 项，看板「${provider}」已登录！`);
      } else {
        console.error('[auto-login] ❌ 提交失败:', j.error || '未知错误');
        process.exit(3);
      }
      process.exit(0);
    }
  }
  console.error('[auto-login] ❌ 未在 Chrome 配置中找到该平台的会话（可能未登录或已过期）。');
  console.error('[auto-login] 请先在 Chrome 里登录该平台，或改用交互式: node login-helper.mjs --provider ' + provider);
  process.exit(2);
}

main().catch((e) => {
  console.error('[auto-login] 出错:', e.message);
  process.exit(1);
});
