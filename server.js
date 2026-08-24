// AI 套餐余量看板 — 本地 HTTP 服务（仅绑定 127.0.0.1）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, providerStatus, ROOT_DIR } from './lib/config.js';
import { collectAll } from './lib/runner.js';
import { evaluateAlerts, alertStatus } from './lib/alert.js';
import * as wecom from './lib/wecom.js';
import { authStatus, updateAuth } from './lib/auth.js';
// login 模块懒加载（未安装 playwright 时自动登录降级，不影响看板）

let cfg = loadConfig(); // 每次采集/状态查询前会热加载，改 config.json 无需重启
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));

let cache = null; // 最近一次采集结果
let lastFetch = 0; // 上次采集完成时间(ms)
let inflight = null; // 进行中的采集 promise

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
    .then((result) => {
      cache = result;
      lastFetch = Date.now();
      // 提醒评估（内部异步发送，异常不外抛）
      evaluateAlerts(cfg, result);
      return result;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

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
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const { pathname } = url;

  try {
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
        alert: alertStatus(cfg),
      });
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
    if (req.method === 'POST' && pathname === '/api/auth/update') {
      try {
        cfg = loadConfig();
        let body = '';
        for await (const chunk of req) body += chunk;
        const { providerId, fields } = JSON.parse(body || '{}');
        const r = updateAuth(cfg, providerId, fields);
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
  console.log(`  打开浏览器访问:  http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${cfg.port}`);
  console.log(`  自动刷新间隔:    ${cfg.refreshIntervalSec}s`);
  console.log(`  密钥配置:        ${ROOT_DIR}/config.json`);
  console.log('==============================================');
});

process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});

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
