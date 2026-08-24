// 统一鉴权管理：每个供应商的鉴权方式（密钥 / Cookie / 两者）+ 字段配置状态 + 在线更新
import fs from 'node:fs';
import { CONFIG_PATH } from './config.js';

// 登录凭据有效性探测缓存（60s），避免每次状态查询都打平台接口
const loginCache = new Map(); // pid -> { at, value }

// 每个供应商的鉴权字段定义
// method: key=只需密钥 | cookie=只需会话Cookie | both=密钥和Cookie都要
// fields: [配置键, 显示名, 类型(key|cookie)]
export const AUTH_SCHEMA = {
  ark: {
    name: '方舟',
    method: 'both',
    note: 'AK/SK 查用量；Cookie 补档位/到期（控制台 ListSubscribeTrade 请求：cookie/csrfToken/webId）',
    fields: [
      ['accessKeyId', 'AccessKey ID', 'key'],
      ['secretKey', 'Secret Access Key', 'key'],
      ['sessionCookie', '控制台 Cookie', 'cookie'],
      ['csrfToken', 'CSRF Token', 'cookie'],
      ['webId', 'X-Web-Id', 'cookie'],
    ],
  },
  bailian: {
    name: '百炼',
    method: 'key',
    note: '阿里云 AK/SK（RAM 控制台 → AccessKey）',
    fields: [
      ['accessKeyId', 'AccessKey ID', 'key'],
      ['accessKeySecret', 'AccessKey Secret', 'key'],
    ],
  },
  zhipu: {
    name: '智谱',
    method: 'both',
    note: 'API Key 查配额；会话令牌补到期（控制台 context 请求的 authorization，JWT）',
    fields: [
      ['apiKey', 'API Key（资源包）', 'key'],
      ['codingPlanKey', 'Coding Plan Key', 'key'],
      ['sessionToken', '会话令牌 (JWT)', 'cookie'],
    ],
  },
  minimax: {
    name: 'MiniMax',
    method: 'both',
    note: '订阅 Key 查用量；Cookie 补到期（控制台 charge/combo 请求）',
    fields: [
      ['apiKey', '订阅 Key', 'key'],
      ['sessionCookie', '控制台 Cookie', 'cookie'],
      ['groupId', 'Group ID', 'cookie'],
    ],
  },
  tencent: {
    name: '混元',
    method: 'key',
    note: '腾讯云 CAM API 密钥（console.cloud.tencent.com/cam/capi）',
    fields: [
      ['secretId', 'SecretId', 'key'],
      ['secretKey', 'SecretKey', 'key'],
      ['region', '地域', 'key'],
    ],
  },
  deepseek: {
    name: 'DeepSeek',
    method: 'key',
    note: 'DeepSeek API Key（platform.deepseek.com → API Keys）',
    fields: [
      ['apiKey', 'API Key', 'key'],
    ],
  },
};

const METHOD_TEXT = { key: '密钥', cookie: 'Cookie', both: '密钥 + Cookie' };

function mask(v) {
  if (!v) return '';
  if (v.length <= 8) return v.slice(0, 2) + '***';
  return v.slice(0, 4) + '****' + v.slice(-4);
}

/** 各供应商鉴权状态（供 /api/auth/status）；含登录凭据有效性探测 */
export async function authStatus(cfg) {
  const out = {};
  for (const [pid, schema] of Object.entries(AUTH_SCHEMA)) {
    const p = cfg.providers[pid] || {};
    out[pid] = {
      name: schema.name,
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

/** 探测登录凭据是否有效（cookie 平台实际调会话接口验证；密钥平台看密钥是否已配置） */
async function probeLogin(pid, cfg) {
  const now = Date.now();
  const c = loginCache.get(pid);
  if (c && now - c.at < 60000) return c.value;
  let ok = false;
  try {
    const p = cfg.providers[pid] || {};
    if (pid === 'ark') {
      if (p.sessionCookie && p.csrfToken && p.webId) {
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
              'x-web-id': p.webId,
            },
            body: JSON.stringify({ ResourceTypes: ['CodingPlan'], ResourceNames: [''], BizInfos: ['lite', 'pro'] }),
            signal: AbortSignal.timeout(12000),
          }
        );
        const j = await res.json().catch(() => null);
        ok = !!(j && j.Result && !(j.ResponseMetadata && j.ResponseMetadata.Error));
      }
    } else if (pid === 'zhipu') {
      if (p.sessionToken) {
        const res = await fetch('https://open.bigmodel.cn/api/agent/customer-agent/v1/context', {
          headers: { accept: '*/*', authorization: p.sessionToken, 'content-type': 'application/json', origin: 'https://bigmodel.cn', referer: 'https://bigmodel.cn/coding-plan/personal/overview' },
          signal: AbortSignal.timeout(12000),
        });
        const j = await res.json().catch(() => null);
        ok = !!(j && j.subscription && Array.isArray(j.subscription.limits));
      }
    } else if (pid === 'minimax') {
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
    } else {
      // 纯密钥平台：密钥已配置即视为已登录（数据采集 OK 时）
      const keyFields = (AUTH_SCHEMA[pid] || {}).fields.filter(([, , t]) => t === 'key');
      ok = keyFields.every(([k]) => !!p[k]);
    }
  } catch {
    ok = false;
  }
  loginCache.set(pid, { at: now, value: ok });
  return ok;
}

/** 在线更新某供应商的鉴权字段（写入 config.json，热加载生效） */
export function updateAuth(cfg, providerId, updates) {
  const schema = AUTH_SCHEMA[providerId];
  if (!schema) throw new Error(`未知提供商: ${providerId}`);
  const allowed = new Set(schema.fields.map(([k]) => k));
  const applied = {};
  for (const [k, v] of Object.entries(updates || {})) {
    if (!allowed.has(k) || typeof v !== 'string') continue;
    const t = v.trim();
    if (t !== '') applied[k] = t; // 空值不写（避免误清）；清除请直接编辑 config.json
  }
  if (Object.keys(applied).length === 0) return { ok: true, changed: 0 };

  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    file = {};
  }
  file.providers = file.providers || {};
  file.providers[providerId] = { ...(file.providers[providerId] || {}), ...applied };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + '\n');
  try {
    fs.chmodSync(CONFIG_PATH, 0o600);
  } catch {
    /* ignore */
  }
  return { ok: true, changed: Object.keys(applied).length, applied: Object.keys(applied) };
}
