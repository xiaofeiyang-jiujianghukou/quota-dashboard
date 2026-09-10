// AI 套餐看板 · 会话同步（background service worker）
// 三个平台都用 chrome.cookies 静默读取（不需要打开任何标签页）：
//   方舟   → volcengine.com cookie（userInfo/digest 是分区 cookie，需显式 partitionKey）
//   MiniMax → minimaxi.com cookie
//   智谱   → bigmodel.cn 的 bigmodel_token_production（JWT）
// 触发：登录时 cookie 变化自动同步；也可在 options 点「立即同步」手动全量同步。

const SYNC_INTERVAL_MS = 10 * 60 * 1000; // 同平台 10 分钟内去重
const pending = new Set(); // 并发去重

async function getConfig() {
  const cfg = await chrome.storage.local.get(['dashboard', 'token', 'lastSync', 'arkSlot']);
  return {
    dashboard: (cfg.dashboard || '').trim().replace(/\/+$/, ''),
    token: (cfg.token || '').trim(),
    lastSync: cfg.lastSync || {},
    arkSlot: cfg.arkSlot === 'ark2' ? 'ark2' : 'ark', // 本浏览器登录的方舟账号位
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

/** 方舟：cookie → sessionCookie + csrfToken + webId（userInfo/digest 是登录核心，值非空才推）
 *  推到哪个账号位由设置里的「方舟账号位」决定：ark=主账号，ark2=第二个账号（另一浏览器登录） */
async function syncArk(force = false) {
  const cfg = await getConfig();
  const slot = cfg.arkSlot || 'ark';
  const list = await allCookiesFor('volcengine.com', ['https://volcengine.com', 'https://console.volcengine.com']);
  const userInfo = list.find((c) => c.name === 'userInfo');
  const digest = list.find((c) => c.name === 'digest');
  if (!userInfo || !digest || !userInfo.value || !digest.value) {
    console.log('[会话同步] 方舟 cookie 尚不完整（缺 userInfo/digest 或其值为空），跳过，等下一轮兜底');
    return;
  }
  const fields = { sessionCookie: list.map((c) => `${c.name}=${c.value}`).join('; ') };
  const csrf = list.find((c) => c.name === 'csrfToken');
  if (csrf && csrf.value) fields.csrfToken = csrf.value;
  const webId = list.find((c) => c.name === 's_v_web_id' || c.name === 'monitor_huoshan_web_id');
  if (webId && webId.value) fields.webId = webId.value;
  await push(slot, fields, force);
}

/** MiniMax：cookie → sessionCookie + groupId（_token 值非空才推） */
async function syncMinimax(force = false) {
  const list = await allCookiesFor('minimaxi.com');
  console.log('[诊断] MiniMax 读到 cookie 数:', list.length, '| 有 _token:', list.some((c) => c.name === '_token'));
  const tok = list.find((c) => c.name === '_token');
  if (!tok || !tok.value) {
    console.log('[会话同步] MiniMax cookie 尚不完整（缺 _token 或其值为空），跳过，等下一轮兜底');
    return;
  }
  const fields = { sessionCookie: list.map((c) => `${c.name}=${c.value}`).join('; ') };
  console.log('[诊断] MiniMax sessionCookie 长度:', fields.sessionCookie.length);
  const g = list.find((c) => c.name === 'minimax_group_id_v2');
  if (g && g.value) fields.groupId = g.value;
  await push('minimax', fields, force);
}

/** 智谱：bigmodel_token_production（JWT）→ sessionToken（值非空才推） */
async function syncZhipu(force = false) {
  const list = await allCookiesFor('bigmodel.cn');
  console.log('[诊断] 智谱 读到 cookie 数:', list.length, '| 有 bigmodel_token_production:', list.some((c) => c.name === 'bigmodel_token_production'));
  const tok = list.find((c) => c.name === 'bigmodel_token_production');
  if (tok && tok.value) {
    console.log('[诊断] 智谱 sessionToken 长度:', tok.value.length);
    await push('zhipu', { sessionToken: tok.value }, force);
  }
}

// ---- DeepSeek：cookie + localStorage 双通道 ----
// HWWAFSESID 等 cookie 静默读取；Bearer 会话令牌存于 platform.deepseek.com 页面的 localStorage
// （键名以 userToken 优先，回退到任意含 token 的键；值须为 40+ 位 base64 字符集），需要该站点有已登录的标签页。

function extractDsToken(snapshot) {
  const parse = (v) => {
    const s = String(v).trim().replace(/^"|"$/g, '');
    if (/^[A-Za-z0-9+/=_-]{40,}$/.test(s)) return s;
    try {
      let hit = null;
      const walk = (o) => {
        if (hit || !o || typeof o !== 'object') return;
        for (const val of Object.values(o)) {
          if (typeof val === 'string' && /^[A-Za-z0-9+/=_-]{40,}$/.test(val)) { hit = val; return; }
          if (val && typeof val === 'object') walk(val);
        }
      };
      walk(JSON.parse(s));
      return hit;
    } catch {
      return null;
    }
  };
  for (const key of ['userToken', 'token', 'accessToken', 'auth_token']) {
    if (snapshot[key]) { const t = parse(snapshot[key]); if (t) return t; }
  }
  for (const [k, v] of Object.entries(snapshot)) {
    if (/token/i.test(k)) { const t = parse(v); if (t) return t; }
  }
  return null;
}

/** 从已打开的 platform.deepseek.com 标签页读 localStorage 提取会话令牌 */
async function readDsToken() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://platform.deepseek.com/*' });
    for (const tab of tabs) {
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'read-localstorage' }).catch(() => null);
      if (res && res.localStorage) {
        const t = extractDsToken(res.localStorage);
        if (t) return t;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function syncDeepseek(force = false) {
  const list = await allCookiesFor('deepseek.com');
  const waf = list.find((c) => c.name === 'HWWAFSESID');
  const token = await readDsToken();
  if (!waf || !waf.value || !token) {
    console.log('[会话同步] DeepSeek 会话不完整（缺 HWWAFSESID cookie 或 localStorage 令牌，需打开已登录的 platform.deepseek.com 标签页），跳过');
    return 'no-session';
  }
  await push('deepseek', { sessionCookie: list.map((c) => `${c.name}=${c.value}`).join('; '), sessionToken: token }, force);
  return 'ok';
}

// 登录时 cookie 变化 → 防抖后自动同步（等连续 3 秒无新 cookie 写入，说明已写完，立即触发）
const debounceTimers = {};
function debouncedSync(pid, fn, delay = 3000) {
  if (debounceTimers[pid]) clearTimeout(debounceTimers[pid]);
  debounceTimers[pid] = setTimeout(() => {
    delete debounceTimers[pid];
    fn();
  }, delay);
}

chrome.cookies.onChanged.addListener((info) => {
  const { cookie, removed } = info;
  if (removed) return;
  if (cookie.domain.endsWith('volcengine.com') && ['userInfo', 'digest'].includes(cookie.name)) debouncedSync('ark', syncArk);
  if (cookie.domain.endsWith('minimaxi.com') && cookie.name === '_token') debouncedSync('minimax', syncMinimax);
  if (cookie.domain.endsWith('bigmodel.cn') && cookie.name === 'bigmodel_token_production') debouncedSync('zhipu', syncZhipu);
  // DeepSeek 的 HWWAFSESID 较常轮换，靠 push() 内部 10 分钟节流去重
  if (cookie.domain.endsWith('deepseek.com') && cookie.name === 'HWWAFSESID') debouncedSync('deepseek', syncDeepseek);
});

// 「立即同步」：清节流 → 全部平台静默读取并推送（无需打开标签页；DeepSeek 令牌除外，需 platform.deepseek.com 登录标签页）
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'sync-all') {
    (async () => {
      await chrome.storage.local.set({ lastSync: {} });
      await Promise.all([syncArk(true), syncMinimax(true), syncZhipu(true)]);
      const deepseek = await syncDeepseek(true);
      sendResponse({ ok: true, deepseek });
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
  const dsList = await allCookiesFor('deepseek.com');
  return {
    ark: arkList.map((c) => `${c.name}=${c.value}`).join('; '),
    minimax: mmList.map((c) => `${c.name}=${c.value}`).join('; '),
    zhipu: zpTok ? zpTok.value : '',
    deepseek: dsList.map((c) => `${c.name}=${c.value}`).join('; '),
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
  // DeepSeek WAF cookie 常轮换，走非 force（受 10 分钟节流），避免频繁推送
  if (fp.deepseek && fp.deepseek !== prev.deepseek) await syncDeepseek(false);
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
setTimeout(checkAndSync, 3000); // service worker 冷启动后延迟 3 秒再查，等 cookies API 就绪
