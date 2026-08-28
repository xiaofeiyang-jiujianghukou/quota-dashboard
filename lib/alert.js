// AI 套餐提醒：余量/到期/余额 阈值告警 + 每日汇总，经企业微信（wecom-cli）推送
// 规则（config.json → alert）:
//   rules.remainingPercentBelow 余量低于 X% 提醒（默认 20）
//   rules.expiresWithinDays     到期前 X 天内提醒（默认 3）
//   rules.balanceBelow          余额低于 ¥X 提醒（默认 10）
//   rules.peakNotify            DeepSeek 高峰开始/结束提醒（默认开；午休 12-14 与周末不打扰）
//   dailyDigest                 每天发送一次全部套餐汇总
// 去重: data/alert-state.json 记录已发送（key:type），同一告警 24h 内不重复；
//       到期提醒按 平台+日期 去重，避免同套餐多个条目重复轰炸
import fs from 'node:fs';
import path from 'node:path';
import { runCli, parseCliJson, toNum } from '../providers/util.js';
import { ROOT_DIR } from './config.js';

const STATE_DIR = path.join(ROOT_DIR, 'data');
const STATE_PATH = path.join(STATE_DIR, 'alert-state.json');
const RE_ALERT_MS = 24 * 3600 * 1000; // 同一告警 24h 后允许重发

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { sent: {}, lastDigestAt: null };
  }
}

function saveState(s) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error('[alert] 保存状态失败:', e.message);
  }
}

function remainingPercentOf(item) {
  if (item.remainingPercent != null) return toNum(item.remainingPercent);
  if (item.total && item.remaining != null) return (item.remaining / item.total) * 100;
  return null;
}

/** DeepSeek 峰谷事件：工作日处于高峰窗口 → 'start'，18 点后 → 'end'（按日去重，每天最多各一次；
 *  服务重启错过整点会补发；午休 12-14 与周末始终静默） */
export function deepseekPeakEvent(ms) {
  const bj = new Date(ms + 8 * 3600 * 1000);
  const wd = bj.getUTCDay();
  if (wd === 0 || wd === 6) return null;
  const h = bj.getUTCHours();
  if ((h >= 9 && h < 12) || (h >= 14 && h < 18)) return 'start';
  if (h >= 18) return 'end';
  return null;
}

/** 计算并推送提醒；同步函数，内部发送异步进行，绝不抛出异常 */
export function evaluateAlerts(cfg, quota) {
  try {
    const a = cfg.alert || {};
    if (!a.enabled) return { fired: false, reason: 'alert disabled' };
    const rules = a.rules || {};
    const now = Date.now();
    const state = loadState();
    const sent = state.sent || {};
    const msgs = [];

    const shouldSend = (key) => {
      const last = sent[key];
      if (!last) return true;
      return now - new Date(last).getTime() > RE_ALERT_MS;
    };

    // 已发送提醒历史（供 /api/alerts/recent → 浏览器桌面通知拉取）
    const history = (state.history = Array.isArray(state.history) ? state.history : []);
    const fire = (key, text) => {
      sent[key] = new Date().toISOString();
      history.push({ at: sent[key], text });
      msgs.push(text);
    };

    for (const pv of quota.providers || []) {
      for (const it of pv.items || []) {
        // 1) 余量告警
        const rp = remainingPercentOf(it);
        const thr = rules.remainingPercentBelow;
        if (rp != null && thr != null && rp < thr) {
          const key = `${pv.id}|${it.key}|remaining`;
          if (shouldSend(key)) fire(key, `- **${pv.name} · ${it.title}**：余量仅剩 ${rp.toFixed(0)}%（阈值 ${thr}%）`);
        }
        // 2) 到期提醒（按 平台+日期 去重）
        if (it.expiresAt) {
          const t = new Date(it.expiresAt).getTime();
          if (!Number.isNaN(t)) {
            const days = (t - now) / 86400000;
            const limit = rules.expiresWithinDays;
            if (limit != null && days <= limit) {
              const key = `${pv.id}|expire|${new Date(t).toISOString().slice(0, 10)}`;
              if (shouldSend(key)) {
                const txt = days < 0 ? '**已到期**' : `还有 ${Math.max(0, Math.ceil(days))} 天`;
                fire(key, `- **${pv.name} · ${it.title}**：${txt}（${new Date(t).toISOString().slice(0, 10)}）`);
              }
            }
          }
        }
        // 3) 余额告警（DeepSeek 等 kind=balance）
        if (it.kind === 'balance' && it.remaining != null) {
          const bal = rules.balanceBelow;
          if (bal != null && it.remaining < bal) {
            const key = `${pv.id}|${it.key}|balance`;
            if (shouldSend(key)) fire(key, `- **${pv.name}**：余额仅 ¥${it.remaining}（阈值 ¥${bal}）`);
          }
        }
        // 4) 月消费预算告警（DeepSeek 本月消费接近/超过 budgetMonthly）
        if (it.extra && it.extra.monthCost != null && it.extra.budgetMonthly > 0) {
          const budget = it.extra.budgetMonthly;
          const used = it.extra.monthCost;
          const pctUsed = (used / budget) * 100;
          if (pctUsed >= 80) {
            const key = `${pv.id}|${it.key}|budget`;
            if (shouldSend(key)) {
              const level = pctUsed >= 100 ? '已超过' : '已达到';
              fire(key, `- **${pv.name}**：本月消费 ¥${used.toFixed(2)}，${level}月预算 ¥${budget} 的 ${pctUsed.toFixed(0)}%`);
            }
          }
        }
      }
    }

    // 5) DeepSeek 高峰开始/结束提醒（仅工作日 9 点 / 18 点各一次；午休与周末静默）
    if (rules.peakNotify !== false && cfg.providers && cfg.providers.deepseek && cfg.providers.deepseek.enabled) {
      const ev = deepseekPeakEvent(now);
      if (ev) {
        const date = new Date(now + 8 * 3600 * 1000).toISOString().slice(0, 10);
        const key = `deepseek|peak-${ev}|${date}`;
        if (shouldSend(key)) {
          fire(
            key,
            ev === 'start'
              ? '- **DeepSeek**：⏰ 高峰时段已开始（工作日 9:00-12:00 / 14:00-18:00）｜闲时价格减半，非紧急任务建议错峰'
              : '- **DeepSeek**：✅ 高峰时段已结束（明早 9:00 开始）｜现在至明早均为闲时半价',
          );
        }
      }
    }

    // 每日汇总
    let digestMsg = null;
    if (a.dailyDigest) {
      const today = new Date().toISOString().slice(0, 10);
      if (state.lastDigestAt !== today) {
        digestMsg = buildDigest(quota);
        state.lastDigestAt = today;
        history.push({ at: new Date().toISOString(), text: '📊 今日套餐汇总已发送' });
      }
    }
    if (history.length > 100) state.history = history.slice(-100); // 只留最近 100 条
    saveState(state);

    if (msgs.length === 0 && !digestMsg) return { fired: false };

    const parts = [];
    if (msgs.length > 0) {
      parts.push('**🔔 AI 套餐提醒**');
      parts.push('');
      parts.push(...msgs);
    }
    if (digestMsg) parts.push(digestMsg);
    sendWecom(cfg, parts.join('\n')).catch((e) => console.error('[alert] 微信发送失败:', e.message));
    return { fired: true, alertCount: msgs.length, digest: !!digestMsg };
  } catch (e) {
    console.error('[alert] 评估异常:', e.message);
    return { fired: false, error: e.message };
  }
}

/** 每日汇总：全部平台套餐余量 + 到期 */
function buildDigest(quota) {
  const lines = [];
  lines.push('');
  lines.push('**📊 今日套餐汇总**');
  lines.push('');
  for (const pv of quota.providers || []) {
    if (!pv.items || pv.items.length === 0) continue;
    const rows = pv.items
      .map((it) => {
        const bits = [];
        if (it.remainingPercent != null) bits.push(`剩 ${it.remainingPercent.toFixed(0)}%`);
        else if (it.remaining != null) bits.push(`剩 ${it.remaining}${it.unit || ''}`);
        if (it.expiresAt) {
          const d = new Date(it.expiresAt);
          const days = (d.getTime() - Date.now()) / 86400000;
          bits.push(days < 0 ? '已到期' : `${Math.max(0, Math.ceil(days))}天后到期(${d.toISOString().slice(0, 10)})`);
        }
        return `- ${it.title}：${bits.join('，') || '—'}`;
      })
      .join('\n');
    lines.push(`**${pv.name}**`);
    lines.push(rows);
    lines.push('');
  }
  return lines.join('\n');
}

/** 通过 wecom-cli 发送 markdown 消息；chat_id 必须取自当次 sessions list 或 identity whoami */
async function sendWecom(cfg, content) {
  const w = (cfg.alert && cfg.alert.wecom) || {};
  let chatId = null;

  if (w.chatName) {
    const { stdout } = await runCli('wecom-cli', ['message', 'aibot', 'sessions', 'list'], { timeoutMs: 30000 });
    const list = parseCliJson(stdout);
    const hit = (list.sessions || []).find((s) => s.chat_name === w.chatName);
    if (!hit) throw new Error(`未在最近会话中找到「${w.chatName}」（需先与该会话有消息往来）`);
    chatId = hit.chat_id;
  } else {
    // 默认发给授权人自己
    const { stdout } = await runCli('wecom-cli', ['identity', 'whoami'], { timeoutMs: 30000 });
    const me = parseCliJson(stdout);
    chatId = findUserId(me) || parseIdentityContext(me);
    if (!chatId) throw new Error('无法从 identity whoami 解析授权人 ID（请检查 wecom-cli 授权）');
  }

  const payload = JSON.stringify({ chat_id: chatId, msg_type: 'markdown', markdown: { content } });
  await runCli('wecom-cli', ['message', 'aibot', 'send', '--json', payload], { timeoutMs: 30000 });
  console.log('[alert] 微信提醒已发送（内容长度', content.length, '字符）');
  // 记录发送时间，供 /api/status 与排查
  try {
    const s = loadState();
    s.lastSendAt = new Date().toISOString();
    saveState(s);
  } catch {
    /* ignore */
  }
}

/** 递归查找 userid / chat_id 字段 */
function findUserId(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of Object.keys(obj)) {
    if ((k === 'userid' || k === 'chat_id' || k === 'userId') && typeof obj[k] === 'string' && obj[k]) return obj[k];
    const v = findUserId(obj[k]);
    if (v) return v;
  }
  return null;
}

/** wecom-cli identity whoami 的 extra_identity_context 文本里解析授权人 ID */
function parseIdentityContext(me) {
  const ctx = (me && me.extra_identity_context) || '';
  const m = ctx.match(/授权真人用户身份[\s\S]*?ID：\s*([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** /api/alerts/recent 用：since（epoch ms）之后已发送的提醒，按时间升序 */
export function recentAlerts(sinceMs) {
  const state = loadState();
  const since = sinceMs || 0;
  return (state.history || [])
    .map((h) => ({ at: h.at, atMs: new Date(h.at).getTime(), text: h.text }))
    .filter((h) => Number.isFinite(h.atMs) && h.atMs > since)
    .sort((a, b) => a.atMs - b.atMs);
}

/** /api/status 用：提醒配置状态 + 最近发送记录 */
export function alertStatus(cfg) {
  const a = cfg.alert || {};
  const state = loadState();
  return {
    enabled: !!a.enabled,
    wecom: { enabled: !!(a.wecom && a.wecom.enabled), chatName: (a.wecom && a.wecom.chatName) || '(发给自己)' },
    rules: a.rules || {},
    dailyDigest: !!a.dailyDigest,
    lastDigestAt: state.lastDigestAt || null,
    lastSendAt: state.lastSendAt || null,
    sentCount: Object.keys(state.sent || {}).length,
    stateFile: STATE_PATH,
  };
}
