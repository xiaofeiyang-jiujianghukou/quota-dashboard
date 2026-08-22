// 套餐定价表：内置官方公开价（2026-08 调研），可在 config.json 的 pricing 段覆盖
// 用途：看板展示"套餐名称 + 订阅金额"，方便用户评估是否升级
// 说明：价格为公开页面参考价（含限时活动价），实际以各平台控制台/订单为准

export const DEFAULT_PRICING = {
  // 火山引擎方舟 Coding Plan（禾维 AI 汇总，2026-08）
  ark: {
    lite: '¥40/月（首月 ¥9.90）',
    pro: '¥200/月（首月 ¥49.90）',
    default: '',
  },
  // 阿里云百炼 Token Plan 个人版（官方帮助中心）
  bailian: {
    lite: '¥39/月（原价 ¥60）',
    standard: '¥139/月（原价 ¥180）',
    pro: '¥499/月（原价 ¥600）',
    default: '¥39/月起',
  },
  // 智谱 GLM Coding Plan（积分制）
  zhipu: {
    default: '¥118/月起',
  },
  // MiniMax Token Plan（官方定价页）
  minimax: {
    plus: '¥49/月',
    max: '¥119/月',
    ultra: '¥469/月',
    default: '¥49/月',
  },
  // 腾讯云 Token Plan 个人版（通用版，含 DeepSeek/MiniMax/GLM/Kimi；官方活动页 2026-08）
  tencent: {
    tp_lite: '¥39/月',
    tp_standard: '¥99/月',
    tp_pro: '¥299/月',
    tp_max: '',
    default: '',
  },
  deepseek: {
    default: '预充值，无订阅',
  },
};

/**
 * 解析某平台某档位的价格文案。
 * @param {object} cfg 完整配置（含可选 cfg.pricing 用户覆盖）
 * @param {string} providerId ark/bailian/zhipu/minimax/tencent/deepseek
 * @param {string} [key] 档位键（lite/pro/plus/...）
 * @returns {string} 价格文案（无则空串）
 */
export function planPrice(cfg, providerId, key) {
  const user = (cfg && cfg.pricing && cfg.pricing[providerId]) || {};
  const defs = DEFAULT_PRICING[providerId] || {};
  const k = key ? String(key).toLowerCase() : null;
  return user[k] || user.default || defs[k] || defs.default || '';
}

/** 价格文案中的月费数字（¥40/月（首月 ¥9.90）→ 40；¥118/月起 → 118）；无则 0 */
export function planPriceNum(cfg, providerId, key) {
  const text = planPrice(cfg, providerId, key);
  const m = String(text).match(/¥\s*(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

