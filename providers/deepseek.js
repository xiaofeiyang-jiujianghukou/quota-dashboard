// DeepSeek — 账户余额 + 控制台消费统计（当天/当周/当月 + 环比）
// 余额（官方 API）: GET https://api.deepseek.com/user/balance  (Authorization: Bearer <API Key>)
// 消费（控制台接口，需会话）: GET https://platform.deepseek.com/api/v0/usage/by_api_key/{cost|amount}
//   参数 start/end（秒级 epoch）/tz（时区偏移秒）；接口单次跨度 ≤ 约 30 天，环比上月需单独查上月。
//   cost 返回 biz_data.data[].series[].buckets[].cost；amount 返回 biz_data.series[].buckets[].usage{...}
import { toNum } from './util.js';

export const id = 'deepseek';
export const name = 'DeepSeek';

// 官方模型价格（来源 https://api-docs.deepseek.com/zh-cn/quick_start/pricing，随官方调价更新）
// 单位：元 / 百万 tokens；每行「闲时/高峰」——高峰=北京时间工作日 9:00-12:00、14:00-18:00，其余闲时半价
const MODEL_PRICES = [
  { model: 'deepseek-v4-flash', input: '¥1.5 / ¥3', output: '¥4.5 / ¥9', cacheHitInput: '¥0.05 / ¥0.10' },
  { model: 'deepseek-v4-pro', input: '¥4.5 / ¥9', output: '¥13.5 / ¥27', cacheHitInput: '¥0.15 / ¥0.30' },
  { model: 'deepseek-v4-flash-vision-exp', note: '与 v4-flash 同价（图像按 token 计费）' },
];
const PRICING_AS_OF = '2026-09-05';

export async function collect(cfg) {
  const p = cfg.providers.deepseek;
  if (!p.enabled) return { ok: false, skipped: true, items: [] };

  if (!p.apiKey) {
    return {
      ok: false,
      items: [],
      error: '未配置 deepseek.apiKey',
      detail: '在 config.json 或环境变量 DEEPSEEK_API_KEY 中填写（platform.deepseek.com → API Keys）',
    };
  }

  const timeoutMs = cfg.requestTimeoutMs || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // 余额
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${p.apiKey}` },
      signal: controller.signal,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || '';
      throw new Error(`DeepSeek API 错误（HTTP ${res.status}）${msg ? '：' + msg : ''}`);
    }
    const infos = json.balance_infos || [];
    if (infos.length === 0) {
      return { ok: false, items: [], error: '余额接口返回空', detail: JSON.stringify(json).slice(0, 200) };
    }
    const items = infos.map((b) => {
      const total = toNum(b.total_balance);
      const granted = toNum(b.granted_balance);
      const topped = toNum(b.topped_up_balance);
      const parts = [];
      if (topped != null) parts.push(`充值 ¥${topped}`);
      if (granted != null) parts.push(`赠金 ¥${granted}`);
      parts.push('预充值制，无套餐到期');
      return {
        key: `deepseek-balance-${b.currency || 'balance'}`,
        title: `账户余额 · ${b.currency || ''}`,
        kind: 'balance',
        remaining: total,
        unit: '¥',
        percentUsed: null,
        extra: {
          note: parts.join(' · '),
          isAvailable: json.is_available ?? null,
          grantedBalance: granted,
          toppedUpBalance: topped,
        },
      };
    });

    // 消费统计（需要控制台会话）
    if (p.sessionToken && p.sessionCookie) {
      try {
        const usage = await fetchUsage(p, timeoutMs);
        items.push(...usage);
      } catch (e) {
        items.push({
          key: 'deepseek-usage-error',
          title: '消费统计',
          kind: 'info',
          extra: { note: '获取失败：' + e.message },
        });
      }
    }
    // 官方模型价格（静态条目，随 MODEL_PRICES 更新；便于免去官网查询）
    items.push({
      key: 'deepseek-pricing-header',
      title: '模型价格 · 元/百万token',
      kind: 'info',
      extra: { note: `格式：闲时/高峰（高峰=工作日 9-12/14-18 北京时间，闲时半价）· 摘自官方定价页 ${PRICING_AS_OF}` },
    });
    for (const mp of MODEL_PRICES) {
      items.push({
        key: `deepseek-pricing-${mp.model}`,
        title: mp.model,
        kind: 'info',
        extra: {
          note: mp.note
            ? mp.note
            : `输入 ${mp.input}（缓存未命中）/ 缓存命中输入 ${mp.cacheHitInput} ｜ 输出 ${mp.output}`,
        },
      });
    }
    return { ok: true, items };
  } catch (e) {
    return { ok: false, items: [], error: e.message, detail: 'https://api.deepseek.com/user/balance' };
  } finally {
    clearTimeout(timer);
  }
}

// ---- 控制台消费统计 ----

function headers(p) {
  return {
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    authorization: `Bearer ${p.sessionToken}`,
    cookie: p.sessionCookie,
    referer: 'https://platform.deepseek.com/usage',
    'user-agent': 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36',
    'x-client-platform': 'web',
    'x-client-timezone-offset': '28800',
    'x-client-version': '1.0.0',
  };
}

async function fetchJson(url, p, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: headers(p), signal: controller.signal });
    const j = await r.json().catch(() => null);
    return (j && j.data && j.data.biz_data) || {};
  } finally {
    clearTimeout(t);
  }
}

/** cost 聚合：biz_data.data[].series[].buckets[].cost → { time: 总值 } */
function aggCost(bd) {
  const d = {};
  for (const g of bd.data || []) {
    for (const s of g.series || []) {
      for (const b of s.buckets || []) {
        d[b.time] = (d[b.time] || 0) + toNum(b.cost);
      }
    }
  }
  return d;
}

/** amount 聚合：biz_data.series[].buckets[].usage{...} → { time: 总 token } */
function aggToken(bd) {
  const d = {};
  for (const s of bd.series || []) {
    for (const b of s.buckets || []) {
      const u = b.usage || {};
      let t = 0;
      for (const v of Object.values(u)) t += toNum(v);
      d[b.time] = (d[b.time] || 0) + t;
    }
  }
  return d;
}

function sum(d, a, b) {
  let s = 0;
  for (const [t, v] of Object.entries(d)) {
    const tt = Number(t);
    if (tt >= a && tt < b) s += v;
  }
  return s;
}

function fmtMoney(v) {
  return '¥' + v.toFixed(2);
}
function fmtToken(v) {
  if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
  if (v >= 1e4) return (v / 1e4).toFixed(0) + ' 万';
  return String(Math.round(v));
}
function pct(cur, prev) {
  if (!prev) return cur > 0 ? '新增' : '—';
  const d = ((cur - prev) / prev) * 100;
  return (d >= 0 ? '+' : '') + d.toFixed(1) + '%';
}

/** 高峰时段：北京时间周一至周五 9:00-12:00、14:00-18:00（其余为空闲；空闲价格为高峰一半）。
 *  接口按整点小时桶返回，窗口边界均落在整点，按桶起点判定即可。 */
function isPeakBucket(timeSec) {
  const bj = new Date((timeSec + 8 * 3600) * 1000);
  const wd = bj.getUTCDay(); // 0=周日
  if (wd === 0 || wd === 6) return false;
  const h = bj.getUTCHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/** 当前峰谷状态文案（北京时间实时计算） */
function currentPeriod() {
  const bj = new Date(Date.now() + 8 * 3600 * 1000);
  const wd = bj.getUTCDay();
  const h = bj.getUTCHours();
  if (wd === 0 || wd === 6) return '当前空闲（周末全天半价）';
  if (h < 9) return '当前空闲（9:00 进入高峰）';
  if (h < 12) return '当前高峰（12:00 进入午休闲时）';
  if (h < 14) return '当前空闲·午休（14:00 进入高峰）';
  if (h < 18) return '当前高峰（18:00 结束）';
  return '当前空闲（明早 9:00 进入高峰）';
}

async function fetchUsage(p, timeoutMs) {
  const now = Math.floor(Date.now() / 1000);
  const d8 = new Date((now + 8 * 3600) * 1000);
  const Y = d8.getUTCFullYear();
  const M = d8.getUTCMonth() + 1;
  const D = d8.getUTCDate();
  const wd = d8.getUTCDay(); // 0=周日
  const ds = (yy, mm, dd) => Math.floor((Date.UTC(yy, mm - 1, dd) - 8 * 3600 * 1000) / 1000);

  const monthStart = ds(Y, M, 1);
  const nextMonth = ds(Y, M + 1, 1);
  const lastMonth = ds(Y, M - 1, 1);
  const today = ds(Y, M, D);
  const tomorrow = ds(Y, M, D + 1);
  const yesterday = ds(Y, M, D - 1);
  const mondayOffset = (wd + 6) % 7;
  const weekStart = ds(Y, M, D - mondayOffset);
  const lastWeekStart = ds(Y, M, D - mondayOffset - 7);

  // 消费：查本月 + 上月（各 ≤ 30 天）
  const costCur = aggCost(await fetchJson(`https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=${monthStart}&end=${nextMonth}&tz=28800`, p, timeoutMs));
  const costPrev = aggCost(await fetchJson(`https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=${lastMonth}&end=${monthStart}&tz=28800`, p, timeoutMs));
  const tokCur = aggToken(await fetchJson(`https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=${monthStart}&end=${nextMonth}&tz=28800`, p, timeoutMs));
  const tokPrev = aggToken(await fetchJson(`https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=${lastMonth}&end=${monthStart}&tz=28800`, p, timeoutMs));

  const todayCost = sum(costCur, today, tomorrow);
  const yesterdayCost = sum(costCur, yesterday, today);
  const weekCost = sum(costCur, weekStart, tomorrow);
  const lastWeekCost = sum(costCur, lastWeekStart, weekStart) + sum(costPrev, lastWeekStart, monthStart);
  const monthCost = sum(costCur, monthStart, nextMonth);
  const lastMonthCost = sum(costPrev, lastMonth, monthStart);

  const todayTok = sum(tokCur, today, tomorrow);
  const weekTok = sum(tokCur, weekStart, tomorrow);
  const monthTok = sum(tokCur, monthStart, nextMonth);

  // 今日分时（小时桶）：高峰=工作日 9-12 / 14-18，其余为空闲
  const costHourly = aggCost(await fetchJson(`https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=${today}&end=${tomorrow}&tz=28800`, p, timeoutMs));
  const tokHourly = aggToken(await fetchJson(`https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=${today}&end=${tomorrow}&tz=28800`, p, timeoutMs));
  const peak = { cost: 0, tok: 0 };
  const idle = { cost: 0, tok: 0 };
  for (const [t, v] of Object.entries(costHourly)) (isPeakBucket(Number(t)) ? peak : idle).cost += v;
  for (const [t, v] of Object.entries(tokHourly)) (isPeakBucket(Number(t)) ? peak : idle).tok += v;

  const items = [];
  items.push({
    key: 'deepseek-peak-schedule',
    title: '峰谷时段',
    kind: 'info',
    extra: { note: `高峰 工作日 9:00-12:00 / 14:00-18:00 ｜ 空闲 其余时段（半价）· ${currentPeriod()}` },
  });
  items.push({
    key: 'deepseek-usage-today',
    title: '今日消费',
    kind: 'info',
    extra: { note: `${fmtMoney(todayCost)} · ${fmtToken(todayTok)} token · 环比昨日 ${pct(todayCost, yesterdayCost)}` },
  });
  const splitTotal = peak.cost + idle.cost;
  items.push({
    key: 'deepseek-usage-today-split',
    title: '今日分时',
    kind: 'info',
    extra: {
      note:
        `高峰 ¥${peak.cost.toFixed(2)} · ${fmtToken(peak.tok)} token ｜ 空闲 ¥${idle.cost.toFixed(2)} · ${fmtToken(idle.tok)} token` +
        (splitTotal > 0 ? ` · 峰时占 ${((peak.cost / splitTotal) * 100).toFixed(0)}%` : ''),
      peakCost: +peak.cost.toFixed(2),
      idleCost: +idle.cost.toFixed(2),
      peakToken: peak.tok,
      idleToken: idle.tok,
    },
  });
  items.push({
    key: 'deepseek-usage-week',
    title: '本周消费',
    kind: 'info',
    extra: { note: `${fmtMoney(weekCost)} · ${fmtToken(weekTok)} token · 环比上周 ${pct(weekCost, lastWeekCost)}` },
  });
  items.push({
    key: 'deepseek-usage-month',
    title: '本月消费',
    kind: 'info',
    extra: {
      note:
        `${fmtMoney(monthCost)} · ${fmtToken(monthTok)} token · 环比上月 ${pct(monthCost, lastMonthCost)}` +
        (p.budgetMonthly > 0
          ? ` · 预算 ${fmtMoney(p.budgetMonthly)} ${((monthCost / p.budgetMonthly) * 100).toFixed(0)}%`
          : ''),
      monthCost,
      budgetMonthly: toNum(p.budgetMonthly),
    },
  });

  // 本月单日最高 / 日均（仅统计有调用的天数，0 消费日不计入）
  const dayMap = {}; // 北京日序号 → 当日消费
  for (const [t, v] of Object.entries(costCur)) {
    const k = Math.floor((Number(t) + 8 * 3600) / 86400);
    if (Number(t) >= monthStart && Number(t) < nextMonth) dayMap[k] = (dayMap[k] || 0) + v;
  }
  const activeDays = Object.entries(dayMap).filter(([, v]) => v > 0);
  const maxDay = activeDays.reduce((m, [k, v]) => (v > m.v ? { k, v } : m), { k: 0, v: -1 });
  const avgDaily = activeDays.length
    ? activeDays.reduce((s, [, v]) => s + v, 0) / activeDays.length
    : 0;
  const maxDate = maxDay.v > 0 ? new Date((maxDay.k * 86400 + 8 * 3600) * 1000) : null;
  items.push({
    key: 'deepseek-usage-month-daily',
    title: '本月日均/最高',
    kind: 'info',
    extra: {
      note: maxDate
        ? `日均 ${fmtMoney(avgDaily)}（${activeDays.length} 个调用日，0 消费日不计）· 单日最高 ${fmtMoney(maxDay.v)}（${maxDate.getUTCMonth() + 1}月${maxDate.getUTCDate()}日）`
        : '本月暂无消费',
      avgDailyCost: +avgDaily.toFixed(2),
      maxDailyCost: maxDay.v > 0 ? +maxDay.v.toFixed(2) : 0,
      activeDays: activeDays.length,
    },
  });
  return items;
}
