// DeepSeek — 账户余额
// 数据源（官方文档 api-docs.deepseek.com/api/get-user-balance）:
//   GET https://api.deepseek.com/user/balance   (Authorization: Bearer <API Key>)
// 返回: { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
// 注: DeepSeek 为预充值余额制，余额无到期时间（赠金可能有有效期，接口只返回未过期赠金）
import { toNum } from './util.js';

export const id = 'deepseek';
export const name = 'DeepSeek';

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
    return { ok: true, items };
  } catch (e) {
    return { ok: false, items: [], error: e.message, detail: 'https://api.deepseek.com/user/balance' };
  } finally {
    clearTimeout(timer);
  }
}
