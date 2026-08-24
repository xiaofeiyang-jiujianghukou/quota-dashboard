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

/** 用系统已安装的浏览器启动（Chrome → Edge → Chromium；不下载任何浏览器） */
async function launchBrowser() {
  const channels = ['chrome', 'msedge', 'chromium'];
  let lastErr = null;
  for (const channel of channels) {
    try {
      return await chromium.launch({
        channel,
        headless: false,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
      });
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error('未找到本机浏览器（Chrome/Edge/Chromium）。Docker 部署请在宿主机运行：node login-helper.mjs --provider <ark|zhipu|minimax>');
}

/** 启动登录：打开本机浏览器登录页（真实窗口），返回会话截图 URL */
export async function startLogin(provider, publicDir) {
  const target = TARGETS[provider];
  if (!target) throw new Error(`不支持的登录平台: ${provider}`);
  if (sessions.has(provider)) cancelLogin(provider); // 同平台重复登录先关旧的

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 960, height: 720 }, locale: 'zh-CN' });
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
  sessions.set(provider, { browser, context, page, target, captured, provider });

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

/** 取消登录并关闭浏览器 */
export function cancelLogin(provider) {
  const s = sessions.get(provider);
  if (s) {
    try {
      s.browser.close();
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
