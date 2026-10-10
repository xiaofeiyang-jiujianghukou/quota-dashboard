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

export async function collect(cfg, pid = id) {
  const p = cfg.providers[pid];
  if (!p.enabled) return { ok: false, skipped: true, items: [] };

  // 鉴权二选一：① API Key（apiKey/codingPlanKey）② 控制台会话（sessionToken + sessionCookie，无需 Key）
  const key = p.apiKey || p.codingPlanKey;
  const hasSession = !!(p.sessionToken && p.sessionCookie);
  if (!key && !hasSession) {
    return {
      ok: false,
      items: [],
      error: '智谱未授权',
      detail: '配置页点「授权登录」，在打开的官网窗口登录一次即可（无需手动填 Key）',
    };
  }
  // 有会话时走控制台通道（与页面同一套接口，数据完全一致）
  if (!key && hasSession) return collectBySession(cfg, p, pid);

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
        // 收集各窗口总额度 → 组合成套餐额度说明（卡片级展示）
        const totalsByUnit = {};
        for (const limit of limits) {
          if ((limit.type === 'CREDIT_LIMIT' || limit.type === 'TOKENS_LIMIT') && (limit.unit === 3 || limit.unit === 6)) {
            const t = toNum(limit.usage);
            if (t != null && t > 0) totalsByUnit[limit.unit] = t;
          }
        }
        const quotaParts = [];
        if (totalsByUnit[3]) quotaParts.push(`5h ${totalsByUnit[3]}`);
        if (totalsByUnit[6]) quotaParts.push(`周 ${totalsByUnit[6]}`);
        const planQuota = quotaParts.length > 0 ? quotaParts.join(' · ') : '';
        // 周额度（unit 6）是硬上限：用尽后 5 小时窗口即使有剩余也不可用，需在 5h 行体现
        const weeklyLimit = limits.find(
          (l) => (l.type === 'CREDIT_LIMIT' || l.type === 'TOKENS_LIMIT') && l.unit === 6
        );
        const weeklyRem = weeklyLimit ? toNum(weeklyLimit.remaining) : null;
        const weeklyPct = weeklyLimit ? toNum(weeklyLimit.percentage) : null;
        const weeklyExhausted = (weeklyRem != null && weeklyRem <= 0) || (weeklyPct != null && weeklyPct >= 100);
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
              quotaText: planQuota,
              percentUsed: toNum(limit.percentage),
              unit: 'used',
              resetAt: epochToISO(limit.nextResetTime),
              expiresAt: expiryIso,
              extra: {},
            };
            // usage=周期总额度, remaining=剩余（与 percentage 一致，实测验证）
            const _total = toNum(limit.usage);
            const _rem = toNum(limit.remaining);
            if (_total != null && _total > 0) {
              item.total = _total;
              item.remaining = _rem != null ? _rem : _total;
              item.used = _total - (item.remaining || 0);
            }
            // 周额度（unit 6）用尽后，5 小时窗口即使有余量也不可用：照常显示用量，但标红提醒
            if (limit.unit === 3 && weeklyExhausted) {
              item.extra.alert = true;
              item.extra.note = '周额度已用尽 · 5 小时窗口暂不可用';
            }
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

/**
 * 控制台会话通道（无需 API Key）：用登录 JWT + Cookie 调控制台自己的接口。
 * 与网页上看到的数据同源（额度百分比、套餐档位、价格、有效期）。
 */
async function collectBySession(cfg, p, pid) {
  const timeoutMs = cfg.requestTimeoutMs || 30000;
  const headers = {
    authorization: String(p.sessionToken).replace(/^Bearer\s+/i, ''),
    cookie: p.sessionCookie,
    accept: 'application/json, text/plain, */*',
    referer: 'https://open.bigmodel.cn/coding-plan/personal/overview',
  };
  const items = [];
  const get = async (path) => {
    const res = await fetch('https://open.bigmodel.cn' + path, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const json = await res.json().catch(() => null);
    if (!json) throw new Error(`返回非 JSON（HTTP ${res.status}）`);
    if (json.success === false) throw new Error(json.msg || `接口失败（${json.code}）`);
    return json.data;
  };

  // 1) 额度：limits[] → 每个窗口一条
  let quotaOk = false;
  try {
    const data = await get('/api/monitor/usage/quota/limit');
    const UNIT = { 1: '每日', 2: '每月', 3: '5 小时', 6: '每周' };
    for (const l of data.limits || []) {
      const label = UNIT[l.unit] || `窗口${l.unit}`;
      items.push({
        key: `zhipu-quota-${l.unit}`,
        title: `Coding Plan · ${label}额度`,
        kind: 'plan',
        total: toNum(l.usage),
        used: toNum(l.currentValue),
        remaining: toNum(l.remaining),
        percentUsed: toNum(l.percentage),
        unit: 'used',
        resetAt: epochToISO(l.nextResetTime),
        planName: data.level ? `GLM Coding ${String(data.level).toUpperCase()}` : '',
        extra: { source: 'console' },
      });
      quotaOk = true;
    }
  } catch (e) {
    items.push({ key: 'zhipu-quota-error', title: 'Coding Plan 额度', kind: 'info', extra: { note: '获取失败：' + e.message } });
  }

  // 2) 套餐档位/价格/有效期（会话接口）
  try {
    const list = await get('/api/biz/subscription/list');
    const subs = Array.isArray(list) ? list.filter((x) => x && (x.status === 'VALID' || x.status === 'EXPIRING')) : [];
    const sub = subs[0] || null;
    if (sub) {
      // valid 形如 "2026-11-28 10:00:00-2027-02-28 10:00:00"：日期自带横杠，必须用正则取两端
      const spans = String(sub.valid || '').match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/g) || [];
      const start = spans[0] || '';
      const end = spans[spans.length - 1] || '';
      let expiresAt = null;
      if (end) {
        const d = new Date(end.replace(' ', 'T') + '+08:00');
        expiresAt = Number.isNaN(d.getTime()) ? null : d.toISOString();
      }
      const planItem = items.find((i) => i.kind === 'plan');
      const target = planItem || items[0];
      if (target) {
        const names = [...new Set(subs.map((x) => x.productName).filter(Boolean))];
        const price = toNum(sub.actualPrice ?? sub.standardPrice);
        const cycleText = sub.billingCycle === 'quarterly' ? '季' : sub.billingCycle === 'yearly' ? '年' : '月';
        // 套餐信息应用到所有额度条目（同一份订阅），每行都能看到套餐名/价格/到期
        for (const it of items.filter((x) => x.kind === 'plan')) {
          it.planName = names.length ? names.join(' + ') : it.planName;
          it.price = price;
          it.pricePeriod = sub.billingCycle || 'monthly';
          it.priceText = price != null ? `¥${price}/${cycleText}` : '';
          if (expiresAt) it.expiresAt = expiresAt;
          it.extra = { ...(it.extra || {}), autoRenew: sub.autoRenew === 1, validFrom: start || null };
        }
      }
      // 额外给一条纯信息来源，便于核对
      if (!planItem) {
        items.push({
          key: 'zhipu-subscription',
          title: `套餐 · ${sub.productName || 'GLM Coding Plan'}`,
          kind: 'info',
          expiresAt: expiresAt || undefined,
          extra: { note: `批次 ${sub.currentPeriod || 1} · ${sub.autoRenew === 1 ? '自动续费' : '不自动续费'} · 有效期至 ${end ? end.trim() : '未知'}` },
        });
      }
    }
  } catch {
    /* 套餐信息失败不影响额度展示 */
  }

  if (!items.length) {
    return { ok: false, items: [], error: '控制台会话未能取到数据（会话可能已过期，请重新授权登录）' };
  }
  return { ok: quotaOk || items.some((i) => i.kind === 'plan' || i.kind === 'info'), items };
}
