// 配置加载：config.json（全局设置）+ SQLite（供应商授权与生命周期）
// 数据分层：config.json = port/authToken/alert/pricing 等全局项；
//          providers（凭据/启停/有效期）落库 data/dashboard.db，由配置页在线管理。
import fs from 'node:fs';
import {
  ROOT_DIR,
  CONFIG_PATH,
  EXAMPLE_CONFIG_PATH,
} from './config.paths.js';
import {
  allProviders as dbAllProviders,
  getCredentials as dbGetCredentials,
  migrateFromConfigJson,
  upsertProvider,
} from './store.js';
import { ADAPTERS, typeOf } from '../providers/index.js';

export { ROOT_DIR, CONFIG_PATH, EXAMPLE_CONFIG_PATH };

const DEFAULT_CONFIG = {
  port: 8899,
  authToken: '', // 写接口鉴权 token（上云时设置，扩展同步会话需携带；留空=不鉴权，仅本机使用）
  refreshIntervalSec: 60,
  requestTimeoutMs: 30000,
  providers: {
    ark: { type: 'ark', name: '方舟', enabled: true, region: 'cn-beijing', planTier: '', expiresAt: '', sessionCookie: '', csrfToken: '' },
    ark2: { type: 'ark', name: '方舟②', enabled: false, region: 'cn-beijing', planTier: '', expiresAt: '', sessionCookie: '', csrfToken: '' },
    zhipu: { type: 'zhipu', name: '智谱', enabled: true, apiKey: '', codingPlanKey: '', sessionToken: '', expiresAt: '' },
    minimax: { type: 'minimax', name: 'MiniMax', enabled: true, apiKey: '', host: 'https://www.minimaxi.com', planName: '', sessionCookie: '', groupId: '', expiresAt: '' },
    deepseek: { type: 'deepseek', name: 'DeepSeek', enabled: true, apiKey: '', sessionToken: '', sessionCookie: '', budgetMonthly: 0, expiresAt: '' },
  },
  pricing: {}, // 套餐价格覆盖：{ ark: { lite: '¥xx/月' }, ... }，留空用内置默认价
  alert: {
    enabled: true,
    wecom: { enabled: true, chatName: '' }, // chatName 留空 = 发给授权人自己
    rules: { remainingPercentBelow: 20, expiresWithinDays: 3, balanceBelow: 10, peakNotify: true },
    dailyDigest: true,
  },
};

function deepMerge(base, override) {
  if (Array.isArray(base)) return override ?? base;
  if (base && typeof base === 'object' && override && typeof override === 'object') {
    const out = { ...base };
    for (const k of Object.keys(override)) out[k] = deepMerge(base[k], override[k]);
    return out;
  }
  return override ?? base;
}

export function loadConfig() {
  let fileCfg = {};
  // config.json 变成"可选"：不存在时用 config.example.json 作为默认全局设置（只读，不生成文件）
  const cfgPath = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : EXAMPLE_CONFIG_PATH;
  if (fs.existsSync(cfgPath)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch (e) {
      console.error(`[config] 解析 ${path.basename(cfgPath)} 失败: ${e.message}`);
    }
  }

  // 首次落库迁移：旧 config.json 里的 providers（凭据/启停/有效期）一次性导入 SQLite
  try {
    const n = migrateFromConfigJson(fileCfg.providers);
    if (n > 0) console.log(`[store] 已迁移 ${n} 个供应商的授权配置 → ${ROOT_DIR}/data/dashboard.db`);
  } catch (e) {
    console.error('[store] 迁移失败:', e.message);
  }

  const cfg = deepMerge(DEFAULT_CONFIG, fileCfg);

  // 实例清单只以 SQLite 为准（删除实例 = 删 DB 行，即真正消失，不再被默认配置复活）。
  // 空库时 store.init 已播种 7 个默认实例。
  const dbRows = dbAllProviders();
  const merged = {};
  for (const [pid, row] of Object.entries(dbRows)) {
    const base = { ...(DEFAULT_CONFIG.providers[pid] || {}) };
    base.enabled = row.enabled;
    base.expiresAt = row.expiresAt || ''; // 平台接口拉取后自动落库的有效期
    base.expiresFetchedAt = row.expiresFetchedAt || ''; // 最近一次拉取时刻
    Object.assign(base, row.extra || {}); // 杂项配置（region/host/budgetMonthly/type/name...）
    Object.assign(base, dbGetCredentials(pid)); // 凭据优先级最高
    // 实例身份兜底：老行缺 type/name 时推导
    if (!base.type) base.type = typeOf(pid);
    if (!base.name) base.name = ADAPTERS[base.type]?.name || pid;
    merged[pid] = base;
  }
  cfg.providers = merged;

  // 环境变量覆盖
  const env = process.env;
  const num = (v, d) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
  if (env.QUOTA_PORT) cfg.port = num(env.QUOTA_PORT, cfg.port);
  if (env.QUOTA_AUTH_TOKEN) cfg.authToken = env.QUOTA_AUTH_TOKEN;
  if (env.QUOTA_REFRESH_SEC) cfg.refreshIntervalSec = num(env.QUOTA_REFRESH_SEC, cfg.refreshIntervalSec);
  if (env.QUOTA_TIMEOUT_MS) cfg.requestTimeoutMs = num(env.QUOTA_TIMEOUT_MS, cfg.requestTimeoutMs);
  if (env.ZHIPU_API_KEY) if (cfg.providers.zhipu) cfg.providers.zhipu.apiKey = env.ZHIPU_API_KEY;
  if (env.ZHIPU_CODING_PLAN_KEY) if (cfg.providers.zhipu) cfg.providers.zhipu.codingPlanKey = env.ZHIPU_CODING_PLAN_KEY;
  if (env.ZHIPU_SESSION_TOKEN) if (cfg.providers.zhipu) cfg.providers.zhipu.sessionToken = env.ZHIPU_SESSION_TOKEN;
  if (env.MINIMAX_API_KEY) if (cfg.providers.minimax) cfg.providers.minimax.apiKey = env.MINIMAX_API_KEY;
  if (env.MINIMAX_API_HOST) if (cfg.providers.minimax) cfg.providers.minimax.host = env.MINIMAX_API_HOST;
  if (env.MINIMAX_SESSION_COOKIE) if (cfg.providers.minimax) cfg.providers.minimax.sessionCookie = env.MINIMAX_SESSION_COOKIE;
  if (env.MINIMAX_GROUP_ID) if (cfg.providers.minimax) cfg.providers.minimax.groupId = env.MINIMAX_GROUP_ID;
  if (env.DEEPSEEK_API_KEY) if (cfg.providers.deepseek) cfg.providers.deepseek.apiKey = env.DEEPSEEK_API_KEY;
  if (env.DEEPSEEK_SESSION_TOKEN) if (cfg.providers.deepseek) cfg.providers.deepseek.sessionToken = env.DEEPSEEK_SESSION_TOKEN;
  if (env.DEEPSEEK_SESSION_COOKIE) if (cfg.providers.deepseek) cfg.providers.deepseek.sessionCookie = env.DEEPSEEK_SESSION_COOKIE;
  if (env.DEEPSEEK_BUDGET_MONTHLY) if (cfg.providers.deepseek) cfg.providers.deepseek.budgetMonthly = num(env.DEEPSEEK_BUDGET_MONTHLY, cfg.providers.deepseek.budgetMonthly);
  if (env.ARK_REGION) if (cfg.providers.ark) cfg.providers.ark.region = env.ARK_REGION;
  if (env.ARK_SESSION_COOKIE) if (cfg.providers.ark) cfg.providers.ark.sessionCookie = env.ARK_SESSION_COOKIE;
  if (env.ARK_CSRF_TOKEN) if (cfg.providers.ark) cfg.providers.ark.csrfToken = env.ARK_CSRF_TOKEN;

  return cfg;
}

/** 返回各平台密钥是否已配置（脱敏状态），用于 /api/status；实例制：遍历 cfg.providers */
export function providerStatus(cfg) {
  const out = {};
  for (const [pid, pc] of Object.entries(cfg.providers || {})) {
    out[pid] = {
      enabled: pc?.enabled !== false,
      type: pc?.type || pid,
      configured: !!(pc?.apiKey || pc?.codingPlanKey || pc?.sessionCookie || pc?.secretId || pc?.accessKeySecret),
      note: pc?.type || '',
      fields: {},
    };
  }
  return out;
}

/**
 * 更新供应商的生命周期设置（主动启停），写入 SQLite。
 * 注意：授权有效期（expires_at）由采集结果自动落库（见 lib/runner.js → recordFetchedExpiry），不接受手填。
 * @param {{enabled?: boolean}} patch
 */
export function updateProviderSettings(providerId, patch) {
  if (!providerId) throw new Error('缺少 providerId');
  if (typeof patch?.enabled !== 'boolean') return { ok: true, changed: 0 };
  upsertProvider(providerId, { enabled: patch.enabled });
  return { ok: true, changed: 1, applied: ['enabled'] };
}

function mask(v) {
  if (!v) return '';
  if (v.length <= 8) return v.slice(0, 2) + '***';
  return v.slice(0, 4) + '****' + v.slice(-4);
}
