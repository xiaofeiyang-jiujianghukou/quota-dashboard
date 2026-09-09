// 方舟（火山引擎）— Coding/Agent Plan 配额（纯 HTTP，无需安装任何客户端）
// 数据源: 火山引擎 AK/SK 调公开 TOP OpenAPI（签名 V4，service=ark）
//   POST https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01
//   POST https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01
// 说明: OpenAPI 返回各窗口百分比 + 重置时间；套餐到期时间不在该接口中，
//       若本机存在 ~/.arkcli/config.yaml 则读取 expires_at 作为补充（仅读文件，不依赖 CLI）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { volcSign } from '../lib/signers.js';
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

// Coding Plan 各档位窗口额度（次/窗口，官方活动/购买页 2026-07 口径；有模型倍率消耗，按次近似）
//   Lite: 1,200 次/5小时 · 9,000 次/周 · 18,000 次/月
//   Pro:  6,000 次/5小时 · 45,000 次/周 · 90,000 次/月
const CODING_PLAN_WINDOWS = {
  lite: { session: 1200, weekly: 9000, monthly: 18000, '5h': 1200, five_hour: 1200 },
  pro: { session: 6000, weekly: 45000, monthly: 90000, '5h': 6000, five_hour: 6000 },
};

const VOLC_API = 'https://open.volcengineapi.com/';
const VOLC_VERSION = '2024-01-01';
const VOLC_SERVICE = 'ark';

export async function collect(cfg) {
  const p = cfg.providers.ark;
  if (!p.enabled) return { ok: false, skipped: true, items: [] };

  if (!p.accessKeyId || !p.secretKey) {
    return {
      ok: false,
      items: [],
      error: '未配置方舟 AK/SK',
      detail: '在 config.json 配置 ark.accessKeyId / secretKey（火山引擎控制台 → 访问控制 IAM → API 访问密钥）',
    };
  }
  return collectHttp(cfg, p);
}

async function callVolc(p, action, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    const headers = volcSign({
      action,
      version: VOLC_VERSION,
      region: p.region || 'cn-beijing',
      accessKeyId: p.accessKeyId,
      secretKey: p.secretKey,
      service: VOLC_SERVICE,
    });
    const url = `${VOLC_API}?Action=${action}&Version=${VOLC_VERSION}`;
    const res = await fetch(url, { method: 'POST', headers, body: '', signal: controller.signal });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    const err = json.ResponseMetadata && json.ResponseMetadata.Error;
    if (!res.ok || err) {
      throw new Error(`[${err ? err.Code : res.status}] ${err ? err.Message : res.statusText}`);
    }
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
  let statusNote = '';

  // Coding Plan 优先（QuotaUsage 元素: { Level, Percent, ResetTimestamp(秒) }）
  let quotas = [];
  let product = 'coding-plan';
  try {
    const result = await callVolc(p, 'GetCodingPlanUsage', timeoutMs);
    statusNote = result.Status || '';
    quotas = Array.isArray(result.QuotaUsage) ? result.QuotaUsage : [];
  } catch (e) {
    if (!/403|404|AccessDenied|NotFound/i.test(e.message)) throw e;
    // 无 Coding Plan → 尝试 Agent Plan
  }

  if (quotas.length === 0) {
    // Agent Plan（AFP）回退: Result.AFPFiveHour/AFPWeekly/AFPMonthly: {Quota, Used, ResetTime(毫秒)}
    const result = await callVolc(p, 'GetAFPUsage', timeoutMs);
    product = 'agent-plan';
    const windows = [
      ['AFPFiveHour', '5 小时'],
      ['AFPWeekly', '每周'],
      ['AFPMonthly', '每月'],
    ];
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
      });
    }
    if (quotas.length === 0) {
      return {
        ok: false,
        items: [],
        error: '账号下没有生效的 Coding/Agent Plan',
        detail: `GetCodingPlanUsage / GetAFPUsage 均无配额窗口${statusNote ? `（Status=${statusNote}）` : ''}`,
      };
    }
  }

  const label = product === 'agent-plan' ? 'Agent Plan' : 'Coding Plan';
  const planName =
    product === 'agent-plan'
      ? 'Agent Plan'
      : `Coding Plan${tier ? ' ' + tier.toUpperCase() : ''}`;
  // 价格优先用官方实时报价（EstimateSubscribePrice，需会话 cookie）；失败才回退内置表
  let livePrice = null;
  if (tier && p.sessionCookie) {
    try {
      livePrice = await estimateSubscribePrice(p, timeoutMs, tier);
    } catch {
      livePrice = null;
    }
  }
  const priceText = livePrice != null ? `¥${livePrice}/月（官方实时价）` : planPrice(cfg, 'ark', tier);
  const price = livePrice != null ? livePrice : planPriceNum(cfg, 'ark', tier);
  for (const q of quotas) {
    const level = String(q.Level || '').toLowerCase();
    const periodLabel = PERIOD_LABELS[level] || q.Level || '';
    const resetAt = q._afp ? q.ResetTimestamp : epochToISO(toNum(q.ResetTimestamp) * 1000); // Coding Plan 为秒
    const item = {
      key: `ark-${product}-${level || items.length}`,
      title: `${label} · ${periodLabel || level}`,
      kind: 'plan',
      planName,
      priceText,
      price,
      quotaText: planQuotaText(cfg, 'ark', tier),
      percentUsed: toNum(q.Percent),
      unit: 'used',
      resetAt,
      extra: {},
    };
    if (expiryMs) item.expiresAt = new Date(expiryMs).toISOString();
    // Coding Plan 窗口额度按档位官方规格（次）换算：剩余绝对量 ≈ 总量 ×(100-已用%)/100
    // 规格来源：官方活动/购买页（Pro: 会话6,000次/周45,000次/月90,000次；Lite 减半档），有倍率消耗、按次近似
    if (product === 'coding-plan') {
      const spec = CODING_PLAN_WINDOWS[tier];
      const specTotal = spec && spec[level];
      if (specTotal) {
        const usedPct = toNum(q.Percent);
        const remainAbs = Math.round((specTotal * (100 - usedPct)) / 100);
        item.total = specTotal;
        item.used = specTotal - remainAbs;
        item.remaining = remainAbs;
        item.unit = '次';
        item.extra.note = `约剩 ${remainAbs} 次（Coding Plan ${String(tier).toUpperCase()} 官方窗口额度 ${specTotal} 次 × 剩 ${(100 - usedPct).toFixed(0)}%，含倍率波动，仅供参考）`;
      }
    }
    items.push(item);
  }
  return { ok: true, items, extra: { mode: 'api' } };
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
