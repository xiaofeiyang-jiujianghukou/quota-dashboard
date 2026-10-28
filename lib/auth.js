// 统一鉴权管理：每个供应商的鉴权方式（密钥 / Cookie / 两者）+ 字段配置状态 + 在线更新
// 凭据持久化：写入 SQLite（lib/store.js），不再落 config.json
import { setCredentials, upsertProvider } from './store.js';

// 登录凭据有效性探测缓存（60s），避免每次状态查询都打平台接口
const loginCache = new Map(); // pid -> { at, value }

// 每个供应商的鉴权字段定义
// method: key=只需密钥 | cookie=只需会话Cookie | both=密钥和Cookie都要
// fields: [配置键, 显示名, 类型(key|cookie)]
export const AUTH_SCHEMA = {
  ark: {
    requireGroups: [['sessionCookie', 'csrfToken']],
    name: '方舟',
    method: 'cookie',
    note: '控制台授权：整段 Cookie + CSRF Token（控制台请求头里取），无需 AK/SK（实测纯 Cookie 通道数据一致）',
    fields: [
      ['sessionCookie', '控制台 Cookie', 'cookie', { aliases: ['控制台cookie', '会话cookie', 'cookie'], cookieLine: true }],
      ['csrfToken', 'CSRF Token', 'cookie', { aliases: ['csrftoken', 'csrf'], shapes: [/\b[0-9a-f]{32}\b/i] }],
    ],
  },
  zhipu: {
    requireGroups: [['codingPlanKey'], ['apiKey'], ['sessionToken', 'sessionCookie']],
    name: '智谱',
    method: 'both',
    note: '点「授权登录」在官网登录一次即可（用控制台会话取数，无需 API Key）；也可手动粘贴 API Key',
    fields: [
      ['codingPlanKey', 'Coding Plan Key', 'key', { aliases: ['codingplankey', 'codingplan', 'plankey', 'coding'], shapes: [/\b(?!eyJ)(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{10,}\.[A-Za-z0-9]{8,}\b/] }],
      ['apiKey', 'API Key（资源包）', 'key', { aliases: ['apikey资源包', 'apikey', '资源包'], shapes: [/\b(?!eyJ)(?=[A-Za-z0-9]*\d)[A-Za-z0-9]{10,}\.[A-Za-z0-9]{8,}\b/] }],
      ['sessionToken', '会话令牌 (JWT)', 'cookie', { aliases: ['会话令牌jwt', '会话令牌', 'sessiontoken', 'token', 'jwt', 'bearer'], shapes: [/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/] }],
      ['sessionCookie', '控制台 Cookie', 'cookie', { aliases: ['控制台cookie', '会话cookie', 'cookie'], cookieLine: true }],
    ],
  },
  minimax: {
    requireGroups: [['apiKey']],
    name: 'MiniMax',
    method: 'both',
    note: '粘贴订阅 Key（sk- 开头）；控制台 Cookie / Group ID 可选补到期',
    fields: [
      ['apiKey', '订阅 Key', 'key', { aliases: ['订阅key', 'apikey', 'key'], shapes: [/\bsk-[A-Za-z0-9_-]{20,}\b/] }],
      ['sessionCookie', '控制台 Cookie', 'cookie', { aliases: ['控制台cookie', '会话cookie', 'cookie'], cookieLine: true }],
      ['groupId', 'Group ID', 'cookie', { aliases: ['groupid', 'group'], shapes: [/\b\d{6,12}\b/] }],
    ],
  },
  deepseek: {
    requireGroups: [['apiKey']],
    name: 'DeepSeek',
    method: 'both',
    note: '粘贴 API Key（sk- 开头）查余额；控制台 Token(JWT)/Cookie 可选查消费统计',
    fields: [
      ['apiKey', 'API Key', 'key', { aliases: ['apikey', 'key'], shapes: [/\bsk-[A-Za-z0-9]{20,}\b/] }],
      ['sessionToken', '控制台 Token (Bearer)', 'cookie', { aliases: ['控制台tokenbearer', '控制台token', 'sessiontoken', 'token', 'jwt', 'bearer'], shapes: [/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/] }],
      ['sessionCookie', '控制台 Cookie', 'cookie', { aliases: ['控制台cookie', '会话cookie', 'cookie'], cookieLine: true }],
      ['budgetMonthly', '月预算(¥，0=不告警)', 'number', { aliases: ['月预算', '预算', 'budgetmonthly', 'budget'] }],
    ],
  },
};

const METHOD_TEXT = { key: '密钥', cookie: 'Cookie', both: '密钥 + Cookie' };

/** 实例 id → 类型 schema（实例的 type 存于 providers.<id>.type；旧实例按 id 推导） */
export function schemaFor(cfg, pid) {
  return AUTH_SCHEMA[cfg?.providers?.[pid]?.type] || AUTH_SCHEMA[pid] || null;
}

function mask(v) {
  if (!v) return '';
  if (v.length <= 8) return v.slice(0, 2) + '***';
  return v.slice(0, 4) + '****' + v.slice(-4);
}

// ---- 通用「粘贴即授权」识别引擎 ----
// 唯一授权方式：用户把凭据原文（裸 Key / "名称: 值" 多行 / 整段 Cookie）粘进来，
// 按类型 schema 自动识别字段。两种通用手段：
//   Pass A 标签行：行首 "标签: 值"（中英文别名模糊匹配，Cookie 行除外）→ 精确取值
//   Pass B 形状：  Cookie 行最先吃掉，再按字段形状正则扫描剩余文本（specific 先于 generic）
const normLabel = (s) => String(s).toLowerCase().replace(/[\s_\-（）()、.·]/g, '');
const stripBearer = (v) => String(v).replace(/^bearer\s+/i, '').replace(/^["']+|["',;\s]+$/g, '').trim();
const COOKIE_LINE_RE = /(?:[\w-]+=[^;\n]{1,}?;\s*){2,}[\w-]+=[^;\n]+/;

export function smartParseAuth(schema, text) {
  let pool = String(text || '');
  const out = {};
  const lines = pool.split('\n');
  const usedLines = new Set();

  // Pass A：标签行（整段 Cookie 行不参与，留给 Pass B 的 cookie 字段整体吃掉）
  schema.fields.forEach(([key, label, type, opt = {}], fi) => {
    const labels = [label, ...(opt.aliases || [])].map(normLabel).filter(Boolean);
    lines.forEach((line, li) => {
      if (usedLines.has(li) || out[key]) return;
      if (COOKIE_LINE_RE.test(line)) return; // Cookie 行不做标签拆分
      const m = line.match(/^\s*([^:：=]{1,40})[:：=]\s*(\S.*)$/);
      if (!m) return;
      const ln = normLabel(m[1]);
      if (!ln || ln.length < 2) return;
      const hit = labels.some((L) => ln === L || (L.length >= 4 && ln.includes(L)) || (ln.length >= 4 && L.includes(ln)));
      if (!hit) return;
      let v = stripBearer(m[2]);
      if (!v) return;
      if (type === 'number') {
        const n = parseFloat(v.replace(/[^\d.]/g, ''));
        if (Number.isNaN(n)) return;
        v = String(n);
      }
      out[key] = v;
      usedLines.add(li);
    });
  });

  // Pass B：形状扫描。Cookie 行最贪先吃；specific 先于 generic，避免 32hex 被 SK 通配吃掉
  const ordered = [...schema.fields].sort(
    (a, b) => (b[3]?.cookieLine ? 1 : 0) - (a[3]?.cookieLine ? 1 : 0) || (a[3]?.generic ? 1 : 0) - (b[3]?.generic ? 1 : 0)
  );
  for (const [key, , type, opt = {}] of ordered) {
    if (out[key]) continue;
    if (opt.cookieLine) {
      const m = pool.match(COOKIE_LINE_RE);
      if (m) {
        out[key] = m[0].trim();
        pool = pool.split(m[0]).join(' ');
      }
      continue;
    }
    for (const re of opt.shapes || []) {
      const m = pool.match(re);
      if (!m) continue;
      let v = m[1] || m[0];
      if (type === 'number') {
        const n = parseFloat(v);
        if (Number.isNaN(n)) continue;
        v = String(n);
      }
      out[key] = v;
      pool = pool.split(m[0]).join(' ');
      break;
    }
  }
  return out;
}

/** 粘贴即授权：识别 + 落库一步完成（唯一通用授权通道） */
export function smartUpdateAuth(cfg, providerId, text) {
  const schema = schemaFor(cfg, providerId);
  if (!schema) throw new Error(`未知提供商: ${providerId}`);
  const fields = smartParseAuth(schema, text);
  const keys = Object.keys(fields);
  if (!keys.length) throw new Error('未能识别任何凭据字段，请检查粘贴内容');
  upsertProvider(providerId, {});
  setCredentials(providerId, fields);
  clearLoginCache(providerId);
  const labelOf = (k) => schema.fields.find(([fk]) => fk === k)?.[1] || k;
  // 智能提示：必填组满足"任一组齐全"即凭据完整；不完整时列出各组作为备选补齐方式
  const have = { ...(cfg.providers?.[providerId] || {}), ...fields };
  const groupStates = (schema.requireGroups || []).map((grp) => ({ grp, ok: grp.every((k) => !!have[k]) }));
  const anyGroupOk = groupStates.some((g) => g.ok);
  const missing = anyGroupOk
    ? []
    : groupStates.filter((g) => !g.ok).map((g) => g.grp.map((k) => labelOf(k)).join(' + '));
  return { ok: true, changed: keys.length, applied: keys.map(labelOf), missing };
}

/** 各供应商鉴权状态（供 /api/providers、/api/auth/status）；实例制：遍历 cfg.providers，含登录凭据有效性探测 */
export async function authStatus(cfg) {
  const out = {};
  for (const pid of Object.keys(cfg.providers || {})) {
    const schema = schemaFor(cfg, pid);
    if (!schema) continue;
    const p = cfg.providers[pid] || {};
    out[pid] = {
      name: p.name || schema.name,
      type: p.type || pid,
      method: schema.method,
      methodText: METHOD_TEXT[schema.method] || schema.method,
      note: schema.note,
      enabled: !!p.enabled,
      loggedIn: await probeLogin(pid, cfg),
      fields: schema.fields.map(([key, label, type]) => {
        const v = p[key];
        return { key, label, type, configured: !!v, masked: mask(v) };
      }),
    };
  }
  return out;
}

/** 探测登录凭据是否有效（cookie 平台实际调会话接口验证；密钥平台看密钥是否已配置）——按实例类型路由 */
async function probeLogin(pid, cfg) {
  const now = Date.now();
  const c = loginCache.get(pid);
  if (c && now - c.at < 60000) return c.value;
  const type = cfg?.providers?.[pid]?.type || (AUTH_SCHEMA[pid] ? pid : '');
  const p = cfg.providers[pid] || {};
  let ok = false;
  try {
    if (type === 'ark') {
      if (p.sessionCookie && p.csrfToken) {
        const res = await fetch(
          'https://console.volcengine.com/api/top/ark/cn-beijing/2024-01-01/ListSubscribeTrade?',
          {
            method: 'POST',
            headers: {
              accept: 'application/json, text/plain, */*',
              'content-type': 'application/json',
              cookie: p.sessionCookie,
              origin: 'https://console.volcengine.com',
              referer: 'https://console.volcengine.com/ark/region:cn-beijing/subscription/coding-plan',
              'x-csrf-token': p.csrfToken,
              'x-web-id': p.webId || '',
            },
            body: JSON.stringify({ ResourceTypes: ['CodingPlan'], ResourceNames: [''], BizInfos: ['lite', 'pro'] }),
            signal: AbortSignal.timeout(12000),
          }
        );
        const j = await res.json().catch(() => null);
        ok = !!(j && j.Result && !(j.ResponseMetadata && j.ResponseMetadata.Error));
      }
    } else if (type === 'zhipu') {
      // 与采集走同一个控制台接口（会话通道）：能取到额度才算已授权
      if (p.sessionToken) {
        const res = await fetch('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
          headers: {
            accept: 'application/json, text/plain, */*',
            authorization: String(p.sessionToken).replace(/^Bearer\s+/i, ''),
            cookie: p.sessionCookie || '',
            referer: 'https://open.bigmodel.cn/coding-plan/personal/overview',
          },
          signal: AbortSignal.timeout(12000),
        });
        const j = await res.json().catch(() => null);
        ok = !!(j && j.success !== false && j.data && Array.isArray(j.data.limits) && j.data.limits.length);
      }
    } else if (type === 'minimax') {
      if (p.sessionCookie) {
        const groupId = p.groupId || '';
        const res = await fetch(
          'https://www.minimaxi.com/v1/api/openplatform/charge/combo/cycle_audio_resource_package?biz_line=2&cycle_type=3&resource_package_type=7',
          {
            headers: { accept: 'application/json, text/plain, */*', cookie: p.sessionCookie, ...(groupId ? { 'x-group-id': groupId } : {}), origin: 'https://platform.minimaxi.com', referer: 'https://platform.minimaxi.com/' },
            signal: AbortSignal.timeout(12000),
          }
        );
        const j = await res.json().catch(() => null);
        ok = !!(j && j.current_subscribe);
      }
    } else if (type === 'deepseek') {
      if (p.sessionToken && p.sessionCookie) {
        // 探测消费接口验证控制台会话是否有效（start/end 需对齐到 UTC+8 天边界）
        const d8 = new Date(Date.now() + 8 * 3600 * 1000);
        const ds = (yy, mm, dd) => Math.floor((Date.UTC(yy, mm - 1, dd) - 8 * 3600 * 1000) / 1000);
        const start = ds(d8.getUTCFullYear(), d8.getUTCMonth() + 1, d8.getUTCDate());
        const end = ds(d8.getUTCFullYear(), d8.getUTCMonth() + 1, d8.getUTCDate() + 1);
        const url = `https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=${start}&end=${end}&tz=28800`;
        const res = await fetch(url, {
          headers: {
            accept: '*/*',
            'accept-language': 'zh-CN,zh;q=0.9',
            authorization: `Bearer ${p.sessionToken}`,
            cookie: p.sessionCookie,
            referer: 'https://platform.deepseek.com/usage',
            'user-agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
            'x-client-platform': 'web',
            'x-client-timezone-offset': '28800',
            'x-client-version': '1.0.0',
          },
          signal: AbortSignal.timeout(12000),
        });
        const j = await res.json().catch(() => null);
        ok = !!(j && j.data && j.data.biz_data && j.data.biz_data.bucket);
      } else {
        // 无控制台会话：能查余额即视为已登录
        ok = !!p.apiKey;
      }
    } else {
      // 纯密钥平台：密钥已配置即视为已登录（数据采集 OK 时）
      const keyFields = (AUTH_SCHEMA[type] || {}).fields.filter(([, , t]) => t === 'key');
      ok = keyFields.every(([k]) => !!p[k]);
    }
  } catch {
    ok = false;
  }
  loginCache.set(pid, { at: now, value: ok });
  return ok;
}

/** 清除登录态探测缓存（保存新凭据后调用，让下一次状态查询立即重新探测） */
export function clearLoginCache(pid) {
  if (pid) loginCache.delete(pid);
  else loginCache.clear();
}

/** 在线更新某供应商的鉴权字段（写入 SQLite，热加载生效） */
export function updateAuth(cfg, providerId, updates) {
  const schema = schemaFor(cfg, providerId) || AUTH_SCHEMA[providerId];
  if (!schema) throw new Error(`未知提供商: ${providerId}`);
  // 排查用日志：谁推了哪个平台、推了哪些字段（不打印字段值）
  console.log(`[auth] 收到推送 providerId=${providerId} fields=${Object.keys(updates || {}).join(',') || '(空)'}`);
  const allowed = new Set(schema.fields.map(([k]) => k));
  const applied = {};
  for (const [k, v] of Object.entries(updates || {})) {
    if (!allowed.has(k)) continue;
    if (typeof v !== 'string' || v.trim() === '') continue;
    applied[k] = v.trim();
  }
  if (Object.keys(applied).length === 0) return { ok: true, changed: 0 };

  upsertProvider(providerId, {}); // 确保行存在
  const changed = setCredentials(providerId, applied);
  clearLoginCache(providerId); // 凭据已变，立即失效缓存，下次查询重新探测
  return { ok: true, changed, applied: Object.keys(applied) };
}
