// 混元（腾讯云）— 混元大模型 Token Plan 套餐余量/到期
// 数据源: hunyuan.tencentcloudapi.com（Version 2023-09-01，TC3-HMAC-SHA256 签名）
//   ListUserTokenPlans     → UserTokenPlanList[]: Plan/Edition/Level/QuotaStatus/
//                            StartTime/ExpireTime/ResourceID/RenewFlag
//   DescribeTokenPlanUsage → TokenPlanUsageList[]: TokenPlanResource
//                            (CycleCapacity/CycleRemain/CycleTotalUsage/RemainCycles/DailyUsageList)
// ⚠ 2026-08-31 17:00 起，Token Plan 个人版计量单位由 token 改为"积分"（1:1 数值迁移）。
//   CycleCapacity/CycleRemain/CycleTotalUsage 现单位均为积分；实际可调用的 token 数
//   按 模型×档位 抵扣系数 换算（1 积分 ≈ 1,000,000/系数 token）。详见：
//   https://cloud.tencent.com/document/product/1823/133811
// 注: 用户实际购买的混元套餐走 hunyuan 产品线，而非 TokenHub 平台（DescribeTokenPlanList 为空）
import { tc3Request } from '../lib/tc3.js';
import { planPrice, planPriceNum, planQuotaText } from '../lib/pricing.js';
import { toNum } from './util.js';

export const id = 'tencent';
export const name = '混元';

const HOST = 'hunyuan.tencentcloudapi.com';
const VERSION = '2023-09-01';
const SERVICE = 'hunyuan';

function quotaStatusText(v) {
  const n = toNum(v);
  if (n === 1) return '生效中';
  if (n === 0) return '未生效';
  return v == null ? '' : String(v);
}

function editionText(e) {
  return { personal: '个人版', team: '团队版', enterprise: '企业版' }[e] || e || '';
}

// 腾讯云 Token Plan 官方档位名（活动页 2026-08）：
//   通用 Token Plan（DeepSeek/MiniMax/GLM/Kimi 等主流国产模型）个人版：
//     tp_lite=体验套餐 Lite ¥39/月（3500万）、tp_standard=基础套餐 Standard ¥99/月（1亿）、
//     tp_pro=进阶套餐 Pro ¥299/月（3.2亿）、tp_max=专业套餐 Max
//   注：Hy Token Plan（混元 Hy3 专属）同档位名但价格不同（Lite ¥28）；接口不区分家族，
//       如需显示 Hy 家族或自定义名称，用 config 的 tencent.planName 覆盖
const TEN_CENT_PLAN_NAMES = {
  tp_lite: '通用 Token Plan · 个人版 Lite（体验套餐）',
  tp_standard: '通用 Token Plan · 个人版 Standard（基础套餐）',
  tp_pro: '通用 Token Plan · 个人版 Pro（进阶套餐）',
  tp_max: '通用 Token Plan · 个人版 Max（专业套餐）',
};

// 2026-08-31 17:00 起，Token Plan 个人版改用"积分"为单位（数值口径未变：原 3500万 token = 现 3500万 积分）。
// 抵扣规则：单次请求积分 = (未缓存输入token×系数 + 输出token×系数 + 缓存命中token×系数) / 1,000,000，
//   且不同模型族/档位系数不同（官方文档会持续更新）。因此"积分 ↔ 可用 token"不能简单换算，
//   本看板按腾讯云控制台同口径展示积分余量（CycleCapacity/CycleRemain 即积分），换算以控制台/官方文档为准。
// 参考系数（文档 2026-08-31，仅展示不换算）：通用档 Auto 等存量模型 Lite 22.285 / Std 19.8 / Pro 18.687 / Max 18.43；
//   Hy 档 Hy3: 16 / 15.6 / 14.875 / 14.4
const POINTS_FACTORS = {
  universal: { tp_lite: 22.285, tp_standard: 19.8, tp_pro: 18.687, tp_max: 18.43 },
  hy: { tp_lite: 16, tp_standard: 15.6, tp_pro: 14.875, tp_max: 14.4 },
};

/** 根据套餐名/描述推断家族（通用 vs Hy Token Plan）；不匹配返回通用作为兜底 */
function detectPlanFamily(plan) {
  const s = `${plan.Plan || ''} ${plan.PlanName || ''} ${plan.Description || ''} ${plan.ProductName || ''}`;
  if (/Hy|hy3|混元自有|Hy\s*Token/i.test(s)) return 'hy';
  return 'universal';
}

function planDisplayName(plan, cfg) {
  if (cfg.providers.tencent.planName) return cfg.providers.tencent.planName; // 用户自定义覆盖
  if (plan.Plan && TEN_CENT_PLAN_NAMES[plan.Plan]) return TEN_CENT_PLAN_NAMES[plan.Plan];
  return plan.Plan ? `混元 Token Plan · ${plan.Plan}（${editionText(plan.Edition)}）` : '混元 Token Plan';
}

/** 大数友好格式化：35000000 → 3500万；1249000000 → 12.49亿；1.57e12 → 1.57万亿 */
function fmtBig(n) {
  if (n == null) return '';
  if (n >= 1e12) return (n / 1e12).toFixed(n % 1e12 === 0 ? 0 : 2) + '万亿';
  if (n >= 1e8) return (n / 1e8).toFixed(n % 1e8 === 0 ? 0 : 2) + '亿';
  if (n >= 1e4) return (n / 1e4).toFixed(n % 1e4 === 0 ? 0 : 1) + '万';
  return String(n);
}

/** "2026-09-21 09:22:59"（北京时区无后缀）或 RFC3339 → ISO */
function bjToISO(s) {
  if (!s) return null;
  const str = String(s).trim();
  const direct = new Date(str);
  if (!Number.isNaN(direct.getTime())) return direct.toISOString();
  const d = new Date(str.replace(' ', 'T') + '+08:00');
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export async function collect(cfg) {
  const p = cfg.providers.tencent;
  if (!p.enabled) return { ok: false, skipped: true, items: [] };

  if (!p.secretId || !p.secretKey) {
    return {
      ok: false,
      items: [],
      error: '未配置 tencent.secretId / secretKey',
      detail: '在腾讯云访问管理 CAM 创建 API 密钥后填入 config.json（或 TENCENT_SECRET_ID / TENCENT_SECRET_KEY 环境变量）',
    };
  }

  const common = {
    secretId: p.secretId,
    secretKey: p.secretKey,
    region: p.region || 'ap-guangzhou',
    service: SERVICE,
    host: HOST,
    version: VERSION,
  };

  // 1) 套餐列表
  let plans = [];
  try {
    const list = await tc3Request({ ...common, action: 'ListUserTokenPlans', payload: {} });
    plans = list.UserTokenPlanList || [];
  } catch (e) {
    return { ok: false, items: [], error: '查询混元套餐列表失败', detail: e.message };
  }
  if (plans.length === 0) {
    return {
      ok: false,
      items: [],
      error: '账号下没有混元 Token Plan 套餐',
      detail: 'ListUserTokenPlans 返回空；若购买的是混元资源包而非 Token Plan，请告知，可换用 DescribePidOrders/DescribePkg 接口',
    };
  }

  // 2) 套餐用量
  let usageList = [];
  try {
    const usage = await tc3Request({ ...common, action: 'DescribeTokenPlanUsage', payload: {} });
    usageList = usage.TokenPlanUsageList || [];
  } catch (e) {
    return { ok: false, items: [], error: '查询混元套餐用量失败', detail: e.message };
  }

  const items = [];
  for (const plan of plans) {
    const pkg = plan.TokenPlanPackage || {};
    const u =
      usageList.find((x) => x.TokenPlanPackage && x.TokenPlanPackage.ResourceId === plan.ResourceID) ||
      usageList.find((x) => x.TokenPlanPackage && x.TokenPlanPackage.Plan === plan.Plan) ||
      null;
    const res = u ? u.TokenPlanResource : null;

    const total = toNum(res && res.CycleCapacity);
    const remaining = toNum(res && res.CycleRemain);
    const used = toNum(res && res.CycleTotalUsage);
    const daily = (res && res.DailyUsageList) || [];
    const today = daily.length > 0 ? daily[daily.length - 1] : null;

    // 积分制：CycleCapacity/CycleRemain/CycleTotalUsage 单位均为积分（与控制台同口径）
    const family = detectPlanFamily(plan);
    const factor = (POINTS_FACTORS[family] || POINTS_FACTORS.universal)[plan.Plan] || null;

    const extra = {
      quotaStatus: quotaStatusText(plan.QuotaStatus),
      status: quotaStatusText(plan.QuotaStatus) || null,
      remainCycles: res ? res.RemainCycles : null,
      startTime: plan.StartTime || null,
      // 当前计费周期用量明细（单位：积分）
      cycleUsage: {
        total: used,
        input: toNum(res && res.CycleInputUsage),
        output: toNum(res && res.CycleOutputUsage),
        cache: toNum(res && res.CycleCacheUsage),
      },
      todayUsage: today
        ? { date: today.Date, total: toNum(today.TotalUsage), input: toNum(today.InputUsage), output: toNum(today.OutputUsage) }
        : null,
      // 2026-08-31 起改为积分制（抵扣系数随模型族/档位变化，此处仅记录，不换算成 token）
      unitLabel: '积分',
      pointsFamily: family === 'hy' ? 'Hy Token Plan' : '通用 Token Plan',
      pointsFactor: factor,
    };

    items.push({
      key: `tencent-hunyuan-${plan.Plan || 'plan'}`,
      title: planDisplayName(plan, cfg),
      kind: 'plan',
      planName: null, // 标题已含完整套餐名，避免重复展示；金额单列
      priceText: planPrice(cfg, 'tencent', plan.Plan),
      price: planPriceNum(cfg, 'tencent', plan.Plan),
      quotaText: total != null ? `周期 ${fmtBig(total)} 积分` : planQuotaText(cfg, 'tencent', plan.Plan),
      total,
      used,
      remaining,
      percentUsed: total ? (used / total) * 100 : null,
      unit: '积分',
      expiresAt: bjToISO(plan.ExpireTime),
      extra,
    });
  }

  return { ok: true, items };
}
