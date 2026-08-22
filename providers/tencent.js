// 混元（腾讯云）— 混元大模型 Token Plan 套餐余量/到期
// 数据源: hunyuan.tencentcloudapi.com（Version 2023-09-01，TC3-HMAC-SHA256 签名）
//   ListUserTokenPlans     → UserTokenPlanList[]: Plan/Edition/Level/QuotaStatus/
//                            StartTime/ExpireTime/ResourceID/RenewFlag
//   DescribeTokenPlanUsage → TokenPlanUsageList[]: TokenPlanResource
//                            (CycleCapacity/CycleRemain/CycleTotalUsage/RemainCycles/DailyUsageList)
// 注: 用户实际购买的混元套餐走 hunyuan 产品线，而非 TokenHub 平台（DescribeTokenPlanList 为空）
import { tc3Request } from '../lib/tc3.js';
import { planPrice, planPriceNum } from '../lib/pricing.js';
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

function planDisplayName(plan, cfg) {
  if (cfg.providers.tencent.planName) return cfg.providers.tencent.planName; // 用户自定义覆盖
  if (plan.Plan && TEN_CENT_PLAN_NAMES[plan.Plan]) return TEN_CENT_PLAN_NAMES[plan.Plan];
  return plan.Plan ? `混元 Token Plan · ${plan.Plan}（${editionText(plan.Edition)}）` : '混元 Token Plan';
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

    const extra = {
      quotaStatus: quotaStatusText(plan.QuotaStatus),
      status: quotaStatusText(plan.QuotaStatus) || null,
      remainCycles: res ? res.RemainCycles : null,
      startTime: plan.StartTime || null,
      // 当前计费周期用量明细（input/output/cache token）
      cycleUsage: {
        total: used,
        input: toNum(res && res.CycleInputUsage),
        output: toNum(res && res.CycleOutputUsage),
        cache: toNum(res && res.CycleCacheUsage),
      },
      todayUsage: today
        ? { date: today.Date, total: toNum(today.TotalUsage), input: toNum(today.InputUsage), output: toNum(today.OutputUsage) }
        : null,
    };

    items.push({
      key: `tencent-hunyuan-${plan.Plan || 'plan'}`,
      title: planDisplayName(plan, cfg),
      kind: 'plan',
      planName: null, // 标题已含完整套餐名，避免重复展示；金额单列
      priceText: planPrice(cfg, 'tencent', plan.Plan),
      price: planPriceNum(cfg, 'tencent', plan.Plan),
      total,
      used,
      remaining,
      percentUsed: total ? (used / total) * 100 : null,
      unit: 'token',
      expiresAt: bjToISO(plan.ExpireTime),
      extra,
    });
  }

  return { ok: true, items };
}
