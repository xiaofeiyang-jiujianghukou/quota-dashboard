// MiniMax — Token Plan 余量
// 数据源（官方文档 platform.minimaxi.com/docs/token-plan/faq）:
//   GET {host}/v1/token_plan/remains   (Authorization: Bearer <订阅 Key>)
//   旧接口 /v1/api/openplatform/coding_plan/remains 作为兜底
// 注意:
//   - current_interval_usage_count 官方语义 = 剩余额度（不是已用），used = total - remaining
//   - start_time/end_time 为毫秒级 epoch（>1e12 自动识别）
//   - 订阅 Key 与普通按量计费 API Key 相互独立、不能混用；普通 Key 调此接口 total 恒为 0
import { toNum, epochToISO } from './util.js';
import { planPrice, planPriceNum, planQuotaText } from '../lib/pricing.js';

export const id = 'minimax';
export const name = 'MiniMax';

const STATUS_TEXT = {
  1: '生效中',
  2: '即将耗尽',
  3: '不在当前套餐中',
};

export async function collect(cfg) {
  const p = cfg.providers.minimax;
  if (!p.enabled) return { ok: false, skipped: true, items: [] };

  if (!p.apiKey) {
    return {
      ok: false,
      items: [],
      error: '未配置 minimax.apiKey',
      detail: '在 config.json 或环境变量 MINIMAX_API_KEY 中填写。注意：Token Plan 必须使用「订阅 Key」（账户管理 → Token Plan 页面），普通 API Key 查不到套餐额度',
    };
  }

  const host = (p.host || 'https://www.minimaxi.com').replace(/\/+$/, '');
  const timeoutMs = cfg.requestTimeoutMs || 30000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    // 官方接口优先，旧接口兜底
    const paths = ['/v1/token_plan/remains', '/v1/api/openplatform/coding_plan/remains'];
    let json = null;
    let usedPath = null;
    let lastErr = null;
    for (const path of paths) {
      try {
        const res = await fetch(host + path, {
          headers: { Authorization: `Bearer ${p.apiKey}`, 'Content-Type': 'application/json' },
          signal: controller.signal,
        });
        const text = await res.text();
        let j;
        try {
          j = JSON.parse(text);
        } catch {
          throw new Error(`返回非 JSON（HTTP ${res.status}）：${text.slice(0, 150)}`);
        }
        // 兼容两种响应结构: base/base_resp + models/model_remains
        const base = j.base_resp || j.base || {};
        if (base.status_code != null && base.status_code !== 0 && base.status_code !== 200) {
          throw new Error(`API 错误 [${base.status_code}] ${base.status_msg || ''}`);
        }
        const models = j.model_remains || j.models;
        if (Array.isArray(models)) {
          json = j;
          usedPath = path;
          break;
        }
        lastErr = new Error('响应中没有模型用量列表');
      } catch (e) {
        lastErr = e;
      }
    }
    if (!json) throw lastErr || new Error('所有接口均失败');

    const models = json.model_remains || json.models || [];
    if (models.length === 0) {
      return { ok: false, items: [], error: 'Token Plan 返回空（可能未订阅该套餐）', detail: host + usedPath };
    }
    // 订阅信息（控制台会话 Cookie）：到期时间/套餐名
    const sub = p.sessionCookie ? await fetchSubscribe(p, timeoutMs) : null;
    const subExpiry = sub && sub.endTimeTs ? epochToISO(sub.endTimeTs) : null;
    const subQuota = (sub && sub.quotaText) || null;
    const subPlanName = (() => {
      if (p.planName) return p.planName;
      if (!sub || !sub.title) return 'Token Plan';
      const m = /(Plus|Max|Ultra|Standard|Lite)/i.exec(sub.title);
      return m ? m[1] : sub.title;
    })();
    const items = [];
    const notInPlan = [];
    for (const m of models) {
      const name = m.model_name || '未知模型';
      const status = toNum(m.current_interval_status);
      // 实测（2026-08，官方 mmx-cli 对照）: Plus/Max/Ultra 套餐额度以百分比展示，
      // count 字段恒为 0；status 1=生效中(在套餐内)，3=不在当前套餐中（如 Plus 不含视频）
      const inPlan = status !== 3;
      if (!inPlan) {
        notInPlan.push(name);
        continue;
      }
      const statusText = status === 1 ? '生效中' : status != null ? `状态${status}` : '';
      const intervalRemPct = toNum(m.current_interval_remaining_percent);
      const weeklyRemainPct = toNum(m.current_weekly_remaining_percent);
      const total = toNum(m.current_interval_total_count);
      const remaining = toNum(m.current_interval_usage_count);

      // 官方口径：5小时会话窗口「从第一次调用开始计时」（首调起算的滚动窗口）——
      // 未调用则没有窗口，无"重置时刻"可言，不展示倒计时、不触发恢复提醒；
      // 一旦发生过调用（哪怕极少量），窗口即开启，此时用 API 返回的 end_time 显示窗口结束/重置时刻。
      const intervalUsed = intervalRemPct != null ? 100 - intervalRemPct : 0;
      const weeklyUsed = weeklyRemainPct != null ? 100 - weeklyRemainPct : 0;
      const TOUCHED = 0; // 只要发生过调用（余量 <100%）即视为窗口已开启

      // 与其他平台一致：一个模型按"窗口"拆成多行展示（MiniMax 每模型有 5小时会话窗口 + 每周 两组）
      // —— 5 小时窗口行（主额度）
      const fiveHour = {
        key: `minimax-${name}-5h`,
        title: `Token Plan · ${name} · 5小时会话窗口`,
        kind: 'plan',
        planName: subPlanName,
        priceText: planPrice(cfg, 'minimax', (p.planName || subPlanName).toLowerCase()),
        price: planPriceNum(cfg, 'minimax', (p.planName || subPlanName).toLowerCase()),
        expiresAt: subExpiry,
        quotaText: subQuota || planQuotaText(cfg, 'minimax', (p.planName || subPlanName).toLowerCase()),
        extra: { status: statusText },
      };
      if (intervalUsed > TOUCHED) {
        fiveHour.resetAt = epochToISO(m.end_time);
        fiveHour.resetLabel = '5 小时重置';
      }
      if (intervalRemPct != null) {
        fiveHour.remainingPercent = intervalRemPct;
        fiveHour.percentUsed = 100 - intervalRemPct;
        fiveHour.unit = 'used';
      }
      if (total != null && total > 0) {
        fiveHour.total = total;
        fiveHour.remaining = remaining;
        fiveHour.used = total - remaining;
        fiveHour.unit = '次';
      }
      items.push(fiveHour);

      // —— 每周窗口行
      if (weeklyRemainPct != null && m.weekly_end_time != null) {
        const weekly = {
          key: `minimax-${name}-weekly`,
          title: `Token Plan · ${name} · 每周`,
          kind: 'plan',
          planName: subPlanName,
          priceText: planPrice(cfg, 'minimax', (p.planName || subPlanName).toLowerCase()),
          price: planPriceNum(cfg, 'minimax', (p.planName || subPlanName).toLowerCase()),
          expiresAt: subExpiry,
          quotaText: subQuota || planQuotaText(cfg, 'minimax', (p.planName || subPlanName).toLowerCase()),
          extra: { status: statusText },
        };
        if (weeklyUsed > TOUCHED) {
          weekly.resetAt = epochToISO(m.weekly_end_time);
          weekly.resetLabel = '每周重置';
        }
        weekly.remainingPercent = weeklyRemainPct;
        weekly.percentUsed = 100 - weeklyRemainPct;
        weekly.unit = 'used';
        const wkTotal = toNum(m.current_weekly_total_count);
        const wkUsed = toNum(m.current_weekly_usage_count);
        if (wkTotal != null && wkTotal > 0) {
          weekly.total = wkTotal;
          weekly.used = wkUsed;
          weekly.remaining = wkTotal - wkUsed;
          weekly.unit = '次';
        }
        items.push(weekly);
      }
    }
    // 未开通的模型合并成一行提示，避免占满卡片
    if (notInPlan.length > 0) {
      items.push({
        key: 'minimax-not-in-plan',
        title: `未开通：${notInPlan.join(' / ')}`,
        kind: 'info',
        planName: subPlanName,
        priceText: planPrice(cfg, 'minimax', (p.planName || subPlanName).toLowerCase()),
        price: planPriceNum(cfg, 'minimax', (p.planName || '').toLowerCase()),
        extra: { note: '当前套餐不含这些能力（升级 Max/Ultra 或购买积分可开通）' },
      });
    }
    return { ok: true, items };
  } catch (e) {
    return { ok: false, items: [], error: e.message, detail: host };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 控制台订阅信息（需登录会话 Cookie）：
 * GET /v1/api/openplatform/charge/combo/cycle_audio_resource_package?biz_line=2&cycle_type=3&resource_package_type=7
 * 响应 current_subscribe: { current_subscribe_title, current_subscribe_end_time_ts, ... }
 * 失败返回 null（调用方回退，不阻塞主流程）
 */
async function fetchSubscribe(p, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 15000);
  try {
    const host = (p.host || 'https://www.minimaxi.com').replace(/\/+$/, '');
    let groupId = p.groupId || '';
    const cookie = p.sessionCookie || '';
    if (!groupId) {
      const m = /(?:^|;\s*)minimax_group_id_v2=([^;]+)/.exec(cookie);
      if (m) groupId = m[1];
    }
    const res = await fetch(
      `${host}/v1/api/openplatform/charge/combo/cycle_audio_resource_package?biz_line=2&cycle_type=3&resource_package_type=7`,
      {
        headers: {
          accept: 'application/json, text/plain, */*',
          cookie,
          ...(groupId ? { 'x-group-id': groupId } : {}),
          origin: 'https://platform.minimaxi.com',
          referer: 'https://platform.minimaxi.com/',
        },
        signal: controller.signal,
      }
    );
    const json = await res.json();
    const s = json && json.current_subscribe;
    if (!s) return null;
    const endTs = toNum(s.current_subscribe_end_time_ts);
    const combo = json && json.current_combo_card;
    const benefit = Array.isArray(combo && combo.credit_benefit) ? combo.credit_benefit[0] : null;
    return {
      title: s.current_subscribe_title || null,
      endTimeTs: endTs && endTs > 0 ? endTs : null,
      endTimeText: s.current_subscribe_end_time || null,
      quotaText: benefit || null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
