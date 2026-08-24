// 企业微信提醒的扫码授权管理（wecom-cli 封装）
// 提供: 状态查询 / 扫码授权(生成二维码) / 取消 / 测试消息
// 让"下载项目 → 扫码 → 提醒生效"全流程在浏览器里完成
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runCli, parseCliJson } from '../providers/util.js';

const AUTH_QR_FILE = 'wecom-qr.png';
let flow = { child: null, startedAt: null, qrPath: null, exitedOk: null };
let authCache = { at: 0, value: null };
let installedCache = { at: 0, value: null };

function isWecomInstalled() {
  const now = Date.now();
  if (now - installedCache.at < 60000) return Promise.resolve(installedCache.value);
  return new Promise((resolve) => {
    execFile('wecom-cli', ['--version'], { timeout: 8000 }, (err) => {
      installedCache = { at: Date.now(), value: !err };
      resolve(!err);
    });
  });
}

/** 未安装则尝试自动安装（npm -g）；失败抛错 */
export async function ensureWecomCli() {
  if (await isWecomInstalled()) return true;
  await runCli('npm', ['install', '-g', '@wecom/cli'], { timeoutMs: 180000 });
  installedCache = { at: 0, value: null };
  if (!(await isWecomInstalled())) {
    throw new Error('自动安装 wecom-cli 失败，请手动执行：npm install -g @wecom/cli');
  }
  return true;
}

async function checkAuthorized() {
  const now = Date.now();
  if (authCache.value != null && now - authCache.at < 30000) return authCache.value;
  try {
    const { stdout } = await runCli('wecom-cli', ['auth', 'show', '--status'], { timeoutMs: 15000 });
    const ok = /authorized/i.test(stdout);
    authCache = { at: Date.now(), value: ok };
    return ok;
  } catch {
    authCache = { at: Date.now(), value: false };
    return false;
  }
}

/** 从 whoami 的 extra_identity_context 提取机器人/授权人名字（失败返回 null） */
async function whoamiNames() {
  try {
    const { stdout } = await runCli('wecom-cli', ['identity', 'whoami'], { timeoutMs: 15000 });
    const me = parseCliJson(stdout);
    const ctx = (me && me.extra_identity_context) || '';
    const bot = ctx.match(/机器人身份：\s*名字：([^\n]+)/);
    const user = ctx.match(/授权真人用户身份：\s*名字：([^\n]+)/);
    return { botName: bot ? bot[1].trim() : null, userName: user ? user[1].trim() : null };
  } catch {
    return { botName: null, userName: null };
  }
}

/** 当前状态（给 /api/wecom/status） */
export async function wecomStatus() {
  const installed = await isWecomInstalled();
  const flowRunning = !!(flow.child && flow.child.exitCode === null);
  let authorized = null;
  if (installed) {
    if (flow.exitedOk === true) authorized = true;
    else if (flow.exitedOk === false) authorized = false;
    else authorized = await checkAuthorized();
  }
  const names = authorized ? await whoamiNames() : { botName: null, userName: null };
  return {
    installed,
    authorized,
    flowRunning,
    qrReady: flow.qrPath ? fs.existsSync(flow.qrPath) : false,
    qrUrl: flow.qrPath ? '/' + AUTH_QR_FILE : null,
    botName: names.botName,
    userName: names.userName,
  };
}

/** 启动扫码授权（生成二维码到 public/，进程保持等待扫码） */
export async function startAuth(publicDir) {
  if (!(await isWecomInstalled())) {
    await ensureWecomCli();
  }
  if (flow.child && flow.child.exitCode === null) {
    return { ok: true, qrUrl: '/' + AUTH_QR_FILE, alreadyRunning: true };
  }
  const qrPath = path.join(publicDir, AUTH_QR_FILE);
  try {
    fs.unlinkSync(qrPath);
  } catch {
    /* 不存在则忽略 */
  }
  flow = { child: null, startedAt: Date.now(), qrPath, exitedOk: null };
  const child = spawn(
    'wecom-cli',
    ['auth', 'init', '--noninteractive', '--output-qrcode', AUTH_QR_FILE],
    { cwd: publicDir, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  flow.child = child;
  child.on('exit', (code) => {
    flow.exitedOk = code === 0;
    flow.child = null;
    authCache = { at: 0, value: null };
  });
  return { ok: true, qrUrl: '/' + AUTH_QR_FILE };
}

/** 重新授权：清除已存凭据后重新扫码（可用于换账号/换企业微信） */
export function reAuth(publicDir) {
  cancelAuth();
  try {
    const dir = path.join(os.homedir(), '.config', 'wecom');
    for (const f of ['credentials.enc', '.encryption_key']) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    fs.rmSync(path.join(dir, 'cache'), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  authCache = { at: 0, value: null };
  installedCache = { at: 0, value: null };
  return startAuth(publicDir);
}

/** 取消扫码授权 */
export function cancelAuth() {
  if (flow.child && flow.child.exitCode === null) {
    try {
      flow.child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  flow.exitedOk = null;
  flow.child = null;
}

/** 发送测试消息（默认发给授权人自己，或 cfg.alert.wecom.chatName 指定会话） */
export async function sendTestMessage(cfg) {
  const w = (cfg.alert && cfg.alert.wecom) || {};
  let chatId = null;
  if (w.chatName) {
    const { stdout } = await runCli('wecom-cli', ['message', 'aibot', 'sessions', 'list'], { timeoutMs: 30000 });
    const list = parseCliJson(stdout);
    const hit = (list.sessions || []).find((s) => s.chat_name === w.chatName);
    if (!hit) throw new Error(`未在最近会话中找到「${w.chatName}」（需先与该会话有消息往来）`);
    chatId = hit.chat_id;
  } else {
    const { stdout } = await runCli('wecom-cli', ['identity', 'whoami'], { timeoutMs: 30000 });
    const me = parseCliJson(stdout);
    chatId = findUserId(me) || parseIdentityContext(me);
    if (!chatId) throw new Error('无法解析授权人，请先完成扫码授权');
  }
  const content = '**✅ 微信提醒通道测试**\n\n这是 quota-dashboard 发出的测试消息。接下来你会收到每日套餐汇总，以及余量/到期告警。';
  const payload = JSON.stringify({ chat_id: chatId, msg_type: 'markdown', markdown: { content } });
  await runCli('wecom-cli', ['message', 'aibot', 'send', '--json', payload], { timeoutMs: 30000 });
  return { ok: true };
}

function findUserId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    if ((k === 'userid' || k === 'chat_id' || k === 'userId') && typeof obj[k] === 'string' && obj[k]) return obj[k];
    const v = findUserId(obj[k]);
    if (v) return v;
  }
  return null;
}

function parseIdentityContext(me) {
  const ctx = (me && me.extra_identity_context) || '';
  const m = ctx.match(/授权真人用户身份[\s\S]*?ID：\s*([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}
