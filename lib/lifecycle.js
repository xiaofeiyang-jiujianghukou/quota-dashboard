// 供应商生命周期：配置与面板分离的核心模型
//
// 每个供应商有且仅有两种"失效"途径：
//   1. 主动失效 —— 用户在配置页手动停用（providers.<id>.enabled = false）
//   2. 被动失效 —— 供应商授权有效期（providers.<id>.expiresAt）已过，系统自动判为过期
// 另有"未配置"：授权凭据（密钥/Cookie）一个都没填，谈不上生效。
//
// 只有 status === 'active'（有效）的供应商才会进入面板展示与数据采集。

import { AUTH_SCHEMA, schemaFor } from './auth.js';

/** 解析 expiresAt（"YYYY-MM-DD" 按北京时间当天结束计，或任意可解析日期）→ ms；无/非法返回 null */
export function parseExpiry(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  let d;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) d = new Date(s + 'T23:59:59+08:00');
  else d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** 判断某供应商实例的授权凭据是否已配置（按其类型 schema 的 key 类字段） */
export function isConfigured(cfg, pid) {
  const schema = schemaFor(cfg, pid);
  if (!schema) return false;
  const p = (cfg.providers && cfg.providers[pid]) || {};
  // 配置了任一凭据字段（密钥或会话类）即视为已配置
  return schema.fields.some(([k, , t]) => t !== 'number' && !!p[k]);
}

/**
 * 计算单个供应商的生命周期状态。
 * @returns {{ status: 'active'|'disabled'|'expired'|'unconfigured', reason: string,
 *             active: boolean, configured: boolean, expiresAt: string|null, expired: boolean }}
 */
// 这些平台按设计没有"到期"概念（余额/充值制），无有效期即视为永久有效
const NO_EXPIRY_TYPES = new Set(['deepseek']);

export function providerState(cfg, pid) {
  const p = (cfg.providers && cfg.providers[pid]) || {};
  const active = p.enabled !== false; // 手动开关（默认启用）
  const configured = isConfigured(cfg, pid);
  const expiryMs = parseExpiry(p.expiresAt);
  const expired = expiryMs != null && expiryMs <= Date.now();
  const expiresAt = expiryMs ? new Date(expiryMs).toISOString() : null;
  // 有效期为平台接口拉取后自动落库的最新数据（配置页只读展示）
  const expiresFetchedAt = p.expiresFetchedAt || null;

  let status = 'active';
  let reason = '有效';
  let permanent = false;
  if (!active) {
    status = 'disabled';
    reason = '已手动停用';
  } else if (expired) {
    status = 'expired';
    reason = '授权已过有效期（' + String(p.expiresAt).trim() + '），已被动失效';
  } else if (!configured) {
    status = 'unconfigured';
    reason = '未配置授权凭据';
  } else if (expiryMs != null) {
    const days = Math.ceil((expiryMs - Date.now()) / 86400000);
    reason = `有效 · ${days} 天后到期`;
  } else if (NO_EXPIRY_TYPES.has(p.type || pid)) {
    reason = '有效 · 永久（该平台无到期时间）';
    permanent = true;
  } else {
    reason = '有效 · 有效期待首次采集后自动获取';
  }
  return { status, reason, active, configured, expiresAt, expiresFetchedAt, expired, permanent: !!permanent };
}

/** 全部供应商实例的生命周期快照（配置页 / API 用），按 cfg.providers 实例遍历 */
export function lifecycleAll(cfg) {
  const out = {};
  for (const pid of Object.keys(cfg.providers || {})) {
    if (!schemaFor(cfg, pid)) continue; // 未知类型跳过
    out[pid] = providerState(cfg, pid);
  }
  return out;
}

/** 该供应商当前是否"有效"（进面板、参与采集的唯一门槛） */
export function isEffective(cfg, pid) {
  return providerState(cfg, pid).status === 'active';
}
