// AI 套餐看板 · 会话同步（background service worker）
// 三个平台都用 chrome.cookies 静默读取（不需要打开任何标签页）：
//   方舟   → volcengine.com cookie（userInfo/digest 是分区 cookie，需显式 partitionKey）
//   MiniMax → minimaxi.com cookie
//   智谱   → bigmodel.cn 的 bigmodel_token_production（JWT）
// 触发：登录时 cookie 变化自动同步；也可在 options 点「立即同步」手动全量同步。

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

/** 方舟：cookie → sessionCookie + csrfToken + webId（userInfo/digest 是登录核心，必须都在才推，避免登录过程中推不完整） */
async function syncArk(force = false) {
  const list = await allCookiesFor('volcengine.com', ['https://volcengine.com', 'https://console.volcengine.com']);
  const hasUserInfo = list.some((c) => c.name === 'userInfo');
  const hasDigest = list.some((c) => c.name === 'digest');
  if (!hasUserInfo || !hasDigest) {
    console.log('[会话同步] 方舟 cookie 尚不完整（缺 userInfo/digest），跳过，等下一轮兜底');
    return;
  }
  const fields = { sessionCookie: list.map((c) => `${c.name}=${c.value}`).join('; ') };
  const csrf = list.find((c) => c.name === 'csrfToken');
  if (csrf) fields.csrfToken = csrf.value;
  const webId = list.find((c) => c.name === 's_v_web_id' || c.name === 'monitor_huoshan_web_id');
  if (webId) fields.webId = webId.value;
  await push('ark', fields, force);
}

/** MiniMax：cookie → sessionCookie + groupId（_token 是登录核心，必须存在才推） */
async function syncMinimax(force = false) {
  const list = await allCookiesFor('minimaxi.com');
  const hasToken = list.some((c) => c.name === '_token');
  if (!hasToken) {
    console.log('[会话同步] MiniMax cookie 尚不完整（缺 _token），跳过，等下一轮兜底');
    return;
  }
  const fields = { sessionCookie: list.map((c) => `${c.name}=${c.value}`).join('; ') };
  const g = list.find((c) => c.name === 'minimax_group_id_v2');
  if (g) fields.groupId = g.value;
  await push('minimax', fields, force);
}

/** 智谱：bigmodel_token_production（JWT）→ sessionToken */
async function syncZhipu(force = false) {
  const list = await allCookiesFor('bigmodel.cn');
  const tok = list.find((c) => c.name === 'bigmodel_token_production');
  if (tok) await push('zhipu', { sessionToken: tok.value }, force);
}

// 登录时 cookie 变化 → 自动同步对应平台
chrome.cookies.onChanged.addListener((info) => {
  const { cookie, removed } = info;
  if (removed) return;
  if (cookie.domain.endsWith('volcengine.com') && ['userInfo', 'digest'].includes(cookie.name)) syncArk();
  if (cookie.domain.endsWith('minimaxi.com') && cookie.name === '_token') syncMinimax();
  if (cookie.domain.endsWith('bigmodel.cn') && cookie.name === 'bigmodel_token_production') syncZhipu();
});

// 「立即同步」：清节流 → 三平台全部静默读取并推送（无需打开标签页）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'sync-all') {
    (async () => {
      await chrome.storage.local.set({ lastSync: {} });
      await Promise.all([syncArk(true), syncMinimax(true), syncZhipu(true)]);
      sendResponse({ ok: true });
    })();
    return true;
  }
});

// 4) 定时兜底：每 1 分钟读 cookie 指纹对比，变化则推（service worker 休眠导致 onChanged 丢失时兜底）
async function fingerprint() {
  const arkList = await allCookiesFor('volcengine.com', ['https://volcengine.com', 'https://console.volcengine.com']);
  const mmList = await allCookiesFor('minimaxi.com');
  const zpList = await allCookiesFor('bigmodel.cn');
  const zpTok = zpList.find((c) => c.name === 'bigmodel_token_production');
  return {
    ark: arkList.map((c) => `${c.name}=${c.value}`).join('; '),
    minimax: mmList.map((c) => `${c.name}=${c.value}`).join('; '),
    zhipu: zpTok ? zpTok.value : '',
  };
}

async function checkAndSync() {
  const cfg = await getConfig();
  if (!cfg.dashboard) return;
  const prev = (await chrome.storage.local.get(['lastValues'])).lastValues || {};
  const fp = await fingerprint();
  if (fp.ark && fp.ark !== prev.ark) await syncArk(true);
  if (fp.minimax && fp.minimax !== prev.minimax) await syncMinimax(true);
  if (fp.zhipu && fp.zhipu !== prev.zhipu) await syncZhipu(true);
  await chrome.storage.local.set({ lastValues: fp });
}

try {
  chrome.alarms.create('quota-check', { periodInMinutes: 1 }).catch(() => {});
} catch {
  /* ignore */
}
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'quota-check') checkAndSync();
});
checkAndSync(); // service worker 启动时立即查一次
