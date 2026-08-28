// AI 套餐看板 · 会话同步（background service worker）
// 读 cookie 用 chrome.cookies API（能读 httpOnly）；方舟的 userInfo/digest 是「分区 cookie」，
// 必须显式用 partitionKey 读取。智谱的 JWT 在请求头，用 webRequest 拦截。
// 触发：登录时 cookie 变化自动触发；也可在 options 点「立即同步」手动触发。

const SYNC_INTERVAL_MS = 10 * 60 * 1000; // 同平台 10 分钟内去重
const pending = new Set(); // 并发去重

async function getConfig() {
  const cfg = await chrome.storage.local.get(['dashboard', 'token', 'lastSync']);
  return {
    dashboard: (cfg.dashboard || '').trim().replace(/\/+$/, ''),
    token: (cfg.token || '').trim(),
    lastSync: cfg.lastSync || {},
  };
}

async function push(providerId, fields, force = false) {
  const cfg = await getConfig();
  if (!cfg.dashboard) return;

  const last = cfg.lastSync[providerId] || 0;
  if (!force && (Date.now() - last < SYNC_INTERVAL_MS || pending.has(providerId))) return;

  pending.add(providerId);
  cfg.lastSync[providerId] = Date.now();
  await chrome.storage.local.set({ lastSync: cfg.lastSync });

  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;

  try {
    const res = await fetch(cfg.dashboard + '/api/auth/update', {
      method: 'POST',
      headers,
      body: JSON.stringify({ providerId, fields }),
    });
    const j = await res.json().catch(() => ({}));
    if (j.ok) console.log(`[会话同步] ${providerId} 已推送（${Object.keys(fields).join(', ')}）`);
    else console.warn(`[会话同步] ${providerId} 推送被拒：${j.error || 'HTTP ' + res.status}`);
  } catch (e) {
    console.error(`[会话同步] ${providerId} 推送失败：`, e.message);
  } finally {
    pending.delete(providerId);
  }
}

/** 读某域名后缀的所有 cookie（非分区 + 指定 partitionKey 的分区），按 name+domain+path 去重 */
async function allCookiesFor(domainSuffix, partitionSites = []) {
  const list = [];
  const push = (arr) => {
    for (const c of arr) if (c.domain.endsWith(domainSuffix)) list.push(c);
  };
  push(await chrome.cookies.getAll({}));
  for (const site of partitionSites) {
    try {
      push(await chrome.cookies.getAll({ partitionKey: { topLevelSite: site } }));
    } catch {
      /* 该分区不存在则忽略 */
    }
  }
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const k = c.domain + '|' + c.name + '|' + c.path;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out;
}

/** 方舟：cookie → sessionCookie + csrfToken + webId（userInfo/digest 是分区 cookie，需显式读） */
async function syncArk(force = false) {
  const list = await allCookiesFor('volcengine.com', ['https://volcengine.com', 'https://console.volcengine.com']);
  const fields = { sessionCookie: list.map((c) => `${c.name}=${c.value}`).join('; ') };
  const csrf = list.find((c) => c.name === 'csrfToken');
  if (csrf) fields.csrfToken = csrf.value;
  const webId = list.find((c) => c.name === 's_v_web_id' || c.name === 'monitor_huoshan_web_id');
  if (webId) fields.webId = webId.value;
  await push('ark', fields, force);
}

/** MiniMax：cookie → sessionCookie + groupId（非分区，直接读） */
async function syncMinimax(force = false) {
  const list = await allCookiesFor('minimaxi.com');
  const fields = { sessionCookie: list.map((c) => `${c.name}=${c.value}`).join('; ') };
  const g = list.find((c) => c.name === 'minimax_group_id_v2');
  if (g) fields.groupId = g.value;
  await push('minimax', fields, force);
}

// 1) cookie 变化：方舟 / MiniMax 登录时触发自动同步
chrome.cookies.onChanged.addListener((info) => {
  const { cookie, removed } = info;
  if (removed) return;
  if (cookie.domain.endsWith('volcengine.com') && ['userInfo', 'digest'].includes(cookie.name)) syncArk();
  if (cookie.domain.endsWith('minimaxi.com') && cookie.name === '_token') syncMinimax();
});

// 2) webRequest：智谱登录后访问 coding plan 页面，API 请求头带 authorization JWT
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const auth = (details.requestHeaders || []).find((h) => h.name.toLowerCase() === 'authorization');
    if (auth && auth.value && auth.value.length > 40) {
      push('zhipu', { sessionToken: auth.value.replace(/^Bearer\s+/i, '') });
    }
  },
  { urls: ['*://open.bigmodel.cn/api/*', '*://bigmodel.cn/api/*'] },
  ['requestHeaders']
);

// 3) 「立即同步」：直接读 cookie 推方舟/MiniMax；智谱需打开页面触发 JWT 拦截
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'sync-all') {
    Promise.all([syncArk(true), syncMinimax(true)])
      .then(() => {
        chrome.tabs.create({ url: 'https://open.bigmodel.cn/coding-plan/personal/overview', active: false });
        sendResponse({ ok: true });
      })
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
});
