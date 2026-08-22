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
  const tier = (session && session.tier) || meta.planTier || '';
  const expiryMs = (session && session.endTimeMs) || meta.expiresAt;
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
  const priceText = planPrice(cfg, 'ark', tier);
  const price = planPriceNum(cfg, 'ark', tier);
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
