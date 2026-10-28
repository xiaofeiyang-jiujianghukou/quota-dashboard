// AI 套餐余量看板 — 本地 HTTP 服务（仅绑定 127.0.0.1）
import http from 'node:http';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { loadConfig, providerStatus, updateProviderSettings, ROOT_DIR } from './lib/config.js';
import { collectAll } from './lib/runner.js';
import { ADAPTERS } from './providers/index.js';
import { evaluateAlerts, evaluateQuotaReminders, alertStatus, recentAlerts } from './lib/alert.js';
import * as wecom from './lib/wecom.js';
import { authStatus, updateAuth, smartUpdateAuth, clearLoginCache, AUTH_SCHEMA } from './lib/auth.js';
import { lifecycleAll, providerState, isEffective } from './lib/lifecycle.js';
import { addProvider, deleteProvider, upsertProvider, setCredentials, clearAllCredentials, backfillCredentialsFromConfig, backupNow, checkpoint } from './lib/store.js';
// login 模块懒加载（未安装 playwright 时自动登录降级，不影响看板）

// 启动时：先把 WAL 落盘，再自动备份一份（含实例与全部授权凭据）
try {
  checkpoint();
  const bk = backupNow('startup');
  if (bk) console.log(`[store] 已自动备份数据库: ${path.basename(bk)}`);
} catch (e) {
  console.error('[store] 启动备份失败:', e.message);
}

// 注意：默认【不会】用 config.json 自动补回凭据——用户删掉的东西不应自己回来。
// 需要这个行为时显式开启：QUOTA_BACKFILL=1
if (process.env.QUOTA_BACKFILL === '1') {
  try {
    const filled = backfillCredentialsFromConfig();
    if (filled) console.log(`[store] 已从 config.json 补齐 ${filled} 个实例的缺失凭据`);
  } catch (e) {
    console.error('[store] 凭据补齐失败:', e.message);
  }
}

let cfg = loadConfig(); // 每次采集/状态查询前会热加载，改 config.json 无需重启
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));

let cache = null; // 最近一次采集结果
let lastFetch = 0; // 上次采集完成时间(ms)
let inflight = null; // 进行中的采集 promise

// 官网授权：配置页建请求 → 宿主机 login-helper 取走执行 → 回传结果并验证
const authQueue = { request: null, last: null, helperSeenAt: 0, aborted: null };
const HELPER_TTL_MS = 15000; // 助手 15s 内有心跳即视为在线
// 授权登录的后台状态：开窗后由服务端自动等待登录完成
const authRun = { providerId: null, state: 'idle', saved: null, verified: null, error: null, startedAt: 0, timer: null, busy: false };

function stopAuthRun() {
  if (authRun.timer) {
    clearInterval(authRun.timer);
    authRun.timer = null;
  }
}

/** 后台轮询：检测到登录 → 保存 → 试采验证 → 记录结果（UI 只读状态，不做任何重活） */
async function authRunPoll() {
  const pid = authRun.providerId;
  if (!pid || authRun.state !== 'running' || authRun.busy) return;
  authRun.busy = true;
  try {
    const login = await loadLogin();
    if (!login.loginSession(pid).active) {
      if (authRun.state === 'running') {
        authRun.state = 'fail';
        authRun.error = '授权窗口已关闭（未检测到登录完成）';
      }
      stopAuthRun();
      return;
    }
    // 传入真实验证：只有确实能取到数据，才算登录成功（避免窗口提前关闭）
    const r = await login.loginStatus(pid, PUBLIC_DIR, { noSave: true, verify: (fields) => trialCollect(pid, fields) });
    if (r && r.ok && r.fields && Object.keys(r.fields).length) {
      upsertProvider(pid, {});
      setCredentials(pid, r.fields);
      clearLoginCache(pid);
      cache = null;
      inflight = null;
      const verified = await trialCollect(pid, r.fields);
      authRun.saved = Object.keys(r.fields);
      authRun.verified = r.verified || verified;
      authRun.state = authRun.verified && authRun.verified.ok ? 'ok' : 'saved';
      if (authRun.state !== 'ok') authRun.error = (authRun.verified && authRun.verified.error) || '采集验证未通过';
      try {
        checkpoint();
        backupNow('authok');
      } catch {
        /* 备份失败不影响授权 */
      }
      stopAuthRun();
      return;
    }
    if (Date.now() - authRun.startedAt > 10 * 60 * 1000) {
      authRun.state = 'fail';
      authRun.error = '等待登录超时（10 分钟）';
      stopAuthRun();
      login.cancelLogin(pid);
    }
  } catch (e) {
    authRun.state = 'fail';
    authRun.error = e.message;
    stopAuthRun();
  } finally {
    authRun.busy = false;
  }
}

/**
 * 试采：用「候选凭据 + 现有配置」跑一次该实例的真实采集（不落库）。
 * 用途：导入浏览器登录态时先验证候选凭据是否真的可用。
 */
async function trialCollect(providerId, fields) {
  try {
    const cur = loadConfig();
    const pv = cur.providers?.[providerId];
    if (!pv) return { ok: false, items: 0, error: `实例不存在: ${providerId}` };
    const mod = ADAPTERS[pv.type];
    if (!mod) return { ok: false, items: 0, error: `未知类型: ${pv.type}` };
    const trial = { ...cur, providers: { ...cur.providers, [providerId]: { ...pv, ...fields, enabled: true } } };
    const r = await mod.collect(trial, providerId, pv.name || providerId);
    return { ok: !!r.ok, items: (r.items || []).length, error: r.error || null };
  } catch (e) {
    return { ok: false, items: 0, error: e.message };
  }
}

function helperOnline() {
  return Date.now() - (authQueue.helperSeenAt || 0) < HELPER_TTL_MS;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function refresh(force = false) {
  cfg = loadConfig(); // 热加载：用户改 config.json 后无需重启
  if (inflight) return inflight;
  const now = Date.now();
  if (!force && cache && now - lastFetch < cfg.refreshIntervalSec * 1000) {
    return cache;
  }
  inflight = collectAll(cfg)
    .then(async (result) => {
      // 配置/面板分离：面板只呈现"有效且已授权"的供应商
      //（停用/过期/未配置/授权失效 → 一律不在面板显示；旧数据也不展示）
      result.lifecycle = lifecycleAll(cfg);
      const auth = await authStatus(cfg); // 内部 60s 缓存，不额外增加请求压力
      result.providers = result.providers.filter(
        (pv) => !pv.skipped && isEffective(cfg, pv.id) && auth[pv.id]?.loggedIn === true
      );
      cache = result;
      lastFetch = Date.now();
      // 提醒评估（内部异步发送，异常不外抛）
      evaluateAlerts(cfg, result);
      // 额度恢复桌面提醒（恢复前 5 分钟 / 恢复后，不依赖企业微信）
      evaluateQuotaReminders(result);
      return result;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE });
  res.end(body);
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    return JSON.parse(body || '{}');
  } catch {
    return {};
  }
}

/** 写接口鉴权：config.authToken 非空时（上云场景）必须携带匹配 token */
function writeAuthorized(req, cfg) {
  if (!cfg.authToken) return true;
  const token =
    String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') ||
    String(req.headers['x-auth-token'] || '');
  return token === cfg.authToken;
}

/** 配置管理页数据：供应商实例列表（分页在前端做）+ 类型目录 */
async function providersView(cfg) {
  const auth = await authStatus(cfg);
  const lc = lifecycleAll(cfg);
  const providers = Object.keys(cfg.providers || {})
    .filter((pid) => auth[pid])
    .map((pid) => {
      const pc = cfg.providers[pid] || {};
      return {
        id: pid,
        name: pc.name || auth[pid].name,
        type: pc.type || pid,
        method: auth[pid].method,
        methodText: auth[pid].methodText,
        note: auth[pid].note,
        loginUrl: LOGIN_URLS[pc.type] || LOGIN_URLS[pid] || null,
        cookieCapable: COOKIE_LOGIN_PROVIDERS.includes(pc.type),
        lifecycle: lc[pid],
        loggedIn: auth[pid]?.loggedIn === true,
        fields: auth[pid]?.fields || [],
        // 最近一次采集摘要（配置页据此区分"无套餐 / 无到期 / 待采集"）
        lastCollect: (() => {
          const one = cache && Array.isArray(cache.providers) ? cache.providers.find((x) => x.id === pid) : null;
          if (!one) return null;
          const its = one.items || [];
          // 按套餐名聚合：同一套餐的多条额度窗口合并为一项，带上各自的有效期与价格
          const planMap = new Map();
          for (const it of its) {
            if (!it.planName) continue;
            const cur = planMap.get(it.planName) || { name: it.planName, expiresAt: null, priceText: '', percentUsed: null };
            if (it.expiresAt && (!cur.expiresAt || it.expiresAt < cur.expiresAt)) cur.expiresAt = it.expiresAt;
            if (!cur.priceText && it.priceText) cur.priceText = it.priceText;
            if (cur.percentUsed == null && it.percentUsed != null) cur.percentUsed = it.percentUsed;
            planMap.set(it.planName, cur);
          }
          const plans = [...planMap.values()];
          const kinds = [...new Set(its.map((x) => x.kind).filter(Boolean))];
          return {
            ok: !!one.ok,
            noPlan: !!one.noPlan,
            items: its.length,
            plans,
            kinds,
            error: one.error || null,
            fetchedAt: one.fetchedAt || null,
          };
        })(),
      };
    });
  // 类型目录（新增表单用）
  const types = Object.entries(AUTH_SCHEMA).map(([type, schema]) => ({
    type,
    name: schema.name,
    methodText: METHOD_TEXTS[schema.method] || schema.method,
  }));
  return { providers, types, fetchedAt: new Date().toISOString() };
}

// 去官网授权页（面板 → 配置页共用）
const LOGIN_URLS = {
  ark: 'https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan',
  ark2: 'https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan',
  zhipu: 'https://bigmodel.cn/coding-plan/personal/usage',
  minimax: 'https://platform.minimaxi.com/console/usage',
  deepseek: 'https://platform.deepseek.com/usage',
};
const COOKIE_LOGIN_PROVIDERS = ['ark', 'ark2', 'zhipu', 'minimax', 'deepseek'];
const METHOD_TEXTS = { key: '密钥', cookie: 'Cookie', both: '密钥 + Cookie' };

function serveStatic(res, pathname) {
  // 仅允许 public 目录内的文件
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.resolve(PUBLIC_DIR, rel);
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', ...NO_CACHE });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const { pathname } = url;

  try {
    // 版本化入口：访问 / 时 302 到 /?v=<index.html 修改时间>，URL 变化强制浏览器拉新 HTML，杜绝缓存旧页
    if (req.method === 'GET' && pathname === '/' && !url.searchParams.has('v')) {
      const indexHtml = path.join(PUBLIC_DIR, 'index.html');
      const stamp = fs.existsSync(indexHtml) ? Math.floor(fs.statSync(indexHtml).mtimeMs) : Date.now();
      res.writeHead(302, { Location: `/?v=${stamp}` });
      res.end();
      return;
    }
    if (req.method === 'GET' && pathname === '/api/quota') {
      const force = url.searchParams.get('force') === '1';
      const data = await refresh(force);
      sendJson(res, 200, data);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/refresh') {
      const data = await refresh(true);
      sendJson(res, 200, data);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      cfg = loadConfig();
      sendJson(res, 200, {
        name: pkg.name,
        version: pkg.version,
        refreshIntervalSec: cfg.refreshIntervalSec,
        port: cfg.port,
        providers: providerStatus(cfg),
        lifecycle: lifecycleAll(cfg),
        alert: alertStatus(cfg),
      });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/alerts/recent') {
      // 最近已发送的提醒（看板页面拉取后弹浏览器桌面通知）
      const since = Number(url.searchParams.get('since')) || 0;
      sendJson(res, 200, { alerts: recentAlerts(since) });
      return;
    }
    if (req.method === 'GET' && pathname === '/api/wecom/status') {
      sendJson(res, 200, await wecom.wecomStatus());
      return;
    }
    if (req.method === 'POST' && pathname === '/api/wecom/init') {
      try {
        sendJson(res, 200, await wecom.startAuth(PUBLIC_DIR));
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/wecom/cancel') {
      wecom.cancelAuth();
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/wecom/re-auth') {
      try {
        sendJson(res, 200, await wecom.reAuth(PUBLIC_DIR));
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/wecom/test') {
      try {
        cfg = loadConfig();
        sendJson(res, 200, await wecom.sendTestMessage(cfg));
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    // ---- 授权登录（唯一方式）：开新窗口打开官网 → 已登录直接成功，未登录则登录后自动成功 ----
    if (req.method === 'POST' && pathname === '/api/login/session/start') {
      try {
        cfg = loadConfig();
        if (!writeAuthorized(req, cfg)) {
          sendJson(res, 401, { ok: false, error: '鉴权失败：authToken 不匹配' });
          return;
        }
        const { providerId } = await readBody(req);
        if (!cfg.providers?.[providerId]) {
          sendJson(res, 200, { ok: false, error: `实例不存在: ${providerId}` });
          return;
        }
        stopAuthRun();
        const login = await loadLogin();
        // 每个实例独立的浏览器配置：多账号不串号；首次继承旧的共用登录态
        const profileDir = login.ensureInstanceProfile(providerId);
        const r = await login.startLogin(providerId, PUBLIC_DIR, { mode: 'host', profileDir, noShot: true });
        authRun.providerId = providerId;
        authRun.state = 'running';
        authRun.saved = null;
        authRun.verified = null;
        authRun.error = null;
        authRun.startedAt = Date.now();
        authRun.timer = setInterval(() => { authRunPoll().catch(() => {}); }, 1500);
        sendJson(res, 200, { ok: true, ...r, state: 'running' });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/auth/clear') {
      // 取消授权：清空该实例全部凭据（浏览器里的登录态保留，重新授权仍是一键）
      try {
        cfg = loadConfig();
        if (!writeAuthorized(req, cfg)) {
          sendJson(res, 401, { ok: false, error: '鉴权失败：authToken 不匹配' });
          return;
        }
        const { providerId } = await readBody(req);
        if (!cfg.providers?.[providerId]) {
          sendJson(res, 200, { ok: false, error: `实例不存在: ${providerId}` });
          return;
        }
        stopAuthRun();
        try {
          const login = await loadLogin();
          login.cancelLogin(providerId);
        } catch {
          /* 没有进行中的会话也无妨 */
        }
        const removed = clearAllCredentials(providerId);
        clearLoginCache(providerId);
        // 真正取消授权：连该实例自己的浏览器登录一起退出。
        // 每个实例有独立配置目录（data/chrome-profile/<id>），所以不会影响同平台的其它账号。
        let loggedOut = false;
        try {
          const login = await loadLogin();
          const r = await login.clearPlatformLogin(providerId, { profileDir: login.ensureInstanceProfile(providerId) });
          loggedOut = !!(r && r.ok);
        } catch (e) {
          console.error('[auth] 退出实例浏览器登录态失败:', e.message);
        }
        cache = null;
        inflight = null;
        authRun.providerId = null;
        authRun.state = 'idle';
        sendJson(res, 200, { ok: true, removed, loggedOut });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/login/session/status') {
      const providerId = url.searchParams.get('providerId');
      const mine = authRun.providerId === providerId;
      if (mine && authRun.state === 'running') {
        try {
          const login = await loadLogin();
          const sess = login.loginSession(providerId);
          authRun.url = sess && sess.url ? sess.url : null;
        } catch {
          /* ignore */
        }
      }
      sendJson(res, 200, {
        url: mine ? authRun.url : null,
        ok: true,
        state: mine ? authRun.state : 'idle',
        saved: mine ? authRun.saved : null,
        verified: mine ? authRun.verified : null,
        error: mine ? authRun.error : null,
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/login/session/cancel') {
      try {
        const { providerId } = await readBody(req);
        stopAuthRun();
        authRun.providerId = null;
        authRun.state = 'idle';
        authRun.saved = null;
        authRun.verified = null;
        authRun.error = null;
        const login = await loadLogin();
        login.cancelLogin(providerId);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/login/request') {
      // 配置页点「官网授权」→ 建一条请求，交给宿主机上的 login-helper 弹浏览器抓取
      try {
        cfg = loadConfig();
        if (!writeAuthorized(req, cfg)) {
          sendJson(res, 401, { ok: false, error: '鉴权失败：authToken 不匹配' });
          return;
        }
        const { providerId } = await readBody(req);
        const pv = cfg.providers?.[providerId];
        if (!pv) {
          sendJson(res, 200, { ok: false, error: `实例不存在: ${providerId}` });
          return;
        }
        authQueue.request = { requestId: randomUUID(), providerId, type: pv.type, at: Date.now(), claimedAt: null };
        authQueue.last = null;
        sendJson(res, 200, { ok: true, requestId: authQueue.request.requestId, helperOnline: helperOnline() });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/login/pending') {
      // 宿主机助手轮询：取走待办请求（同时充当心跳）
      authQueue.helperSeenAt = Date.now();
      const aborting = !!(authQueue.aborted && Date.now() - authQueue.aborted.at < 60000);
      if (url.searchParams.get('peek') === '1') {
        // 执行中的心跳：不取走新请求，只回报是否被取消
        sendJson(res, 200, { ok: true, request: null, abort: aborting });
        return;
      }
      const r = authQueue.request;
      if (r && (!r.claimedAt || (aborting && r.requestId === authQueue.aborted.requestId))) {
        r.claimedAt = Date.now();
        sendJson(res, 200, { ok: true, request: r, abort: aborting });
        return;
      }
      if (r && Date.now() - r.claimedAt > 12 * 60 * 1000) {
        r.claimedAt = Date.now(); // 助手可能中途挂了，允许重新认领
        sendJson(res, 200, { ok: true, request: r, abort: aborting });
        return;
      }
      sendJson(res, 200, { ok: true, request: null, abort: aborting });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/login/abort') {
      // 配置页点「取消授权」：通知助手停止并放弃本次结果
      try {
        const { providerId } = await readBody(req);
        const rid = authQueue.request && authQueue.request.providerId === providerId ? authQueue.request.requestId : null;
        authQueue.aborted = { requestId: rid, providerId, at: Date.now() };
        authQueue.request = null;
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/login/result') {
      // 助手回传抓取结果 → 落库 → 立即用真实采集验证是否生效
      try {
        const { requestId, providerId, ok, fields, error } = await readBody(req);
        if (authQueue.request && authQueue.request.requestId === requestId) authQueue.request = null;
        if (authQueue.aborted && authQueue.aborted.requestId === requestId) {
          sendJson(res, 200, { ok: false, error: '本次授权已取消' });
          return;
        }
        if (!ok) {
          authQueue.last = { providerId, ok: false, error: error || '授权失败', at: Date.now() };
          sendJson(res, 200, { ok: true, verified: null });
          return;
        }
        const cur = loadConfig();
        if (!cur.providers?.[providerId]) {
          sendJson(res, 200, { ok: false, error: `实例不存在: ${providerId}` });
          return;
        }
        upsertProvider(providerId, {});
        setCredentials(providerId, fields || {});
        clearLoginCache(providerId);
        cache = null;
        inflight = null;
        // 真实验证：用刚保存的凭据跑一次采集，成功与否直接回给 UI
        let verified = null;
        try {
          const fresh = loadConfig();
          const all = await collectAll(fresh);
          const r = (all.providers || []).find((x) => x.id === providerId);
          verified = r
            ? { ok: !!r.ok, items: (r.items || []).length, error: r.error || null, skipped: !!r.skipped }
            : null;
        } catch (e) {
          verified = { ok: false, items: 0, error: e.message };
        }
        authQueue.last = { providerId, ok: true, saved: Object.keys(fields || {}), verified, at: Date.now() };
        sendJson(res, 200, { ok: true, verified });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/login/queue') {
      // 配置页轮询授权进度
      sendJson(res, 200, {
        ok: true,
        helperOnline: helperOnline(),
        pending: authQueue.request ? { providerId: authQueue.request.providerId, claimed: !!authQueue.request.claimedAt } : null,
        aborted: authQueue.aborted,
        last: authQueue.last,
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/api/login/auto') {
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { provider } = JSON.parse(body || '{}');
        const login = await loadLogin();
        sendJson(res, 200, await login.autoLogin(provider, PUBLIC_DIR));
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/login/start') {
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { provider } = JSON.parse(body || '{}');
        const login = await loadLogin();
        sendJson(res, 200, await login.startLogin(provider, PUBLIC_DIR));
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/login/status') {
      try {
        const login = await loadLogin();
        sendJson(res, 200, await login.loginStatus(url.searchParams.get('provider'), PUBLIC_DIR));
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/login/sms') {
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { provider, code } = JSON.parse(body || '{}');
        const login = await loadLogin();
        sendJson(res, 200, await login.submitSms(provider, code));
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/login/cancel') {
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { provider } = JSON.parse(body || '{}');
        const login = await loadLogin();
        sendJson(res, 200, login.cancelLogin(provider));
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/auth/status') {
      cfg = loadConfig();
      sendJson(res, 200, await authStatus(cfg));
      return;
    }
    if (req.method === 'GET' && pathname === '/config') {
      // 配置页：供应商与授权管理（与看板分离）
      serveStatic(res, '/config.html');
      return;
    }
    if (req.method === 'GET' && pathname === '/api/providers') {
      cfg = loadConfig();
      sendJson(res, 200, await providersView(cfg));
      return;
    }
    if (req.method === 'POST' && pathname === '/api/providers/add') {
      // 新增供应商实例：{ type, name? } → 生成唯一实例 id（ark / ark2 / ark3…）
      try {
        cfg = loadConfig();
        if (!writeAuthorized(req, cfg)) {
          sendJson(res, 401, { ok: false, error: '鉴权失败：authToken 不匹配' });
          return;
        }
        const { type, name } = await readBody(req);
        if (!AUTH_SCHEMA[type]) throw new Error(`未知类型: ${type}`);
        // 生成 id：优先裸类型名，被占用则追加序号
        let pid = type;
        for (let i = 2; cfg.providers[pid]; i++) pid = `${type}${i}`;
        addProvider(pid, type, (name || '').trim());
        cache = null;
        inflight = null;
        sendJson(res, 200, { ok: true, id: pid });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/providers/delete') {
      // 删除供应商实例：连同凭据/启停/有效期一并清除
      try {
        cfg = loadConfig();
        if (!writeAuthorized(req, cfg)) {
          sendJson(res, 401, { ok: false, error: '鉴权失败：authToken 不匹配' });
          return;
        }
        const { providerId } = await readBody(req);
        if (!cfg.providers[providerId]) throw new Error(`实例不存在: ${providerId}`);
        deleteProvider(providerId);
        clearLoginCache(providerId);
        cache = null;
        inflight = null;
        sendJson(res, 200, { ok: true });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/providers/settings') {
      // 生命周期设置：仅主动启停（enabled）。授权有效期由采集结果自动落库，不接受手填。
      try {
        cfg = loadConfig();
        if (!writeAuthorized(req, cfg)) {
          sendJson(res, 401, { ok: false, error: '鉴权失败：authToken 不匹配' });
          return;
        }
        const { providerId, enabled } = await readBody(req);
        if (!AUTH_SCHEMA[providerId]) throw new Error(`未知提供商: ${providerId}`);
        const r = updateProviderSettings(providerId, { enabled });
        inflight = null; // 配置已变，丢弃旧缓存让下次请求重新采集
        cache = null;
        sendJson(res, 200, { ...r, lifecycle: providerState(loadConfig(), providerId) });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/auth/smart') {
      // 唯一通用授权通道：粘贴凭据原文 → 自动识别字段 → 落库生效
      try {
        cfg = loadConfig();
        if (!writeAuthorized(req, cfg)) {
          sendJson(res, 401, { ok: false, error: '鉴权失败：authToken 不匹配' });
          return;
        }
        const { providerId, text } = await readBody(req);
        const r = smartUpdateAuth(cfg, providerId, text);
        cache = null;
        inflight = null;
        sendJson(res, 200, r);
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'POST' && pathname === '/api/auth/update') {
      try {
        cfg = loadConfig();
        if (!writeAuthorized(req, cfg)) {
          sendJson(res, 401, { ok: false, error: '鉴权失败：authToken 不匹配' });
          return;
        }
        const { providerId, fields } = await readBody(req);
        const r = updateAuth(cfg, providerId, fields);
        cache = null;
        inflight = null;
        sendJson(res, 200, { ...r, status: await authStatus(loadConfig()) });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message });
      }
      return;
    }
    if (req.method === 'GET') {
      serveStatic(res, pathname);
      return;
    }
    res.writeHead(405);
    res.end('Method Not Allowed');
  } catch (e) {
    sendJson(res, 500, { error: e.message || String(e) });
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[server] 端口 ${cfg.port} 被占用，请修改 config.json 的 port 或设置 QUOTA_PORT`);
  } else {
    console.error('[server] 启动失败:', e.message);
  }
  process.exit(1);
});

server.listen(cfg.port, process.env.HOST || '127.0.0.1', () => {
  const host = process.env.HOST || '127.0.0.1';
  console.log('==============================================');
  console.log(`  AI 套餐余量看板  v${pkg.version}`);
  // 授权配置目录（持久登录态）：只检查、只保留，任何情况下都不删除
  try {
    const authProfile = process.env.QUOTA_CHROME_PROFILE || path.join(ROOT_DIR, 'data', 'chrome-profile');
    if (fs.existsSync(authProfile)) {
      console.log(`  授权配置目录:    ${authProfile}（已保留，登录态不会失效）`);
    } else {
      console.log(`  授权配置目录:    ${authProfile}（首次授权时创建；此后长期保留）`);
    }
  } catch {
    /* ignore */
  }
  console.log(`  打开浏览器访问:  http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${cfg.port}`);
  console.log(`  自动刷新间隔:    ${cfg.refreshIntervalSec}s`);
  console.log(`  授权与实例:     ${path.join(ROOT_DIR, 'data', 'dashboard.db')}（SQLite，配置页在线管理）`);
  console.log('==============================================');
});

// 常驻采集/提醒循环：无人打开看板时也保证 峰谷、余额、到期、预算 提醒按时触发（5 分钟一轮）
setInterval(() => {
  refresh().catch((e) => console.error('[timer] 后台采集失败:', e.message));
}, 5 * 60 * 1000);
setTimeout(() => refresh().catch(() => {}), 3000); // 启动预热（延迟 3s 等容器网络就绪）

// 优雅退出：先关掉授权浏览器，让 Chrome 把登录态 Cookie 落盘（不删除任何配置，登录态长期保留）
let shuttingDown = false;
async function gracefulExit(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] 收到 ${signal}，正在保存并退出（授权配置不会删除）…`);
  try {
    const login = await loadLogin();
    login.cancelAll();
  } catch {
    /* 没有 playwright 或没有会话时忽略 */
  }
  try {
    server.close();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(0), 600);
}
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

/** 懒加载 login 模块：未安装 playwright（自动登录不可用）时返回友好错误 */
async function loadLogin() {
  try {
    return await import('./lib/login.js');
  } catch (e) {
    const err = new Error('自动登录未就绪：未安装 playwright/Chromium（可手动在鉴权面板粘贴密钥/Cookie）');
    err.isLoginUnavailable = true;
    throw err;
  }
}
