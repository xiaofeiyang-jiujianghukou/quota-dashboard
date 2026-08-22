// 智谱 AI（bigmodel.cn）— 资源包余量 + GLM Coding Plan 配额
// 数据源（实测字段，2026-08 验证）:
//   资源包:  GET https://bigmodel.cn/api/biz/tokenAccounts/list/my
//            Authorization: Bearer <apiKey>  → rows[]: tokenBalance/availableBalance/
//            packageExpirationTime/expirationTime/status/resourcePackageName/suitableModel
//   Coding Plan: GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
//            Authorization: <key>  → data.limits[]: type=CREDIT_LIMIT|TOKENS_LIMIT,
//            unit=3(5小时)/6(每周), 含 usage/remaining/percentage/nextResetTime
import { toNum, epochToISO } from './util.js';
import { planPrice, planPriceNum } from '../lib/pricing.js';

export const id = 'zhipu';
export const name = '智谱';

const ZHIPU_STATUS_TEXT = {
  EFFECTIVE: '生效中',
  EXPIRING: '即将到期',
  EXPIRED: '已过期',
  FROZEN: '冻结',
};

export async function collect(cfg) {
  const p = cfg.providers.zhipu;
  if (!p.enabled) return { ok: false, skipped: true, items: [] };

  // 用户通常只有一把 key：优先 apiKey，缺省回退 codingPlanKey，两个接口都用它试
  const key = p.apiKey || p.codingPlanKey;
  if (!key) {
    return {
      ok: false,
      items: [],
      error: '未配置 zhipu.apiKey / codingPlanKey',
      detail: '在 config.json 的 zhipu 段填入智谱开放平台 API Key（open.bigmodel.cn → API Keys）',
    };
  }

  const items = [];
  const errors = [];
  const timeoutMs = cfg.requestTimeoutMs || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // ---- 1) 资源包（token 账户）----
    try {
      const res = await fetch(
        'https://bigmodel.cn/api/biz/tokenAccounts/list/my?pageNum=1&pageSize=50',
        { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal }
      );
      const json = await res.json();
      if (json.code !== 200) {
        errors.push(`资源包查询失败(code=${json.code})${json.msg ? '：' + json.msg : ''}`);
      } else {
        const rows = json.rows || [];
        const now = Date.now();
        // 过滤试用/体验包（按用户要求不展示）
        const notTrial = (r) => !/体验包|试用|体验/.test(r.resourcePackageName || '');
        const alive = rows.filter((r) => {
          if (!notTrial(r)) return false;
          const exp = r.packageExpirationTime || r.expirationTime;
          const t = exp ? new Date(exp).getTime() : NaN;
          return r.status === 'EFFECTIVE' || r.status === 'EXPIRING' || (Number.isFinite(t) && t > now);
        });
        // 只展示生效中/未过期的资源包（不含试用/体验包）；过期包不展示
        const shown = alive;
        for (const row of shown) {
          const remaining = toNum(row.tokenBalance) ?? toNum(row.availableBalance);
          const status = String(row.status || '');
          const expiresAt = row.packageExpirationTime || row.expirationTime || null;
          items.push({
            key: `zhipu-pkg-${row.tokenNo || row.id || items.length}`,
            title: row.resourcePackageName || '资源包',
            kind: 'package',
            remaining,
            unit: 'token',
            expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
            percentUsed: null,
            extra: {
              status: ZHIPU_STATUS_TEXT[status] || status,
              suitableModel: row.suitableModel || '',
              frozenBalance: toNum(row.frozenBalance),
            },
          });
        }
        if (rows.length === 0) errors.push('账号下没有资源包');
      }
    } catch (e) {
      errors.push(`资源包: ${e.message}`);
    }

    // ---- 2) GLM Coding Plan 配额 + 订阅（会话令牌优先：一个接口含配额+到期天数）----
    try {
      let limits = null;
      let subInfo = null; // { productName, daysToExpire, autoRenew }
      if (p.sessionToken) {
        // 控制台订阅总览接口（登录会话 JWT）：subscription.limits + days_to_expire + auto_renew
        const res = await fetch('https://open.bigmodel.cn/api/agent/customer-agent/v1/context', {
          method: 'GET',
          headers: {
            accept: '*/*',
            authorization: p.sessionToken,
            'content-type': 'application/json',
            origin: 'https://bigmodel.cn',
            referer: 'https://bigmodel.cn/coding-plan/personal/overview',
          },
          signal: controller.signal,
        });
        const json = await res.json();
        const sub = json && json.subscription;
        if (sub && Array.isArray(sub.limits)) {
          limits = sub.limits;
          subInfo = {
            productName: sub.product_name || null,
            daysToExpire: toNum(sub.days_to_expire),
            autoRenew: sub.auto_renew,
          };
        } else {
          errors.push('订阅总览接口未返回 limits（会话可能过期）');
        }
      }
      if (!limits) {
        // 回退：配额接口（API Key）
        const res = await fetch('https://open.bigmodel.cn/api/monitor/usage/quota/limit', {
          method: 'GET',
          headers: {
            Authorization: key,
            'Accept-Language': 'zh-CN,zh;q=0.9',
            'Content-Type': 'application/json',
          },
          signal: controller.signal,
        });
        const json = await res.json();
        if (json.code === 200 && json.data && Array.isArray(json.data.limits)) {
          limits = json.data.limits;
        } else {
          errors.push(`Coding Plan 配额查询失败(code=${json.code})${json.msg ? '：' + json.msg : ''}`);
        }
      }
      if (limits) {
        const units = { 3: '5 小时滚动额度', 6: '每周额度' };
        // 订阅到期：days_to_expire → 到期日期（约）
        let expiryIso = null;
        if (subInfo && subInfo.daysToExpire != null) {
          expiryIso = new Date(Date.now() + subInfo.daysToExpire * 86400000).toISOString();
        }
        for (const limit of limits) {
          // 实测 type 为 CREDIT_LIMIT；兼容历史 TOKENS_LIMIT
          if ((limit.type === 'CREDIT_LIMIT' || limit.type === 'TOKENS_LIMIT') && (limit.unit === 3 || limit.unit === 6)) {
            const item = {
              key: `zhipu-coding-${limit.unit}`,
              title: `Coding Plan · ${units[limit.unit]}`,
              kind: 'plan',
              planName: subInfo && subInfo.productName ? subInfo.productName : 'GLM Coding Plan',
              priceText: planPrice(cfg, 'zhipu'),
              price: planPriceNum(cfg, 'zhipu'),
              percentUsed: toNum(limit.percentage),
              unit: 'used',
              resetAt: epochToISO(limit.nextResetTime),
              expiresAt: expiryIso,
              extra: {},
            };
            // 5 小时滚动窗口未开始使用时，接口不返回重置时间 → 给出友好提示
            // （usage/remaining 绝对值语义含糊且与 percentage 矛盾，不展示，只以百分比为准）
            if (!limit.nextResetTime && !(limit.unit === 6)) {
              item.extra.resetHint = '窗口未开始使用，暂无重置时间';
            }
            items.push(item);
          }
        }
      }
    } catch (e) {
      errors.push(`Coding Plan: ${e.message}`);
    }
  } finally {
    clearTimeout(timer);
  }

  if (items.length === 0) {
    return {
      ok: false,
      items: [],
      error: '未获取到智谱额度数据',
      detail: errors.join('；') || '两个接口均无有效数据，请检查 Key 是否有效',
    };
  }
  return { ok: true, items, extra: { warnings: errors } };
}
