// 本机浏览器自动登录（Playwright 驱动系统 Chrome/Edge，不打包浏览器）
// 流程：点「未登录」→ 打开本机默认浏览器登录页（真实窗口，扫码/验证码照常）→
//       检测到登录后自动抓取会话凭据 → 写入 config.json（或由 login-helper 提交给看板）
// 支持：方舟(控制台 cookie+csrf+webid)、智谱(会话 JWT)、MiniMax(控制台 cookie)
// 注意：容器内无系统浏览器，Docker 部署请用宿主机运行 login-helper.mjs
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config.js';
import { ROOT_DIR } from './config.paths.js';
import { setCredentials } from './store.js';
import { clearLoginCache } from './auth.js';

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
    authHeaderUrl: 'open.bigmodel.cn/api', // 放宽：控制台任意 API 调用都带会话令牌
    successCookies: ['bigmodel_token_production'], // 登录后必种的会话 Cookie（更可靠）
    cookieDomains: ['bigmodel.cn'], // 抓整包 Cookie（会话通道需要）
    save(cap) {
      const out = {};
      if (cap.authHeader) out.sessionToken = String(cap.authHeader).replace(/^Bearer\s+/i, '');
      if (cap.cookie) out.sessionCookie = cap.cookie;
      return out;
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
  deepseek: {
    name: 'DeepSeek',
    startUrl: 'https://platform.deepseek.com/sign_in',
    afterUrl: 'https://platform.deepseek.com/usage',
    authHeaderUrl: 'platform.deepseek.com/api',
    cookieDomains: ['deepseek.com'],
    successCookies: ['ds_session_id', 'intercom-session', 'HWWAFSESID', 'HWWAFSESTIME'],
    // 登录后尽力从控制台读回 API Key（DeepSeek 余额接口只认 sk-，控制台是唯一来源）
    async enrich(page, cap) {
      if (cap.apiKey) return;
      const findKeys = async () => {
        try {
          return await page.evaluate(async () => {
            const hits = new Set();
            const grab = (s) => {
              for (const m of String(s || '').matchAll(/sk-[A-Za-z0-9_-]{20,}/g)) hits.add(m[0]);
            };
            grab(document.body ? document.body.innerText : '');
            grab(document.documentElement ? document.documentElement.innerHTML : '');
            for (const p of ['/api/v0/users/get_api_keys', '/api/v0/users/api_keys', '/api/v0/users/get_keys']) {
              try {
                const r = await fetch(p, { credentials: 'include' });
                if (r.ok) grab(JSON.stringify(await r.json()));
              } catch { /* 逐个尝试 */ }
            }
            return [...hits].find((k) => k.startsWith('sk-')) || '';
          });
        } catch {
          return '';
        }
      };
      try {
        await page.goto('https://platform.deepseek.com/api_keys', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await sleep(2500);
        let k = await findKeys();
        if (!k) {
          await sleep(2500);
          k = await findKeys();
        }
        if (k) cap.apiKey = k;
      } catch {
        /* 拿不到 Key 不阻塞：会话凭据仍然有效，Key 可在配置页手动粘贴 */
      }
      // 从 localStorage 兜底取会话 JWT
      if (!cap.authHeader) {
        try {
          const jwt = await page.evaluate(() => {
            for (const k of Object.keys(localStorage)) {
              const v = localStorage.getItem(k) || '';
              const m = v.match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
              if (m) return m[0];
            }
            return '';
          });
          if (jwt) cap.authHeader = jwt;
        } catch { /* ignore */ }
      }
    },
    save(cap) {
      const out = {};
      if (cap.authHeader) out.sessionToken = String(cap.authHeader).replace(/^Bearer\s+/i, '');
      if (cap.cookie) out.sessionCookie = cap.cookie;
      if (cap.apiKey) out.apiKey = cap.apiKey;
      return out;
    },
  },
};

/** 本机浏览器配置目录（Chrome / Chromium / Edge） */
const BROWSER_ROOTS = [
  { name: 'Chrome', root: path.join(os.homedir(), '.config', 'google-chrome') },
  { name: 'Chromium', root: path.join(os.homedir(), '.config', 'chromium') },
  { name: 'Edge', root: path.join(os.homedir(), '.config', 'microsoft-edge') },
];

/** 找出各浏览器里"最近使用"的配置（Default / Profile N），按 Cookies 修改时间排序 */
export function listBrowserProfiles() {
  const out = [];
  for (const { name, root } of BROWSER_ROOTS) {
    let subs = [];
    try {
      subs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      continue;
    }
    for (const sub of subs) {
      if (sub !== 'Default' && !/^Profile \d+$/.test(sub)) continue;
      const dir = path.join(root, sub);
      for (const rel of ['Cookies', 'Network/Cookies']) {
        const p = path.join(dir, rel);
        try {
          out.push({ browser: name, profile: sub, dir, cookiesPath: p, mtimeMs: fs.statSync(p).mtimeMs });
          break;
        } catch {
          /* 该 profile 没有 Cookies */
        }
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 把浏览器配置里"读取登录态所需"的文件复制到目标目录（同时写根与 Default/，兼容不同 Chrome 布局） */
function copyProfileForImport(srcDir, destDir) {
  const targets = [destDir, path.join(destDir, 'Default')];
  for (const t of targets) fs.mkdirSync(t, { recursive: true });
  const files = ['Cookies', 'Cookies-journal', 'Preferences', 'Secure Preferences', 'Login Data'];
  for (const f of files) {
    const from = path.join(srcDir, f);
    if (!fs.existsSync(from)) continue;
    for (const t of targets) {
      try {
        fs.copyFileSync(from, path.join(t, f));
      } catch {
        /* ignore */
      }
    }
  }
  // 新版 Chrome 把 Cookies 放在 Network 子目录
  const netSrc = path.join(srcDir, 'Network');
  if (fs.existsSync(netSrc)) {
    for (const t of targets) {
      const netDst = path.join(t, 'Network');
      fs.mkdirSync(netDst, { recursive: true });
      for (const f of ['Cookies', 'Cookies-journal']) {
        try {
          if (fs.existsSync(path.join(netSrc, f))) fs.copyFileSync(path.join(netSrc, f), path.join(netDst, f));
        } catch {
          /* ignore */
        }
      }
    }
  }
  // localStorage（会话 JWT 常放这里）
  const lsSrc = path.join(srcDir, 'Local Storage');
  if (fs.existsSync(lsSrc)) {
    for (const t of targets) {
      try {
        fs.cpSync(lsSrc, path.join(t, 'Local Storage'), { recursive: true });
      } catch {
        /* ignore */
      }
    }
  }
  // Linux 上加密密钥来自系统钥匙串，Local State 一并带上更保险
  const localState = path.join(path.dirname(srcDir), 'Local State');
  try {
    if (fs.existsSync(localState)) fs.copyFileSync(localState, path.join(destDir, 'Local State'));
  } catch {
    /* ignore */
  }
}

/**
 * 打开授权窗口前，把日常浏览器（Chrome/Edge，取最近使用的）的登录态同步到授权配置目录。
 * 这样"我已经登录了"时，授权窗口打开即已登录 → 直接授权成功。
 * 仅当日常浏览器的 Cookies 比授权目录里的更新时才覆盖，避免抹掉授权窗口里刚登录的会话。
 */
/**
 * 直接用「当前浏览器已登录的会话」完成授权：复制配置副本 → 无头启动 → 读取 cookie/localStorage。
 * 不弹任何窗口，也不需要重新登录（前提：你日常浏览器里已登录该平台）。
 */
export async function importFromBrowser(provider, opts = {}) {
  const type = loadConfig().providers[provider]?.type || provider;
  const target = TARGETS[type];
  if (!target) throw new Error(`不支持的平台: ${type}`);

  const all = listBrowserProfiles();
  const profiles = opts.sourceProfile
    ? all.filter((p) => p.dir === opts.sourceProfile)
    : all;
  if (!profiles.length) throw new Error('没找到本机 Chrome/Chromium/Edge 配置目录');

  let lastErr = null;
  for (const prof of profiles) {
    try {
      return await tryImport(provider, type, target, prof);
    } catch (e) {
      lastErr = e; // 换下一个浏览器配置继续试（例如 Chrome 没登录但 Edge 登录了）
    }
  }
  throw lastErr || new Error('导入失败');
}

/** 从指定浏览器配置导入一次 */
async function tryImport(provider, type, target, prof) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-import-'));
  copyProfileForImport(prof.dir, tmpDir);

  const captured = {};
  let context;
  try {
    context = await chromium.launchPersistentContext(tmpDir, {
      channel: 'chrome',
      headless: true,
      viewport: { width: 1280, height: 800 },
      locale: 'zh-CN',
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const page = context.pages()[0] || (await context.newPage());
    page.on('request', (req) => {
      try {
        const url = req.url();
        const h = req.headers();
        if (target.authHeaderUrl && url.includes(target.authHeaderUrl) && !captured.authHeader) {
          const a = h['authorization'];
          if (a && a.length > 40) captured.authHeader = a;
        }
        if (type === 'ark' && url.includes('console.volcengine.com') && !captured.csrfToken) {
          const ct = h['x-csrf-token'] || h['csrf-token'];
          if (ct && ct.length > 8) captured.csrfToken = ct;
        }
      } catch {
        /* ignore */
      }
    });

    await page.goto(target.afterUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(4000);

    // 整包 Cookie（按域名）
    const cookies = await context.cookies();
    const names = cookies.map((c) => c.name);
    if (target.cookieDomains) {
      const filtered = cookies.filter((c) => target.cookieDomains.some((d) => c.domain.endsWith(d)));
      captured.cookie = filtered.map((c) => `${c.name}=${c.value}`).join('; ');
    }
    if (type === 'minimax' && !captured.groupId) {
      const g = cookies.find((c) => c.name === 'minimax_group_id_v2');
      if (g) captured.groupId = g.value;
    }
    if (type === 'ark' && !captured.csrfToken) {
      const ct = cookies.find((c) => c.name === 'csrfToken');
      if (ct) captured.csrfToken = ct.value;
    }
    // localStorage 里的会话 JWT 兜底
    if (!captured.authHeader) {
      try {
        const jwt = await page.evaluate(() => {
          for (const k of Object.keys(localStorage)) {
            const m = (localStorage.getItem(k) || '').match(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/);
            if (m) return m[0];
          }
          return '';
        });
        if (jwt) captured.authHeader = jwt;
      } catch {
        /* ignore */
      }
    }
    if (target.enrich) {
      try {
        await target.enrich(page, captured);
      } catch {
        /* ignore */
      }
    }

    const cookieOk = !!(captured.cookie && captured.cookie.length > 20);
    const jwtOk = !!captured.authHeader || !!captured.apiKey;
    if (!cookieOk && !jwtOk) {
      throw new Error(`当前浏览器里没有「${target.name}」的登录状态：请先用日常浏览器打开并登录 ${target.afterUrl}，再点此导入`);
    }
    const fields = target.save(captured);
    const saved = Object.keys(fields).filter((k) => fields[k]);
    if (!saved.length) throw new Error('未能从当前浏览器提取到有效凭据');
    // 注意：这里只返回候选凭据，不落库。上层会用真实采集试一次，通过才保存，
    // 避免用浏览器里"残留但已失效"的会话覆盖掉当前可用的凭据。
    return { ok: true, saved, browser: prof.browser, profile: prof.profile, fields };
  } finally {
    try {
      if (context) await context.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * 每个实例独立的授权浏览器配置目录：data/chrome-profile/<实例id>
 * 原因：同一平台可以有多个账号实例，共用一个浏览器会互相串号（第二个账号授权时抓到第一个账号的登录态）。
 * 首次使用时，如果旧的"共用配置"存在，则继承一份，避免已有登录态失效。
 */
export function ensureInstanceProfile(providerId) {
  const explicit = process.env.QUOTA_CHROME_PROFILE;
  if (explicit) return explicit; // 显式指定就所有实例共用（高级用法）
  const base = path.join(ROOT_DIR, 'data', 'chrome-profile');
  const dir = path.join(base, providerId);
  if (fs.existsSync(dir)) return dir;

  // 是否已有"同类型的其它实例"用着独立配置？有的话说明这是第二个账号，
  // 必须用全新的空配置（否则会继承到第一个账号的登录，导致串号）。
  let sameTypeExists = false;
  try {
    const cfg = loadConfig();
    const mine = cfg.providers?.[providerId]?.type || providerId;
    sameTypeExists = Object.entries(cfg.providers || {}).some(
      ([pid, pc]) => pid !== providerId && (pc.type || pid) === mine && fs.existsSync(path.join(base, pid))
    );
  } catch {
    /* ignore */
  }

  const legacy = path.join(base, 'Default');
  if (!sameTypeExists && fs.existsSync(legacy)) {
    try {
      copyProfileForImport(base, dir); // 首个实例：继承原共用登录态，免去重新登录
      console.log(`[login] 已为实例 ${providerId} 建立独立授权配置（继承原共用登录态）`);
      return dir;
    } catch {
      /* 落到下面建空目录 */
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  if (sameTypeExists) console.log(`[login] 实例 ${providerId} 使用全新独立授权配置（同类型已有其它账号，不继承登录态）`);
  return dir;
}

/**
 * 用已保存的浏览器配置静默续期控制台会话凭据（不弹窗）：
 * 火山 CSRF / 智谱 JWT 这类令牌几小时就轮换，过期后自动重新抓一份，避免用户反复手动授权。
 * 返回新抓到的字段（csrfToken / sessionToken / sessionCookie），并已写入 SQLite。
 */
export async function refreshConsoleAuth(providerId) {
  const cfg = loadConfig();
  const type = cfg.providers?.[providerId]?.type || providerId;
  const target = TARGETS[type];
  if (!target) throw new Error(`不支持的平台: ${type}`);
  const profileDir = ensureInstanceProfile(providerId);
  if (!fs.existsSync(profileDir)) throw new Error('授权配置目录不存在（需先授权登录一次）');

  const captured = {};
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const page = context.pages()[0] || (await context.newPage());
    page.on('request', (req) => {
      try {
        const u = req.url();
        const h = req.headers();
        if (type === 'ark' && u.includes('console.volcengine.com')) {
          const ct = h['x-csrf-token'] || h['csrf-token'];
          if (ct && ct.length > 8) captured.csrfToken = ct;
        }
        if (target.authHeaderUrl && u.includes(target.authHeaderUrl)) {
          const a = h['authorization'];
          if (a && a.length > 40) captured.authHeader = a;
        }
      } catch {
        /* ignore */
      }
    });
    await page.goto(target.afterUrl, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    // 等页面自己发出带令牌的请求（最多约 10 秒）
    for (let i = 0; i < 20 && !captured.csrfToken && !captured.authHeader; i++) await sleep(500);

    const cookies = await context.cookies();
    const jar = cookies
      .filter((c) => (target.cookieDomains || []).some((d) => String(c.domain || '').replace(/^\./, '').endsWith(d)))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    const fields = {};
    if (captured.csrfToken) fields.csrfToken = captured.csrfToken;
    if (captured.authHeader) fields.sessionToken = String(captured.authHeader).replace(/^Bearer\s+/i, '');
    if (jar) fields.sessionCookie = jar;
    if (Object.keys(fields).length) {
      setCredentials(providerId, fields);
      clearLoginCache(providerId);
      console.log(`[login] 已自动续期 ${providerId} 的控制台凭据: ${Object.keys(fields).join(', ')}`);
    }
    return { ok: Object.keys(fields).length > 0, ...fields };
  } finally {
    try {
      if (context) await context.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 退出某平台在「授权浏览器配置」里的登录：清掉该域名的 Cookie 与 localStorage。
 * 「取消授权」时调用，确保下次授权需要重新登录（真正取消，而不是只删库里的凭据）。
 */
export async function clearPlatformLogin(provider, opts = {}) {
  const type = loadConfig().providers[provider]?.type || provider;
  const target = TARGETS[type];
  if (!target) throw new Error(`不支持的平台: ${type}`);
  const profileDir = opts.profileDir || process.env.QUOTA_CHROME_PROFILE || path.join(ROOT_DIR, 'data', 'chrome-profile');
  if (!fs.existsSync(profileDir)) return { ok: true, skipped: '授权配置目录不存在' };

  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      channel: 'chrome',
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    // 1) 先清站点存储（会话 JWT 常在 localStorage；这一步会导航，所以放在清 Cookie 之前）
    const page = context.pages()[0] || (await context.newPage());
    try {
      await page.goto(target.afterUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* 打不开页面也要继续清 Cookie */
    }
    // 2) 最后清该平台域名的 Cookie（Playwright 的 domain 过滤是精确匹配，这里按后缀筛出后逐条删）
    const all = await context.cookies();
    const doomed = all.filter((c) => {
      const host = String(c.domain || '').replace(/^\./, '');
      return (target.cookieDomains || []).some((d) => host === d || host.endsWith('.' + d) || host.endsWith(d));
    });
    for (const c of doomed) {
      try {
        await context.clearCookies({ name: c.name, domain: c.domain, path: c.path });
      } catch {
        /* 单条失败继续 */
      }
    }
    const left = (await context.cookies()).filter((c) => {
      const host = String(c.domain || '').replace(/^\./, '');
      return (target.cookieDomains || []).some((d) => host === d || host.endsWith('.' + d) || host.endsWith(d));
    });
    return { ok: true, cleared: doomed.length, remaining: left.length };
  } finally {
    try {
      if (context) await context.close();
    } catch {
      /* ignore */
    }
  }
}

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
  // 持久化配置目录：登录态（含用 Google 登录）长期保存在本地，下次授权直接复用，通常无需再登录
  if (opts.profileDir) {
    // 持久化授权配置：这个窗口里登录过一次就长期记住，后续授权无需再登录
    const persistent = await chromium.launchPersistentContext(opts.profileDir, {
      channel: 'chrome',
      headless: false,
      viewport: { width: 720, height: 880 },
      deviceScaleFactor: 1.5,
      locale: 'zh-CN',
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    return { persistent: true, context: persistent, browser: null, profileDir: true };
  }
  // 面板内授权（Docker）：用镜像自带的 headless chromium，登录页以实时截图呈现
  if (opts.mode === 'container' || process.env.QUOTA_LOGIN_MODE === 'container') {
    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
    });
    return { persistent: false, browser, context: null, container: true };
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
  throw new Error('未找到本机浏览器（Chrome/Edge/Chromium），请先安装 Chrome 后重试');
}

/** 启动登录：profile 模式读取本机已登录会话；否则打开真实浏览器窗口，返回会话截图 URL */
export async function startLogin(provider, publicDir, opts = {}) {
  const type = loadConfig().providers[provider]?.type || provider;
  const target = TARGETS[type];
  if (!target) throw new Error(`不支持的登录平台: ${type}`);
  if (sessions.has(provider)) cancelLogin(provider); // 同平台重复登录先关旧的

  const launched = await launchBrowser(opts);
  const scale = launched.container || launched.profileDir ? 1.5 : 1;
  const context = launched.persistent
    ? launched.context
    : await launched.browser.newContext({
        viewport: launched.container ? { width: 720, height: 880 } : { width: 960, height: 720 },
        deviceScaleFactor: scale,
        locale: 'zh-CN',
      });
  // 持久化配置会自带一个空白页，直接复用，避免多开窗口
  const page = launched.profileDir && context.pages().length ? context.pages()[0] : await context.newPage();
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
      if (type === 'ark' && url.includes('console.volcengine.com/api/top') && !captured.webId) {
        const wid = h['x-web-id'];
        if (wid && wid.length > 20) captured.webId = wid;
      }
      if (type === 'ark' && url.includes('console.volcengine.com')) {
        const ct = h['x-csrf-token'] || h['csrf-token'];
        if (ct && ct.length > 8) captured.csrfToken = ct; // 始终保留最新（登录后 token 会更新）
      }
    } catch {
      /* ignore */
    }
  });

  await page.goto(target.startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  sessions.set(provider, { browser: launched.browser || null, context, page, target, captured, provider, publicDir, scale, container: !!launched.container, persistentProfile: !!launched.profileDir, interactive: !!opts.mode, noShot: !!opts.noShot, type });

  // 截图（登录页/二维码）
  await sleep(2500);
  await captureShot(provider, publicDir);
  return { ok: true, sessionId: provider, qrUrl: `/login-${provider}.png` };
}

/** 截图坐标 → 页面坐标（截图按 deviceScaleFactor 放大，需还原） */
function toPageCoords(s, x, y) {
  const scale = s.scale || 1;
  return { x: Math.round(Number(x) / scale), y: Math.round(Number(y) / scale) };
}

/** 在登录页对应位置点击（截图里看到的坐标） */
export async function loginClick(provider, x, y) {
  const s = sessions.get(provider);
  if (!s) throw new Error('授权会话不存在或已结束');
  const p = toPageCoords(s, x, y);
  await s.page.mouse.click(p.x, p.y);
  await sleep(400);
  await captureShot(provider, s.publicDir);
  return { ok: true };
}

/** 向登录页输入文本（先点截图里的输入框定位焦点） */
export async function loginType(provider, text) {
  const s = sessions.get(provider);
  if (!s) throw new Error('授权会话不存在或已结束');
  await s.page.keyboard.type(String(text || ''), { delay: 35 });
  await captureShot(provider, s.publicDir);
  return { ok: true };
}

/** 向登录页发送按键（Enter / Tab / Backspace…） */
export async function loginKey(provider, key) {
  const s = sessions.get(provider);
  if (!s) throw new Error('授权会话不存在或已结束');
  const allow = ['Enter', 'Tab', 'Backspace', 'Escape', 'ArrowDown', 'ArrowUp'];
  if (!allow.includes(key)) throw new Error('不支持的按键: ' + key);
  await s.page.keyboard.press(key);
  await sleep(400);
  await captureShot(provider, s.publicDir);
  return { ok: true };
}

/** 当前是否有进行中的授权会话 */
export function loginSession(provider) {
  const s = sessions.get(provider);
  if (!s) return { active: false };
  return { active: true, container: !!s.container, url: s.page.url() };
}

async function captureShot(provider, publicDir) {
  const s = sessions.get(provider);
  if (!s || s.noShot) return;
  const p = path.join(publicDir, `login-${provider}.png`);
  await s.page.screenshot({ path: p }).catch(() => {});
}

/** 查询登录状态：检测到会话凭据即视为成功；默认写入配置（noSave=true 时只返回字段，由调用方提交） */
export async function loginStatus(provider, publicDir, opts = {}) {
  const s = sessions.get(provider);
  if (!s) return { ok: false, state: 'idle' };
  const { target, context, captured, page } = s;
  const type = s.type || loadConfig().providers[provider]?.type || provider;

  // 定期尝试跳转 afterUrl，触发目标 API 请求（如智谱 overview 页）
  // 容器模式：用户正在截图里操作登录页，不能替他跳走，等登录动作自己完成跳转
  if (!captured._navigatedAfter && !s.interactive) {
    captured._navigatedAfter = true;
    page.goto(target.afterUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }

  // 检测登录成功（严格判定：只看目标平台真正的会话标识，避免"任意 Cookie"误判导致窗口提前关闭）
  let success = false;
  try {
    const cookies = await context.cookies();
    const names = cookies.map((c) => c.name);
    if (target.successCookies && target.successCookies.length) {
      success = target.successCookies.some((n) => names.includes(n));
    }
    // 整包 Cookie（按域名）：每轮都刷新，登录后会新增会话 Cookie，只抓一次会拿到残缺集
    if (target.cookieDomains) {
      const filtered = cookies.filter((c) => target.cookieDomains.some((d) => c.domain.endsWith(d)));
      const jar = filtered.map((c) => `${c.name}=${c.value}`).join('; ');
      if (jar) captured.cookie = jar;
    }
    if (type === 'minimax' && !captured.groupId) {
      const g = cookies.find((c) => c.name === 'minimax_group_id_v2');
      if (g) captured.groupId = g.value;
    }
  } catch {
    /* ignore */
  }
  // JWT 类平台：抓到授权请求头即视为登录；控制台回读到 API Key 也算
  if (!success && target.authHeaderUrl && captured.authHeader) success = true;
  if (!success && captured.apiKey) success = true;

  // 方舟：CSRF 兜底（请求头抓不到时，从 Cookie 或页面里取最新值）
  if (type === 'ark') {
    try {
      const cookies = await context.cookies();
      const ctCookie = cookies.find((c) => c.name === 'csrfToken');
      if (ctCookie && ctCookie.value && ctCookie.value.length > 8) captured.csrfToken = ctCookie.value;
    } catch {
      /* ignore */
    }
    if (!captured.csrfToken) {
      try {
        const fromPage = await page.evaluate(() => {
          const m = String(document.cookie || '').match(/csrfToken=([^;]+)/);
          if (m) return m[1];
          const t = localStorage.getItem('csrfToken') || localStorage.getItem('x-csrf-token') || '';
          return t || '';
        });
        if (fromPage) captured.csrfToken = fromPage;
      } catch {
        /* ignore */
      }
    }
  }

  // 平台专属补充（如 DeepSeek 登录后回读控制台里的 API Key）
  if (success && typeof target.enrich === 'function') {
    try {
      await target.enrich(page, captured);
    } catch {
      /* 补抓失败不影响主流程 */
    }
  }

  // 关键：判定"成功"后还要过一道真实采集验证（由调用方提供），验证不过就继续等待，绝不关窗
  let verified = null;
  if (success && typeof opts.verify === 'function') {
    const fields = target.save(captured);
    if (Object.keys(fields).some((k) => fields[k])) {
      try {
        verified = await opts.verify(fields);
      } catch (e) {
        verified = { ok: false, error: e.message };
      }
      if (!verified || !verified.ok) {
        if (!captured._failSince) captured._failSince = Date.now();
        const waited = Date.now() - captured._failSince;
        if (waited < 45000) {
          // 会话可能还没建立完：保持窗口打开继续等
          if (!s.noShot) await captureShot(provider, s.publicDir);
          return { ok: false, state: 'waiting', trial: verified };
        }
        // 等太久仍取不到数据：照样保存凭据并明确上报（避免用户干等，也避免丢登录态）
        verified = { ...(verified || {}), ok: false, note: '已保存凭据，但采集未通过' };
      } else {
        captured._failSince = 0;
      }
    } else {
      success = false;
    }
  }

  if (!success) {
    // 每 3 秒刷新二维码截图，方便看最新状态
    await captureShot(provider, publicDir);
    return { ok: false, state: 'waiting' };
  }

  // 成功：凭据写入 SQLite（配置页在线管理）；noSave 模式由调用方（login-helper）提交
  const fields = target.save(captured);
  if (!opts.noSave && Object.keys(fields).some((k) => fields[k])) {
    setCredentials(provider, fields);
    clearLoginCache(provider);
  }
  cancelLogin(provider); // 关闭浏览器（仅在确认能取到数据后才关）
  return { ok: true, state: 'success', saved: Object.keys(fields), fields, verified };
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

/** 官网页面（cookie 平台=授权页；密钥平台=获取密钥页） */
export const LOGIN_URLS = {
  ark: 'https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan',
  zhipu: 'https://bigmodel.cn/coding-plan/personal/usage',
  minimax: 'https://platform.minimaxi.com/console/usage',
  deepseek: 'https://platform.deepseek.com/usage',
};

/**
 * 一键自动登录：读取本机 Chrome/Edge 已登录会话（零交互）。
 * 会尝试真实配置；被 Chrome 运行占用时复制 cookie 文件到临时配置再读。
 * 返回提交的字段；失败抛错。
 */
/**
 * 连接本机 Chrome 的调试端口（CDP）。
 */
async function connectCdp(port) {
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) })).json();
  if (!ver.webSocketDebuggerUrl) throw new Error('no ws endpoint');
  return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
}

/**
 * 自动启动一个带调试端口的浏览器副本（无需用户跑脚本）：
 * 复制日常浏览器的登录 cookie 到独立数据目录，用 --user-data-dir + 调试端口启动。
 * 主力平台用 Chrome、备用平台（方舟②/MiniMax）用 Edge。
 */
const BACKUP_BROWSER_PROVIDERS = new Set(['ark2', 'minimax']);
const BROWSERS = {
  chrome: {
    label: 'Chrome',
    bins: ['google-chrome', 'google-chrome-stable', 'chromium'],
    srcDir: '/.config/google-chrome',
    cacheName: 'chrome-debug',
    envPort: 'CHROME_DEBUG_PORT',
    defaultPort: 9222,
  },
  edge: {
    label: 'Edge',
    bins: ['microsoft-edge', 'microsoft-edge-stable', 'msedge'],
    srcDir: '/.config/microsoft-edge',
    cacheName: 'edge-debug',
    envPort: 'EDGE_DEBUG_PORT',
    defaultPort: 9223,
  },
};

function browserFor(provider) {
  return BACKUP_BROWSER_PROVIDERS.has(provider) ? BROWSERS.edge : BROWSERS.chrome;
}

async function launchDebugChrome(port, browser = BROWSERS.chrome) {
  const home = os.homedir();
  const src = home + browser.srcDir;
  const dst = process.env.CHROME_DEBUG_PROFILE
    ? `${process.env.CHROME_DEBUG_PROFILE}-${browser.cacheName}`
    : path.join(home, '.cache', 'quota-dashboard', browser.cacheName);
  fs.mkdirSync(path.join(dst, 'Default', 'Network'), { recursive: true });
  const files = [
    ['Local State', 'Local State'],
    [path.join('Default', 'Cookies'), path.join('Default', 'Cookies')],
    [path.join('Default', 'Network', 'Cookies'), path.join('Default', 'Network', 'Cookies')],
    [path.join('Default', 'Preferences'), path.join('Default', 'Preferences')],
    [path.join('Default', 'Secure Preferences'), path.join('Default', 'Secure Preferences')],
  ];
  for (const [s, d] of files) {
    try {
      if (fs.existsSync(path.join(src, s))) fs.copyFileSync(path.join(src, s), path.join(dst, d));
    } catch {
      /* ignore */
    }
  }
  const args = [
    `--user-data-dir=${dst}`,
    `--remote-debugging-port=${port}`,
    '--remote-allow-origins=*',
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  let lastErr = null;
  for (const bin of browser.bins) {
    try {
      const child = execFile(bin, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return bin;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`无法启动 ${browser.label}（尝试过：${browser.bins.join(' / ')}）${lastErr ? '：' + lastErr.message : ''}`);
}

/**
 * 通过 Chrome DevTools 协议连接「正在运行的 Chrome」，读取已解密的会话。
 * 这是唯一可靠的方式：Linux 下 Chrome 用系统钥匙串（v11）加密 cookie，
 * 离线读加密文件（headless/复制 profile）解不出明文；连接运行中的浏览器则直接拿到明文。
 */
async function cdpLogin(provider) {
  const type = loadConfig().providers[provider]?.type || provider;
  const target = TARGETS[type];
  if (!target) throw new Error(`不支持的登录平台: ${type}`);
  const browserCfg = browserFor(provider);
  const port = Number(process.env[browserCfg.envPort] || browserCfg.defaultPort);

  let browser;
  try {
    browser = await connectCdp(port);
  } catch (e) {
    // 调试端口未运行 → 自动用副本启动调试浏览器（主力 Chrome / 备用 Edge），再重试连接
    await launchDebugChrome(port, browserCfg);
    let connected = false;
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      try {
        browser = await connectCdp(port);
        connected = true;
        break;
      } catch {
        /* 继续等待 Chrome 就绪 */
      }
    }
    if (!connected) {
      throw new Error(
        `自动启动调试 ${browserCfg.label} 失败。请确认本机已安装 ${browserCfg.label}，且看板（node server.js）与浏览器在同一台机器上运行。`
      );
    }
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
      if (type === 'ark' && url.includes('console.volcengine.com')) {
        const ct = h['x-csrf-token'] || h['csrf-token'];
        if (ct && ct.length > 8) captured.csrfToken = ct; // 始终保留最新（登录后 token 会更新）
      }
      if (type === 'ark' && url.includes('console.volcengine.com/api/top') && !captured.webId) {
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
    throw new Error(`该平台尚未登录：请先在 ${browserCfg.label} 中打开官网完成登录，再点「我已授权 · 保存会话」`);
  }

  // 组装会话字段
  const filtered = target.cookieDomains
    ? cookies.filter((c) => target.cookieDomains.some((d) => c.domain.endsWith(d)))
    : [];
  captured.cookie = filtered.map((c) => `${c.name}=${c.value}`).join('; ');
  if (type === 'ark' && !captured.csrfToken) {
    const ct = cookies.find((c) => c.name === 'csrfToken');
    if (ct) captured.csrfToken = ct.value;
  }
  if (type === 'ark' && !captured.webId) {
    const w = cookies.find((c) => c.name === 's_v_web_id' || c.name === 'monitor_huoshan_web_id');
    if (w) captured.webId = w.value;
  }
  if (type === 'minimax' && !captured.groupId) {
    const g = cookies.find((c) => c.name === 'minimax_group_id_v2');
    if (g) captured.groupId = g.value;
  }

  await page.close().catch(() => {});
  // 注意：不要调用 browser.close()——connectOverCDP 会真正关闭浏览器进程；
  // 仅关闭本次新建的页面，CDP 连接随 server 进程生命周期回收。

  const fields = target.save(captured);
  // 凭据写入 SQLite（配置页在线管理），并立即失效登录态缓存，让卡片马上翻成已登录
  if (Object.keys(fields).some((k) => fields[k])) {
    setCredentials(provider, fields);
  }
  clearLoginCache(provider);
  return { ok: true, saved: Object.keys(fields) };
}

export async function autoLogin(provider, publicDir) {
  const type = loadConfig().providers[provider]?.type || provider;
  if (!TARGETS[type]) throw new Error(`不支持的登录平台: ${type}`);
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
