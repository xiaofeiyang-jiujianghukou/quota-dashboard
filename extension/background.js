// AI 套餐看板 · 会话同步（background service worker）
// 用 webRequest 拦截请求头，读取实际发送的完整 Cookie（含 httpOnly / 分区 cookie）
// 以及 x-csrf-token / x-web-id / authorization(JWT) / x-group-id，自动推送云端。
// 注意：不能用 chrome.cookies.getAll —— 它读不到「分区 cookie」（如方舟的 userInfo/digest）。

const SYNC_INTERVAL_MS = 10 * 60 * 1000; // 同平台 10 分钟内去重

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
  if (!force && Date.now() - last < SYNC_INTERVAL_MS) return;

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
  }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const headers = details.requestHeaders || [];
    const get = (name) => {
      const h = headers.find((x) => x.name.toLowerCase() === name.toLowerCase());
      return h ? h.value : '';
    };
    const url = details.url;

    // 方舟：控制台 API 请求 → 完整 cookie + csrfToken + webId
    if (url.includes('console.volcengine.com/api/')) {
      const cookie = get('cookie');
      if (cookie) {
        const fields = { sessionCookie: cookie };
        const csrf = get('x-csrf-token') || get('csrf-token');
        const webId = get('x-web-id');
        if (csrf) fields.csrfToken = csrf;
        if (webId) fields.webId = webId;
        push('ark', fields);
      }
    }

    // 智谱：API 请求 → authorization JWT
    if (url.includes('open.bigmodel.cn/api/') || url.includes('bigmodel.cn/api/')) {
      const auth = get('authorization');
      if (auth && auth.length > 40) push('zhipu', { sessionToken: auth.replace(/^Bearer\s+/i, '') });
    }

    // MiniMax：请求 → cookie + groupId
    if (url.includes('minimaxi.com')) {
      const cookie = get('cookie');
      if (cookie) {
        const fields = { sessionCookie: cookie };
        const groupId = get('x-group-id');
        if (groupId) fields.groupId = groupId;
        push('minimax', fields);
      }
    }
  },
  { urls: ['*://*.volcengine.com/*', '*://*.bigmodel.cn/*', '*://*.minimaxi.com/*'] },
  ['requestHeaders']
);

// 响应 options 的「立即同步」：打开各平台页面触发请求拦截
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'sync-all') {
    chrome.tabs.create({ url: 'https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan', active: false });
    chrome.tabs.create({ url: 'https://open.bigmodel.cn/coding-plan/personal/overview', active: false });
    chrome.tabs.create({ url: 'https://platform.minimaxi.com/', active: false });
    sendResponse({ ok: true });
  }
});
