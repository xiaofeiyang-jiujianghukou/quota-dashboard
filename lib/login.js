// 本机浏览器自动登录（Playwright 驱动系统 Chrome/Edge，不打包浏览器）
// 流程：点「未登录」→ 打开本机默认浏览器登录页（真实窗口，扫码/验证码照常）→
//       检测到登录后自动抓取会话凭据 → 写入 config.json（或由 login-helper 提交给看板）
// 支持：方舟(控制台 cookie+csrf+webid)、智谱(会话 JWT)、MiniMax(控制台 cookie)
// 注意：容器内无系统浏览器，Docker 部署请用宿主机运行 login-helper.mjs
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_PATH } from './config.js';

const TARGETS = {
  ark: {
    name: '方舟',
    startUrl: 'https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan',
    afterUrl: 'https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan',
    cookieDomains: ['volcengine.com'],
    successCookies: ['userInfo', 'digest'], // 登录后控制台会种这些会话 cookie
    save(cap) {
      const out = { sessionCookie: cap.cookie || '' };
      if (cap.csrfToken) out.csrfToken = cap.csrfToken;
      if (cap.webId) out.webId = cap.webId;
      return out;
    },
  },
  zhipu: {
    name: '智谱',
    startUrl: 'https://open.bigmodel.cn/',
    afterUrl: 'https://open.bigmodel.cn/coding-plan/personal/overview',
    authHeaderUrl: 'open.bigmodel.cn/api/agent',
    save(cap) {
      return { sessionToken: cap.authHeader || '' };
    },
  },
  minimax: {
    name: 'MiniMax',
    startUrl: 'https://platform.minimaxi.com/',
    afterUrl: 'https://platform.minimaxi.com/',
    cookieDomains: ['minimaxi.com'],
    successCookies: ['_token'],
    save(cap) {
      const out = { sessionCookie: cap.cookie || '' };
      if (cap.groupId) out.groupId = cap.groupId;
      return out;
    },
  },
};

const sessions = new Map(); // sessionId -> { browser, context, page, target, captured, provider }

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 用系统已安装的浏览器启动：
 *  opts.profile 给定 Chrome 配置目录 → headless 读取该配置里的已登录会话（零交互自动登录）
 *  否则 → 打开真实浏览器窗口交互登录（Chrome → Edge → Chromium；不下载任何浏览器） */
async function launchBrowser(opts = {}) {
  if (opts.profile) {
    // 读取本机已登录的 Chrome/Edge 配置（cookie 直接可用）
    return { persistent: true, context: await chromium.launchPersistentContext(opts.profile, { channel: 'chrome', headless: true, args: ['--no-sandbox'] }) };
  }
  const channels = ['chrome', 'msedge', 'chromium'];
  let lastErr = null;
  for (const channel of channels) {
    try {
      const browser = await chromium.launch({
        channel,
        headless: false,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      });
      return { persistent: false, browser, context: null };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('未找到本机浏览器（Chrome/Edge/Chromium）。Docker 部署请在宿主机运行：node auto-login.mjs --provider <ark|zhipu|minimax>');
}

/** 启动登录：profile 模式读取本机已登录会话；否则打开真实浏览器窗口，返回会话截图 URL */
export async function startLogin(provider, publicDir, opts = {}) {
  const target = TARGETS[provider];
  if (!target) throw new Error(`不支持的登录平台: ${provider}`);
  if (sessions.has(provider)) cancelLogin(provider); // 同平台重复登录先关旧的

  const launched = await launchBrowser(opts);
  const context = launched.persistent
    ? launched.context
    : await launched.browser.newContext({ viewport: { width: 960, height: 720 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const captured = {};

  // 拦截请求：抓智谱会话 JWT / 方舟 CSRF、WebId
  page.on('request', (req) => {
    try {
      const url = req.url();
      const h = req.headers();
      if (target.authHeaderUrl && url.includes(target.authHeaderUrl) && !captured.authHeader) {
        const auth = h['authorization'];
        if (auth && auth.length > 40) captured.authHeader = auth;
      }
      if (provider === 'ark' && url.includes('console.volcengine.com/api/top') && !captured.webId) {
        const wid = h['x-web-id'];
        if (wid && wid.length > 20) captured.webId = wid;
      }
      if (provider === 'ark' && url.includes('console.volcengine.com') && !captured.csrfToken) {
        const ct = h['x-csrf-token'] || h['csrf-token'];
        if (ct && ct.length > 8) captured.csrfToken = ct;
      }
    } catch {
      /* ignore */
    }
  });

  await page.goto(target.startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  sessions.set(provider, { browser: launched.browser || null, context, page, target, captured, provider });

  // 截图（登录页/二维码）
  await sleep(2500);
  await captureShot(provider, publicDir);
  return { ok: true, sessionId: provider, qrUrl: `/login-${provider}.png` };
}

async function captureShot(provider, publicDir) {
  const s = sessions.get(provider);
  if (!s) return;
  const p = path.join(publicDir, `login-${provider}.png`);
  await s.page.screenshot({ path: p }).catch(() => {});
}

/** 查询登录状态：检测到会话凭据即视为成功；默认写入配置（noSave=true 时只返回字段，由调用方提交） */
export async function loginStatus(provider, publicDir, opts = {}) {
  const s = sessions.get(provider);
  if (!s) return { ok: false, state: 'idle' };
  const { target, context, captured, page } = s;

  // 定期尝试跳转 afterUrl，触发目标 API 请求（如智谱 overview 页）
  if (!captured._navigatedAfter) {
    captured._navigatedAfter = true;
    page.goto(target.afterUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }

  // 检测登录成功
  let success = false;
  if (target.authHeaderUrl) {
    success = !!captured.authHeader;
  } else {
    try {
      const cookies = await context.cookies();
      const names = cookies.map((c) => c.name);
      success = target.successCookies.some((n) => names.includes(n));
      // 抓整包 Cookie（按域名）
      if (success && !captured.cookie) {
        const filtered = cookies.filter((c) => target.cookieDomains.some((d) => c.domain.endsWith(d)));
        captured.cookie = filtered.map((c) => `${c.name}=${c.value}`).join('; ');
      }
      if (provider === 'minimax' && !captured.groupId) {
        const g = cookies.find((c) => c.name === 'minimax_group_id_v2');
        if (g) captured.groupId = g.value;
      }
    } catch {
      /* ignore */
    }
  }

  if (!success) {
    // 每 3 秒刷新二维码截图，方便看最新状态
    await captureShot(provider, publicDir);
    return { ok: false, state: 'waiting' };
  }

  // 成功：默认写入 config.json；noSave 模式由调用方（login-helper）提交
  const fields = target.save(captured);
  if (!opts.noSave) {
    const file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    file.providers = file.providers || {};
    file.providers[provider] = { ...(file.providers[provider] || {}), ...fields };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + '\n');
  }
  cancelLogin(provider); // 关闭浏览器
  return { ok: true, state: 'success', saved: Object.keys(fields), fields };
}

/** 手机验证码：输入到登录页当前输入框（尽力而为） */
export async function submitSms(provider, code) {
  const s = sessions.get(provider);
  if (!s) throw new Error('登录会话不存在或已结束');
  const input = s.page.locator('input').last();
  await input.fill(String(code));
  await s.page.keyboard.press('Enter');
  return { ok: true };
}

/** 官网登录页（前端点击未登录时新标签页跳转） */
export const LOGIN_URLS = {
  ark: 'https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan',
  zhipu: 'https://bigmodel.cn/coding-plan/personal/usage',
  minimax: 'https://platform.minimaxi.com/console/usage',
};

/**
 * 一键自动登录：读取本机 Chrome/Edge 已登录会话（零交互）。
 * 会尝试真实配置；被 Chrome 运行占用时复制 cookie 文件到临时配置再读。
 * 返回提交的字段；失败抛错。
 */
/**
 * 通过 Chrome DevTools 协议连接「正在运行的 Chrome」，读取已解密的会话。
 * 这是唯一可靠的方式：Linux 下 Chrome 用系统钥匙串（v11）加密 cookie，
 * 离线读加密文件（headless/复制 profile）解不出明文；连接运行中的浏览器则直接拿到明文。
 */
async function cdpLogin(provider) {
  const target = TARGETS[provider];
  if (!target) throw new Error(`不支持的登录平台: ${provider}`);
  const port = Number(process.env.CHROME_DEBUG_PORT || 9222);

  let browser;
  try {
    const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
    if (!ver.webSocketDebuggerUrl) throw new Error('no ws endpoint');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  } catch (e) {
    throw new Error(
      `未检测到 Chrome 调试端口 ${port}。请完全退出 Chrome 后用以下命令重启（一次性）：\n` +
        `google-chrome --remote-debugging-port=${port}\n` +
        `（或设 CHROME_DEBUG_PORT 环境变量改用其它端口）`
    );
  }

  const ctx = browser.contexts()[0];
  const captured = {};
  // 只对本次新建的页面做请求拦截（抓智谱 JWT / 方舟 CSRF、WebId）
  const page = await ctx.newPage();
  page.on('request', (req) => {
    try {
      const url = req.url();
      const h = req.headers();
      if (target.authHeaderUrl && url.includes(target.authHeaderUrl) && !captured.authHeader) {
        const a = h['authorization'];
        if (a && a.length > 40) captured.authHeader = a;
      }
      if (provider === 'ark' && url.includes('console.volcengine.com') && !captured.csrfToken) {
        const ct = h['x-csrf-token'] || h['csrf-token'];
        if (ct && ct.length > 8) captured.csrfToken = ct;
      }
      if (provider === 'ark' && url.includes('console.volcengine.com/api/top') && !captured.webId) {
        const wid = h['x-web-id'];
        if (wid && wid.length > 20) captured.webId = wid;
      }
    } catch {
      /* ignore */
    }
  });

  // 打开目标页：触发登录态检测 + 请求拦截
  try {
    await page.goto(target.afterUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch {
    /* ignore */
  }
  await sleep(2000);

  const cookies = await ctx.cookies();
  const names = cookies.map((c) => c.name);
  const cookieOk = target.successCookies ? target.successCookies.some((n) => names.includes(n)) : false;
  const jwtOk = !!(target.authHeaderUrl && captured.authHeader);
  if (!cookieOk && !jwtOk) {
    await page.close().catch(() => {});
    throw new Error('该平台尚未登录：请先在 Chrome 中打开官网完成登录，再点「我已授权 · 保存会话」');
  }

  // 组装会话字段
  const filtered = cookies.filter((c) => target.cookieDomains.some((d) => c.domain.endsWith(d)));
  captured.cookie = filtered.map((c) => `${c.name}=${c.value}`).join('; ');
  if (provider === 'ark' && !captured.csrfToken) {
    const ct = cookies.find((c) => c.name === 'csrfToken');
    if (ct) captured.csrfToken = ct.value;
  }
  if (provider === 'ark' && !captured.webId) {
    const w = cookies.find((c) => c.name === 's_v_web_id' || c.name === 'monitor_huoshan_web_id');
    if (w) captured.webId = w.value;
  }
  if (provider === 'minimax' && !captured.groupId) {
    const g = cookies.find((c) => c.name === 'minimax_group_id_v2');
    if (g) captured.groupId = g.value;
  }

  await page.close().catch(() => {});
  // 注意：不要调用 browser.close()——connectOverCDP 会真正关闭浏览器进程；
  // 仅关闭本次新建的页面，CDP 连接随 server 进程生命周期回收。

  const fields = target.save(captured);
  const file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  file.providers = file.providers || {};
  file.providers[provider] = { ...(file.providers[provider] || {}), ...fields };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + '\n');
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* ignore */
  }
  return { ok: true, saved: Object.keys(fields) };
}

export async function autoLogin(provider, publicDir) {
  if (!TARGETS[provider]) throw new Error(`不支持的登录平台: ${provider}`);
  return await cdpLogin(provider);
}

/** 取消登录并关闭浏览器 */
export function cancelLogin(provider) {
  const s = sessions.get(provider);
  if (s) {
    try {
      if (s.browser) s.browser.close();
      else s.context.close();
    } catch {
      /* ignore */
    }
    sessions.delete(provider);
  }
  return { ok: true };
}

/** 停止所有登录会话（服务退出时调用） */
export function cancelAll() {
  for (const k of [...sessions.keys()]) cancelLogin(k);
}
