// AI 套餐看板 · 会话同步（background service worker）
// 监听本机浏览器里的登录态，自动把会话推送到云端 dashboard 的 /api/auth/update。
// 无需用户操作：登录平台 → 扩展自动抓会话 → 自动推送。

const SYNC_INTERVAL_MS = 10 * 60 * 1000; // 同平台 10 分钟内不重复推

async function getConfig() {
  const cfg = await chrome.storage.local.get(['dashboard', 'token', 'lastSync']);
  return {
    dashboard: (cfg.dashboard || '').trim().replace(/\/+$/, ''),
    token: (cfg.token || '').trim(),
    lastSync: cfg.lastSync || {},
  };
}

/** 推送某平台的会话字段到云端（带节流 + token 鉴权） */
async function push(providerId, fields, force = false) {
  const cfg = await getConfig();
  if (!cfg.dashboard) return; // 未配置云端地址

  const last = cfg.lastSync[providerId] || 0;
  if (!force && Date.now() - last < SYNC_INTERVAL_MS) return; // 节流，避免频繁推送

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
    if (j.ok) {
      console.log(`[会话同步] ${providerId} 已推送云端（${Object.keys(fields).join(', ')}）`);
    } else {
      console.warn(`[会话同步] ${providerId} 推送被拒：${j.error || 'HTTP ' + res.status}`);
    }
  } catch (e) {
    console.error(`[会话同步] ${providerId} 推送失败：`, e.message);
  }
}

/** 抓 cookie：返回 { domain 匹配的 cookie 拼接, 单个 cookie 查找 } */
async function cookiesFor(domainSuffix) {
  const all = await chrome.cookies.getAll({});
  return {
    list: all.filter((c) => c.domain.endsWith(domainSuffix)),
    find: (name) => all.find((c) => c.domain.endsWith(domainSuffix) && c.name === name),
  };
}

/** 方舟：cookie → sessionCookie + csrfToken + webId */
async function syncArk(force = false) {
  const c = await cookiesFor('volcengine.com');
  const fields = { sessionCookie: c.list.map((x) => `${x.name}=${x.value}`).join('; ') };
  const csrf = c.find('csrfToken');
  if (csrf) fields.csrfToken = csrf.value;
  const webId = c.find('s_v_web_id') || c.find('monitor_huoshan_web_id');
  if (webId) fields.webId = webId.value;
  await push('ark', fields, force);
}

/** MiniMax：cookie → sessionCookie + groupId */
async function syncMinimax(force = false) {
  const c = await cookiesFor('minimaxi.com');
  const fields = { sessionCookie: c.list.map((x) => `${x.name}=${x.value}`).join('; ') };
  const g = c.find('minimax_group_id_v2');
  if (g) fields.groupId = g.value;
  await push('minimax', fields, force);
}

/** 智谱：JWT（请求头 authorization）→ sessionToken */
async function syncZhipu(jwt) {
  await push('zhipu', { sessionToken: jwt });
}

// 1) 监听 cookie 变化：方舟 / MiniMax 登录时会写入 userInfo / digest / _token
chrome.cookies.onChanged.addListener((info) => {
  const { cookie, removed } = info;
  if (removed) return;
  if (cookie.domain.endsWith('volcengine.com') && ['userInfo', 'digest'].includes(cookie.name)) {
    syncArk();
  }
  if (cookie.domain.endsWith('minimaxi.com') && cookie.name === '_token') {
    syncMinimax();
  }
});

// 2) 监听请求头：智谱登录后访问 coding plan 页面会带 authorization JWT
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const auth = (details.requestHeaders || []).find((h) => h.name.toLowerCase() === 'authorization');
    if (auth && auth.value && auth.value.length > 40) {
      syncZhipu(auth.value.replace(/^Bearer\s+/i, ''));
    }
  },
  { urls: ['*://open.bigmodel.cn/api/*', '*://bigmodel.cn/api/*'] },
  ['requestHeaders']
);

// 3) 响应 options 页面的「立即同步」按钮
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'sync-all') {
    Promise.all([syncArk(true), syncMinimax(true)])
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // 异步响应
  }
});
