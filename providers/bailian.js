// 百炼（阿里云 Model Studio）— Token Plan 配额（纯 HTTP，无需安装任何客户端）
// 数据源: 阿里云 AK/SK → GenerateCLIAccessToken → 控制台网关查 Token Plan 用量
//   POST https://modelstudio.cn-beijing.aliyuncs.com/modelstudio/cli/generateAccessToken
//        （ACS3-HMAC-SHA256 签名，Version 2026-02-10）
//   POST https://bailian-cs.console.aliyun.com/cli/api.json?action=BroadScopeAspnGateway&...api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage
//        （Authorization: Bearer <cliAccessToken>）
// 说明: 百炼官方对 Token Plan 只暴露周用量百分比（per1WeekPercentage）
import { acs3Sign } from '../lib/signers.js';
import { planPrice, planPriceNum } from '../lib/pricing.js';
import { toNum } from './util.js';

export const id = 'bailian';
export const name = '百炼';

const GATEWAY = 'bailian-cs.console.aliyun.com';
const API_USAGE = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage';
const API_SUBSCRIPTION = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription';

// 百炼 Token Plan 个人版档位名（specCode → 官方名）
const BAILIAN_SPEC_NAMES = {
  lite: '个人版 Lite',
  standard: '个人版 Standard',
  pro: '个人版 Pro',
};

export async function collect(cfg) {
  const p = cfg.providers.bailian;
  if (!p.enabled) return { ok: false, skipped: true, items: [] };

  if (!p.accessKeyId || !p.accessKeySecret) {
    return {
      ok: false,
      items: [],
      error: '未配置百炼 AK/SK',
      detail: '在 config.json 配置 bailian.accessKeyId / accessKeySecret（阿里云 RAM 访问控制 → AccessKey）',
    };
  }
  return collectHttp(cfg, p);
}

async function generateCliAccessToken(p, timeoutMs) {
  const host = 'modelstudio.cn-beijing.aliyuncs.com';
  const pathname = '/modelstudio/cli/generateAccessToken';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    const headers = acs3Sign({
      host,
      pathname,
      action: 'GenerateCLIAccessToken',
      version: '2026-02-10',
      body: '',
      queryString: '',
      accessKeyId: p.accessKeyId,
      accessKeySecret: p.accessKeySecret,
    });
    const res = await fetch(`https://${host}${pathname}`, { method: 'POST', headers, signal: controller.signal });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`GenerateCLIAccessToken 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`GenerateCLIAccessToken 失败（HTTP ${res.status}）: ${json.Message || json.Code || res.statusText}`);
    }
    const token = json.cliAccessToken || json.CliAccessToken || json.accessToken || (json.data && json.data.cliAccessToken);
    if (!token) throw new Error(`GenerateCLIAccessToken 响应缺少令牌字段：${text.slice(0, 200)}`);
    return token;
  } finally {
    clearTimeout(timer);
  }
}

async function consoleGatewayUsage(token, api, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
  try {
    const url = `https://${GATEWAY}/cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=${encodeURIComponent(api)}`;
    // 与 bl CLI 完全一致: params 为 JSON 字符串，body 用 form-urlencoded（JSON body 会被网关 WAF 拦截）
    const params = JSON.stringify({
      Api: api,
      V: '1.0',
      Data: {
        cornerstoneParam: {
          protocol: 'V2',
          console: 'ONE_CONSOLE',
          productCode: 'p_efm',
          switchUserType: 3,
          consoleSite: 'BAILIAN_ALIYUN',
        },
      },
    });
    const body = new URLSearchParams({ params, region: 'cn-beijing' }).toString();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: '*/*',
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`百炼网关返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    const data = json && json.data;
    if (data && data.success === false && data.errorCode) {
      const code = String(data.errorCode);
      throw new Error(
        code.includes('NotLogined')
          ? '百炼控制台会话失效（NotLogined），请重新登录或检查 AK/SK 权限'
          : `百炼网关错误: ${code}`
      );
    }
    if (!res.ok) {
      throw new Error(`百炼网关错误（HTTP ${res.status}）`);
    }
    return unwrapGateway(json);
  } finally {
    clearTimeout(timer);
  }
}

/** 逐层剥掉 code/data/DataV2 等网关包装，取最内层业务数据 */
function unwrapGateway(json) {
  let cur = json;
  for (let i = 0; i < 6 && cur && typeof cur === 'object'; i++) {
    if (cur.DataV2 && typeof cur.DataV2 === 'object') {
      cur = cur.DataV2;
    } else if (cur.data && typeof cur.data === 'object') {
      cur = cur.data;
    } else {
      break;
    }
  }
  return cur;
}

async function collectHttp(cfg, p) {
  const timeoutMs = cfg.requestTimeoutMs || 30000;
  const token = await generateCliAccessToken(p, timeoutMs);

  // 1) 用量（周用量百分比）
  const usage = await consoleGatewayUsage(token, API_USAGE, timeoutMs);
  // 2) 订阅信息（档位 / 到期 / 自动续费）——失败不阻塞，仅降级为纯用量
  let sub = null;
  try {
    sub = await consoleGatewayUsage(token, API_SUBSCRIPTION, timeoutMs);
  } catch {
    /* 订阅接口失败则跳过 */
  }

  const pct = toNum(usage.per1WeekPercentage ?? usage.per1WeekPercent);
  if (pct == null) {
    return { ok: false, items: [], error: 'Token Plan 接口未返回周用量', detail: JSON.stringify(usage).slice(0, 300) };
  }

  const spec = sub && (sub.specCode || sub.spec);
  const specName = (spec && BAILIAN_SPEC_NAMES[String(spec).toLowerCase()]) || '';
  const item = {
    key: 'bailian-token-plan-week',
    title: 'Token Plan · 本周额度',
    kind: 'plan',
    planName: specName || 'Token Plan 个人版',
    priceText: planPrice(cfg, 'bailian', spec),
    price: planPriceNum(cfg, 'bailian', spec),
    percentUsed: pct,
    remainingPercent: 100 - pct, // 订阅级展示：剩余比例
    unit: 'used',
    extra: {},
  };
  // 订阅状态补充信息（到期已在卡片头部；续费类型已按用户要求移除）
  if (sub && sub.status && String(sub.status).toUpperCase() !== 'VALID') {
    item.extra.status = String(sub.status);
  }
  if (sub && sub.remainingDays != null) item.extra.remainingDays = sub.remainingDays; // 备用，不展示
  // 到期时间（订阅接口 endTime，毫秒）
  const endMs = sub && (sub.endTime || sub.expireTime);
  if (endMs) {
    const t = new Date(Number(endMs));
    if (!Number.isNaN(t.getTime())) item.expiresAt = t.toISOString();
  }
  const resetRaw = usage.per1WeekResetTime || usage.per1WeekResetTimestamp;
  if (resetRaw) {
    const t = typeof resetRaw === 'number' ? new Date(resetRaw) : new Date(resetRaw);
    if (!Number.isNaN(t.getTime())) item.resetAt = t.toISOString();
  }
  const extra = item.extra;
  return { ok: true, items: [item], extra: { mode: 'api' } };
}
