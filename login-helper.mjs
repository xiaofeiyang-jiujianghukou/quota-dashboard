#!/usr/bin/env node
// 宿主机登录助手：用本机默认浏览器完成登录，抓取会话凭据并提交给看板
// 适用：Docker 部署（容器内没有浏览器）或本地服务器不想直接开浏览器时
//
// 用法：
//   node login-helper.mjs --provider ark --dashboard http://127.0.0.1:8899
//   provider: ark | zhipu | minimax
//
// 流程：弹出本机浏览器登录页 → 你在浏览器里扫码/输验证码登录 →
//       检测到登录后自动抓取会话凭据 → POST 到看板 /api/auth/update → 看板立即生效
import { startLogin, loginStatus, cancelLogin } from './lib/login.js';
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

const PROVIDERS = ['ark', 'zhipu', 'minimax'];
if (!PROVIDERS.includes(provider)) {
  console.error('用法: node login-helper.mjs --provider <ark|zhipu|minimax> [--dashboard http://127.0.0.1:8899]');
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-login-'));

async function main() {
  console.log(`[login-helper] 正在打开本机浏览器登录「${provider}」…`);
  await startLogin(provider, tmpDir);
  console.log('[login-helper] 浏览器已打开，请完成登录（扫码/验证码）。检测到登录后会自动提交…');

  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    let st;
    try {
      st = await loginStatus(provider, tmpDir, { noSave: true });
    } catch (e) {
      console.error('[login-helper] 检测失败:', e.message);
      break;
    }
    if (st.ok && st.fields) {
      console.log(`[login-helper] ✅ 登录成功，已抓取: ${Object.keys(st.fields).join(', ')}`);
      console.log(`[login-helper] 正在提交到看板 ${dashboard}/api/auth/update …`);
      const res = await fetch(`${dashboard}/api/auth/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerId: provider, fields: st.fields }),
      });
      const j = await res.json();
      if (j.ok) {
        console.log(`[login-helper] ✅ 已提交 ${j.changed} 项，看板「${provider}」登录状态已更新`);
        console.log('[login-helper] 回到看板点「立即刷新」即可看到最新数据');
      } else {
        console.error('[login-helper] ❌ 提交失败:', j.error || '未知错误');
      }
      process.exit(0);
    }
    if (i % 10 === 9) console.log(`[login-helper] 等待登录中…（已 ${((i + 1) * 3) / 60 | 0} 分钟）`);
  }
  console.error('[login-helper] 超时未检测到登录（10 分钟），已退出。可重试。');
  cancelLogin(provider);
  process.exit(2);
}

main().catch((e) => {
  console.error('[login-helper] 出错:', e.message);
  process.exit(1);
});
