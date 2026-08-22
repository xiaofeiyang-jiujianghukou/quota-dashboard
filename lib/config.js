// 配置加载：config.json + 环境变量覆盖
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');
export const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
export const EXAMPLE_CONFIG_PATH = path.join(ROOT_DIR, 'config.example.json');

const DEFAULT_CONFIG = {
  port: 8899,
  refreshIntervalSec: 60,
  requestTimeoutMs: 30000,
  providers: {
    ark: { enabled: true, accessKeyId: '', secretKey: '', region: 'cn-beijing', expiresAt: '', sessionCookie: '', csrfToken: '', webId: '' },
    bailian: { enabled: true, accessKeyId: '', accessKeySecret: '', expiresAt: '' },
    zhipu: { enabled: true, apiKey: '', codingPlanKey: '', sessionToken: '', expiresAt: '' },
    minimax: { enabled: true, apiKey: '', host: 'https://www.minimaxi.com', planName: '', sessionCookie: '', groupId: '', expiresAt: '' },
    tencent: { enabled: true, secretId: '', secretKey: '', region: 'ap-guangzhou', planName: '', expiresAt: '' },
    deepseek: { enabled: true, apiKey: '', expiresAt: '' },
  },
  pricing: {}, // 套餐价格覆盖：{ ark: { lite: '¥xx/月' }, ... }，留空用内置默认价
  alert: {
    enabled: true,
    wecom: { enabled: true, chatName: '' }, // chatName 留空 = 发给授权人自己
    rules: { remainingPercentBelow: 20, expiresWithinDays: 3, balanceBelow: 10 },
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
  let configExists = fs.existsSync(CONFIG_PATH);
  if (configExists) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.error(`[config] 解析 config.json 失败: ${e.message}`);
    }
  } else if (fs.existsSync(EXAMPLE_CONFIG_PATH)) {
    // 首次运行：从模板复制
    try {
      fs.copyFileSync(EXAMPLE_CONFIG_PATH, CONFIG_PATH);
      fs.chmodSync(CONFIG_PATH, 0o600);
      console.warn('[config] 已从 config.example.json 生成 config.json，请填入各平台密钥后重启。');
      fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      configExists = true;
    } catch (e) {
      console.error(`[config] 生成 config.json 失败: ${e.message}`);
    }
  }

  const cfg = deepMerge(DEFAULT_CONFIG, fileCfg);

  // 环境变量覆盖
  const env = process.env;
  const num = (v, d) => (v && !Number.isNaN(Number(v)) ? Number(v) : d);
  if (env.QUOTA_PORT) cfg.port = num(env.QUOTA_PORT, cfg.port);
  if (env.QUOTA_REFRESH_SEC) cfg.refreshIntervalSec = num(env.QUOTA_REFRESH_SEC, cfg.refreshIntervalSec);
  if (env.QUOTA_TIMEOUT_MS) cfg.requestTimeoutMs = num(env.QUOTA_TIMEOUT_MS, cfg.requestTimeoutMs);
  if (env.ZHIPU_API_KEY) cfg.providers.zhipu.apiKey = env.ZHIPU_API_KEY;
  if (env.ZHIPU_CODING_PLAN_KEY) cfg.providers.zhipu.codingPlanKey = env.ZHIPU_CODING_PLAN_KEY;
  if (env.ZHIPU_SESSION_TOKEN) cfg.providers.zhipu.sessionToken = env.ZHIPU_SESSION_TOKEN;
  if (env.MINIMAX_API_KEY) cfg.providers.minimax.apiKey = env.MINIMAX_API_KEY;
  if (env.MINIMAX_API_HOST) cfg.providers.minimax.host = env.MINIMAX_API_HOST;
  if (env.MINIMAX_SESSION_COOKIE) cfg.providers.minimax.sessionCookie = env.MINIMAX_SESSION_COOKIE;
  if (env.MINIMAX_GROUP_ID) cfg.providers.minimax.groupId = env.MINIMAX_GROUP_ID;
  if (env.TENCENT_SECRET_ID) cfg.providers.tencent.secretId = env.TENCENT_SECRET_ID;
  if (env.TENCENT_SECRET_KEY) cfg.providers.tencent.secretKey = env.TENCENT_SECRET_KEY;
  if (env.TENCENT_REGION) cfg.providers.tencent.region = env.TENCENT_REGION;
  if (env.DEEPSEEK_API_KEY) cfg.providers.deepseek.apiKey = env.DEEPSEEK_API_KEY;
  if (env.ARK_ACCESS_KEY_ID) cfg.providers.ark.accessKeyId = env.ARK_ACCESS_KEY_ID;
  if (env.ARK_SECRET_KEY) cfg.providers.ark.secretKey = env.ARK_SECRET_KEY;
  if (env.ARK_REGION) cfg.providers.ark.region = env.ARK_REGION;
  if (env.ARK_SESSION_COOKIE) cfg.providers.ark.sessionCookie = env.ARK_SESSION_COOKIE;
  if (env.ARK_CSRF_TOKEN) cfg.providers.ark.csrfToken = env.ARK_CSRF_TOKEN;
  if (env.ARK_WEB_ID) cfg.providers.ark.webId = env.ARK_WEB_ID;
  if (env.BAILIAN_ACCESS_KEY_ID) cfg.providers.bailian.accessKeyId = env.BAILIAN_ACCESS_KEY_ID;
  if (env.BAILIAN_ACCESS_KEY_SECRET) cfg.providers.bailian.accessKeySecret = env.BAILIAN_ACCESS_KEY_SECRET;

  return cfg;
}

/** 返回各平台密钥是否已配置（脱敏状态），用于 /api/status */
export function providerStatus(cfg) {
  const p = cfg.providers;
  return {
    ark: {
      enabled: p.ark.enabled,
      configured: !!(p.ark.accessKeyId && p.ark.secretKey),
      note: p.ark.accessKeyId && p.ark.secretKey ? '纯 HTTP（火山 AK/SK）' : '待配置 AK/SK',
      fields: { accessKeyId: mask(p.ark.accessKeyId), region: p.ark.region || 'cn-beijing' },
    },
    bailian: {
      enabled: p.bailian.enabled,
      configured: !!(p.bailian.accessKeyId && p.bailian.accessKeySecret),
      note: p.bailian.accessKeyId && p.bailian.accessKeySecret ? '纯 HTTP（阿里云 AK/SK）' : '待配置 AK/SK',
      fields: { accessKeyId: mask(p.bailian.accessKeyId) },
    },
    zhipu: {
      enabled: p.zhipu.enabled,
      configured: !!(p.zhipu.apiKey || p.zhipu.codingPlanKey),
      fields: {
        apiKey: mask(p.zhipu.apiKey),
        codingPlanKey: mask(p.zhipu.codingPlanKey),
      },
    },
    minimax: {
      enabled: p.minimax.enabled,
      configured: !!p.minimax.apiKey,
      fields: { apiKey: mask(p.minimax.apiKey) },
    },
    tencent: {
      enabled: p.tencent.enabled,
      configured: !!(p.tencent.secretId && p.tencent.secretKey),
      fields: {
        secretId: mask(p.tencent.secretId),
        secretKey: p.tencent.secretKey ? '******' : '',
      },
    },
    deepseek: {
      enabled: p.deepseek.enabled,
      configured: !!p.deepseek.apiKey,
      fields: { apiKey: mask(p.deepseek.apiKey) },
    },
  };
}

function mask(v) {
  if (!v) return '';
  if (v.length <= 8) return v.slice(0, 2) + '***';
  return v.slice(0, 4) + '****' + v.slice(-4);
}
