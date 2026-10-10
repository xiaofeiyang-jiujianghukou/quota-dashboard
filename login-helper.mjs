#!/usr/bin/env node
// 宿主机授权助手（Docker 部署时用；本机直接 node server.js 时不需要）
//
// 两种用法：
//   1) 常驻模式（推荐）：node login-helper.mjs
//      → 保持运行，随时在配置页点「官网授权（自动同步）」，
//        助手会弹出本机浏览器打开对应官网，你登录完它自动抓取会话并回传，看板立即生效。
//   2) 一次性模式：node login-helper.mjs --provider deepseek
//
// 支持平台：ark（方舟）| zhipu（智谱）| minimax | deepseek
import { startLogin, loginStatus, cancelLogin } from './lib/login.js';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const get = (k, d) => {
  const i = args.indexOf('--' + k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const onceProvider = get('provider', '');
const dashboard = String(get('dashboard', process.env.QUOTA_DASHBOARD || 'http://127.0.0.1:8899')).replace(/\/+$/, '');
const PROVIDERS = ['ark', 'zhipu', 'minimax', 'deepseek'];
const POLL_MS = 2500;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-login-'));
const log = (...a) => console.log('[授权助手]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname, body, method = 'POST') {
  const res = await fetch(`${dashboard}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

/** 跑一次授权：弹浏览器 → 等登录 → 抓取凭据，返回 fields 或抛错 */
async function capture(provider) {
  log(`正在打开本机浏览器，请登录「${provider}」…`);
  await startLogin(provider, tmpDir);
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(3000);
    // 心跳 + 取消检查（peek 不会取走新的请求）
    try {
      const beat = await api('/api/login/pending?peek=1', null, 'GET');
      if (beat && beat.abort) throw new Error('已被取消');
    } catch (e) {
      if (String(e.message).includes('已被取消')) throw e;
    }
    let st;
    try {
      st = await loginStatus(provider, tmpDir, { noSave: true });
    } catch (e) {
      throw new Error('检测登录状态失败: ' + e.message);
    }
    if (st && st.ok && st.fields && Object.keys(st.fields).length) return st.fields;
  }
  throw new Error('等待登录超时（10 分钟）');
}

/** 提交给看板并让看板验证能否真正采集 */
async function submit(provider, fields, requestId) {
  const r = await api('/api/login/result', { requestId, providerId: provider, ok: true, fields });
  return r;
}

async function handleRequest(req) {
  const provider = req.providerId;
  log(`收到看板请求：授权「${provider}」`);
  try {
    const fields = await capture(provider);
    log(`✅ 已抓取：${Object.keys(fields).join(', ')}，提交给看板…`);
    const r = await submit(provider, fields, req.requestId);
    if (r.ok) {
      const v = r.verified;
      if (v && v.ok) log(`✅ 看板已验证通过（采集到 ${v.items} 条数据），授权完成`);
      else if (v) log(`⚠️ 已保存凭据，但采集仍失败：${v.error || '未知原因'}`);
      else log('✅ 已保存凭据，看板已生效');
    } else {
      log('❌ 看板保存失败：' + (r.error || '未知错误'));
    }
  } catch (e) {
    if (String(e.message).includes('已被取消')) {
      log('已取消本次授权（浏览器已关闭）');
      return;
    }
    log('❌ 授权失败：' + e.message);
    await api('/api/login/result', { requestId: req.requestId, providerId: provider, ok: false, error: e.message }).catch(() => {});
  } finally {
    try { cancelLogin(provider); } catch { /* ignore */ }
  }
}

async function once(provider) {
  if (!PROVIDERS.includes(provider)) {
    console.error(`用法:\n  node login-helper.mjs                        # 常驻，等看板下发授权请求（推荐）\n  node login-helper.mjs --provider <${PROVIDERS.join('|')}>`);
    process.exit(1);
  }
  try {
    const fields = await capture(provider);
    log(`✅ 已抓取：${Object.keys(fields).join(', ')}`);
    const r = await api('/api/auth/update', { providerId: provider, fields });
    log(r.ok ? `✅ 已提交 ${r.changed} 项，看板已生效` : '❌ 提交失败：' + (r.error || ''));
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error('[授权助手] ❌', e.message);
    process.exit(2);
  }
}

async function daemon() {
  log(`已启动（看板 ${dashboard}）`);
  log('保持本窗口运行；在配置页点「官网授权（自动同步）」即可，无需复制任何凭据。Ctrl+C 退出。');
  let idleTicks = 0;
  for (;;) {
    let r;
    try {
      r = await api('/api/login/pending', null, 'GET');
    } catch (e) {
      if (idleTicks++ % 12 === 0) log(`⚠️ 连不上看板（${dashboard}）：${e.message}，${POLL_MS / 1000}s 后重试`);
      await sleep(POLL_MS);
      continue;
    }
    idleTicks = 0;
    if (r && r.request) {
      await handleRequest(r.request);
    }
    await sleep(POLL_MS);
  }
}

if (onceProvider) once(onceProvider);
else daemon();
