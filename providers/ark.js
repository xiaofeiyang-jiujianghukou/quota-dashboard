// 方舟（火山引擎）— Coding/Agent Plan 配额（纯 HTTP，无需安装任何客户端）
// 数据源: 控制台代理接口（仅需登录 Cookie + CSRF Token，无需 AK/SK）
//   POST https://console.volcengine.com/api/top/ark/<region>/2024-01-01/GetCodingPlanUsage
//   POST https://console.volcengine.com/api/top/ark/<region>/2024-01-01/GetAFPUsage
// 说明: 该通道与 OpenAPI 数据一致；套餐到期时间不在其中，
//       若本机存在 ~/.arkcli/config.yaml 则读取 expires_at 作为补充（仅读文件，不依赖 CLI）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planPrice, planPriceNum, planQuotaText } from '../lib/pricing.js';
import { toNum } from './util.js';

export const id = 'ark';
export const name = '方舟';

const PERIOD_LABELS = {
  session: '会话窗口',
  weekly: '每周',
  monthly: '每月',
  '5h': '5 小时',
  '5-hour': '5 小时',
  five_hour: '5 小时',
  daily: '每日',
};

const VOLC_VERSION = '2024-01-01';

// pid 可传任意方舟实例 id（ark / ark2 / ark3 …用户在配置页动态新增），displayName 可覆盖展示名
export async function collect(cfg, pid = 'ark', displayName) {
  return collectFor(cfg, pid, displayName || '方舟');
}

async function collectFor(cfg, pid, displayName) {
  const p = cfg.providers[pid] || {};
  if (!p.enabled) return { ok: false, skipped: true, items: [] };

  const hasCookie = !!(p.sessionCookie && p.csrfToken);
  if (!hasCookie) {
    return {
      ok: false,
      items: [],
      error: `未配置 ${displayName} 凭据`,
      detail: `配置页粘贴控制台 Cookie + CSRF Token 即可（无需 AK/SK）`,
    };
  }
  const r = await collectHttp(cfg, p);
  // 第二个实例条目 key 换前缀，避免与主账号 key 冲突
  if (pid !== 'ark' && Array.isArray(r.items)) {
    for (const it of r.items) if (it.key) it.key = it.key.replace(/^ark-/, `${pid}-`);
  }
  return r;
}

/** 控制台代理调用（仅需 Cookie + csrfToken）：返回结构与 OpenAPI 一致 */
async function callVolcConsole(p, action, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    const region = p.region || 'cn-beijing';
    const url = `https://console.volcengine.com/api/top/ark/${region}/2024-01-01/${action}?`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        cookie: p.sessionCookie,
        origin: 'https://console.volcengine.com',
        referer: `https://console.volcengine.com/ark/region:${region}/subscription/coding-plan?tab=usage`,
        'x-csrf-token': p.csrfToken || '',
        'x-web-id': p.webId || '',
      },
      body: '',
      signal: controller.signal,
    });
    const json = await res.json();
    const err = json.ResponseMetadata && json.ResponseMetadata.Error;
    if (err) throw new Error(`[${err.Code}] ${err.Message || ''}`);
    return json.Result || {};
  } finally {
    clearTimeout(timer);
  }
}

function epochToISO(ms) {
  const n = toNum(ms);
  if (n == null || n <= 0) return null;
  return new Date(n).toISOString();
}

async function collectHttp(cfg, p) {
  const timeoutMs = cfg.requestTimeoutMs || 30000;
  const meta = readArkMeta(); // { expiresAt, planTier }（本机兜底）
  // 会话接口优先（控制台 ListSubscribeTrade）：真实档位/到期/续费
  let session = null;
  if (p.sessionCookie) {
    try {
      session = await fetchSessionPlan(p, timeoutMs);
    } catch {
      session = null; // 会话失效则回退
    }
  }
  // 档位优先级：会话(ListSubscribeTrade，近期对部分账号返回空) > 配置显式 planTier > 本机 meta 兜底
  const tier = (session && session.tier) || p.planTier || meta.planTier || '';
  const expiryMs = (session && session.endTimeMs) || meta.expiresAt || p.expiresAt || null;
  const items = [];

  // 两个套餐可以同时持有：Coding Plan 与 Agent Plan 各自抓，全部展示（不再二选一）
  const planBlocks = [];
  let statusNote = '';

  // ---- ① Coding Plan（QuotaUsage 元素: { Level, Percent, ResetTimestamp(秒) }）----
  try {
    const result = await callVolcConsole(p, 'GetCodingPlanUsage', timeoutMs);
    statusNote = result.Status || '';
    const quotas = Array.isArray(result.QuotaUsage) ? result.QuotaUsage : [];
    if (quotas.length) planBlocks.push({ product: 'coding-plan', quotas });
  } catch (e) {
    if (!/403|404|AccessDenied|NotFound/i.test(e.message)) statusNote = e.message;
  }

  // ---- ② Agent Plan（AFP）：5小时/每日/每周/每月 ----
  try {
    const result = await callVolcConsole(p, 'GetAFPUsage', timeoutMs);
    const windows = [
      ['AFPFiveHour', '5 小时'],
      ['AFPDaily', '每日'],
      ['AFPWeekly', '每周'],
      ['AFPMonthly', '每月'],
    ];
    const quotas = [];
    for (const [key, label] of windows) {
      const w = result[key];
      if (!w) continue;
      const quota = toNum(w.Quota);
      const used = toNum(w.Used);
      if (quota == null || quota <= 0) continue;
      quotas.push({
        Level: label,
        Percent: (used / quota) * 100,
        ResetTimestamp: epochToISO(w.ResetTime),
        _afp: true,
        _quota: quota,
        _used: used,
      });
    }
    if (quotas.length) planBlocks.push({ product: 'agent-plan', quotas, planType: result.PlanType || '' });
  } catch (e) {
    if (!statusNote) statusNote = e.message;
  }

  if (!planBlocks.length) {
    return {
      ok: false,
      items: [],
      error: '账号下没有生效的 Coding/Agent Plan',
      noPlan: true, // 已授权但该账号无套餐：UI 按"信息"呈现，而不是报错
      detail: `该账号已登录，但 GetCodingPlanUsage / GetAFPUsage 均无配额窗口${statusNote ? `（${statusNote}）` : ''}`,
    };
  }

  // Agent Plan 档位：接口给 PlanType/BizInfo（small/medium/large），映射成展示名
  const AFP_TIER = { small: 'Lite', light: 'Lite', lite: 'Lite', medium: 'Pro', pro: 'Pro', large: 'Max', high: 'Max', max: 'Max' };

  // 两个套餐各自的订阅信息（到期时间不同，必须分开取）与官方实时价格
  const planMeta = {};
  for (const block of planBlocks) {
    const isAfp = block.product === 'agent-plan';
    const resType = isAfp ? 'AgentPlan' : 'CodingPlan';
    const resName = isAfp ? 'RealAgentPlanPersonal' : '';
    const biz = isAfp ? block.planType || 'medium' : tier || 'pro';
    let sub = null;
    try {
      sub = await fetchSubscription(p, timeoutMs, resType, resName);
    } catch {
      sub = null;
    }
    let price = null;
    try {
      price = await estimateOrderPrice(p, timeoutMs, resType, sub ? sub.bizInfo : biz, resName);
    } catch {
      price = null;
    }
    const amount = price ? price.amount : null;
    planMeta[block.product] = {
      sub,
      price: amount,
      priceText: amount != null ? `¥${amount}/月${price.original && price.original !== amount ? `（原价 ¥${price.original}）` : ''}` : '',
      expiresAtMs: sub && sub.endTimeMs ? sub.endTimeMs : null,
      biz,
    };
  }
  const codingMeta = planMeta['coding-plan'] || { price: null, priceText: '', expiresAtMs: null };
  const codingPriceText = codingMeta.priceText || (tier ? planPrice(cfg, 'ark', tier) : '');
  const codingPrice = codingMeta.price != null ? codingMeta.price : planPriceNum(cfg, 'ark', tier);

  for (const block of planBlocks) {
    const isAfp = block.product === 'agent-plan';
    const meta = planMeta[block.product] || {};
    const bizName = (meta.sub && meta.sub.bizInfo) || block.planType || '';
    const afpTier = isAfp ? AFP_TIER[String(bizName).toLowerCase()] || String(bizName).toUpperCase() : '';
    const label = isAfp ? 'Agent Plan' : 'Coding Plan';
    const planName = isAfp ? `Agent Plan${afpTier ? ' ' + afpTier : ''}` : `Coding Plan${tier ? ' ' + tier.toUpperCase() : ''}`;
    const priceText = meta.priceText || (isAfp ? '' : codingPriceText);
    const price = meta.price != null ? meta.price : (isAfp ? null : codingPrice);
    const pricePeriod = (meta.sub && meta.sub.period) || 'monthly';
    const planExpiryMs = meta.expiresAtMs || expiryMs;
    for (const q of block.quotas) {
      const level = String(q.Level || '').toLowerCase();
      const periodLabel = PERIOD_LABELS[level] || q.Level || '';
      const resetAt = q._afp ? q.ResetTimestamp : epochToISO(toNum(q.ResetTimestamp) * 1000); // Coding Plan 为秒
      const item = {
        key: `ark-${block.product}-${level || items.length}`,
        title: `${label} · ${periodLabel || level}`,
        kind: 'plan',
        planName,
        priceText,
        price,
        pricePeriod,
        quotaText: isAfp ? '' : planQuotaText(cfg, 'ark', tier),
        percentUsed: toNum(q.Percent),
        unit: 'used',
        resetAt,
        extra: isAfp ? { planType: bizName, autoRenew: !!(meta.sub && meta.sub.autoRenew) } : { autoRenew: !!(meta.sub && meta.sub.autoRenew) },
      };
      if (q._quota != null) {
        item.total = q._quota;
        item.used = q._used;
        item.remaining = Math.max(0, q._quota - q._used);
      }
      if (planExpiryMs) item.expiresAt = new Date(planExpiryMs).toISOString();
      items.push(item);
    }
  }
  return { ok: true, items, extra: { mode: 'api' } };
}

/**
 * 取某个套餐的订阅信息（到期/档位/是否自动续费）。
 * CodingPlan 与 AgentPlan 的 ResourceName 不同，要分别查。
 */
async function fetchSubscription(p, timeoutMs, resourceType, resourceName = '') {
  const region = p.region || 'cn-beijing';
  const url = `https://console.volcengine.com/api/top/ark/${region}/2024-01-01/ListSubscribeTrade?`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      cookie: p.sessionCookie,
      origin: 'https://console.volcengine.com',
      referer: `https://console.volcengine.com/ark/region:${region}/subscription/coding-plan`,
      'x-csrf-token': p.csrfToken || '',
      'x-web-id': p.webId || '',
    },
    body: JSON.stringify({
      ResourceTypes: [resourceType],
      ResourceNames: [resourceName],
      BizInfos: resourceType === 'AgentPlan' ? ['small', 'medium', 'large'] : ['lite', 'pro'],
      Quantity: 1,
      Period: 'monthly',
      Times: 1,
    }),
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  const json = await res.json().catch(() => null);
  const err = json && json.ResponseMetadata && json.ResponseMetadata.Error;
  if (err) throw new Error(`[${err.Code}] ${err.Message || ''}`);
  const list = (json && json.Result && json.Result.InfoList) || [];
  const info = list.find((x) => x.Status === 'Running') || list[0] || null;
  if (!info) return null;
  return {
    bizInfo: info.BizInfo || '',
    endTimeMs: info.EndTime ? new Date(info.EndTime).getTime() : null,
    autoRenew: info.EnableAutoRenew === true,
    period: info.Period || '',
  };
}

/**
 * 官方询价（EstimateSubscribeNewOrderPrice）：按套餐+档位拿实时月价与挂牌价。
 */
async function estimateOrderPrice(p, timeoutMs, resourceType, bizInfo, resourceName = '') {
  const region = p.region || 'cn-beijing';
  const url = `https://console.volcengine.com/api/top/ark/${region}/2024-01-01/EstimateSubscribeNewOrderPrice?`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      cookie: p.sessionCookie,
      origin: 'https://console.volcengine.com',
      referer: `https://console.volcengine.com/ark/region:${region}/subscription/coding-plan?tab=usage`,
      'x-csrf-token': p.csrfToken || '',
      'x-web-id': p.webId || '',
    },
    body: JSON.stringify({
      Items: [{ ResourceType: resourceType, ResourceName: resourceName, BizInfo: bizInfo, Quantity: 1, Period: 'monthly' }],
      Times: 1,
    }),
    signal: AbortSignal.timeout(timeoutMs || 15000),
  });
  const json = await res.json().catch(() => null);
  const err = json && json.ResponseMetadata && json.ResponseMetadata.Error;
  if (err) throw new Error(`[${err.Code}] ${err.Message || ''}`);
  const one = ((json && json.Result && json.Result.Results) || [])[0];
  if (!one) return null;
  return { amount: toNum(one.TotalAmount), original: toNum(one.OriginalAmount) };
}

/** 读取 ~/.arkcli/config.yaml 中默认 profile 的套餐元信息（仅读文件补充，不依赖 CLI） */
function readArkMeta() {
  const out = { expiresAt: null, planTier: null };
  try {
    const p = path.join(os.homedir(), '.arkcli', 'config.yaml');
    if (!fs.existsSync(p)) return out;
    const t = fs.readFileSync(p, 'utf8');
    const dm = t.match(/^default_profile:\s*(\S+)/m);
    const defaultProfile = dm ? dm[1] : null;
    let curProfile = null;
    for (const line of t.split('\n')) {
      const pm = line.match(/^  ([A-Za-z0-9_.-]+):\s*$/);
      if (pm) {
        curProfile = pm[1];
        continue;
      }
      const em = line.match(/^    expires_at:\s*(\d+)/);
      if (em && (!defaultProfile || curProfile === defaultProfile)) {
        out.expiresAt = Number(em[1]) * 1000;
      }
      const tm = line.match(/^    plan_tier:\s*(\S+)/);
      if (tm && (!defaultProfile || curProfile === defaultProfile)) {
        out.planTier = tm[1];
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * 官方实时报价（EstimateSubscribePrice）：POST console…/EstimateSubscribePrice
 * body: {ResourceType:"CodingPlan",ResourceName:"",BizInfo:<tier>,Quantity:1,Period:"monthly",Times:1}
 * 返回 Result.Price.Price（¥/月）。价格以官方为准，不依赖本地价格表。失败抛错（调用方回退）。
 */
async function estimateSubscribePrice(p, timeoutMs, tier) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
  try {
    const region = p.region || 'cn-beijing';
    const url = `https://console.volcengine.com/api/top/ark/${region}/2024-01-01/EstimateSubscribePrice?`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        cookie: p.sessionCookie,
        origin: 'https://console.volcengine.com',
        referer: `https://console.volcengine.com/ark/region:${region}/subscription/coding-plan?tab=usage`,
        'x-csrf-token': p.csrfToken || '',
        'x-web-id': p.webId || '',
      },
      body: JSON.stringify({
        ResourceType: 'CodingPlan',
        ResourceName: '',
        BizInfo: tier,
        Quantity: 1,
        Period: 'monthly',
        Times: 1,
      }),
      signal: controller.signal,
    });
    const json = await res.json();
    const err = json.ResponseMetadata && json.ResponseMetadata.Error;
    if (err) throw new Error(`[${err.Code}] ${err.Message || ''}`);
    const price = json.Result && json.Result.Price && json.Result.Price.Price;
    if (price == null) throw new Error('EstimateSubscribePrice 无 Price 字段');
    return Number(price);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 控制台会话查询订阅信息（ListSubscribeTrade）：
 * POST https://console.volcengine.com/api/top/ark/{region}/{version}/ListSubscribeTrade
 * body: {"ResourceTypes":["CodingPlan"],"ResourceNames":[""],"BizInfos":["lite","pro"]}
 * 返回 InfoList[0]: { BizInfo(档位), EndTime, EnableAutoRenew, Status }
 * 失败抛错（调用方回退）
 */
async function fetchSessionPlan(p, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
  try {
    const region = p.region || 'cn-beijing';
    const url = `https://console.volcengine.com/api/top/ark/${region}/2024-01-01/ListSubscribeTrade?`;
    const body = JSON.stringify({ ResourceTypes: ['CodingPlan'], ResourceNames: [''], BizInfos: ['lite', 'pro'] });
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        cookie: p.sessionCookie,
        origin: 'https://console.volcengine.com',
        referer: `https://console.volcengine.com/ark/region:${region}/subscription/coding-plan`,
        'x-csrf-token': p.csrfToken || '',
        'x-web-id': p.webId || '',
      },
      body,
      signal: controller.signal,
    });
    const json = await res.json();
    const err = json.ResponseMetadata && json.ResponseMetadata.Error;
    if (err) throw new Error(`[${err.Code}] ${err.Message || ''}`);
    const info = (json.Result && json.Result.InfoList && json.Result.InfoList[0]) || null;
    if (!info) return null;
    const endMs = info.EndTime ? new Date(info.EndTime).getTime() : null;
    return {
      tier: String(info.BizInfo || '').toLowerCase() || null,
      endTimeMs: endMs && !Number.isNaN(endMs) ? endMs : null,
      autoRenew: info.EnableAutoRenew,
      status: info.Status || null,
    };
  } finally {
    clearTimeout(timer);
  }
}
