// 并行采集所有供应商实例，归一化结果
// 实例制：遍历 cfg.providers（SQLite 落库的实例），按类型路由到适配器（同类型可多账号）
import { ADAPTERS } from '../providers/index.js';
import { providerState } from './lifecycle.js';
import { recordFetchedExpiry } from './store.js';

// 瞬时网络错误的特征（宿主机网络抖动/超时/DNS），命中则自动重试一次再返回，避免卡片因一次抖动空掉
const TRANSIENT = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|network|timeout|aborted/i;

export async function collectAll(cfg) {
  const started = Date.now();
  const instances = Object.entries(cfg.providers || {}).map(([pid, pc]) => ({
    id: pid,
    type: pc.type || pid,
    name: pc.name || ADAPTERS[pc.type]?.name || pid,
  }));
  const settled = await Promise.allSettled(
    instances.map(async (inst) => {
      const adapter = ADAPTERS[inst.type];
      // 生命周期门槛：只有"有效"（已启用 + 已配置授权 + 未过有效期）的供应商才采集
      const lc = providerState(cfg, inst.id);
      if (!adapter) {
        return {
          id: inst.id, name: inst.name, ok: false, skipped: true, skipStatus: 'unknown-type',
          error: `未知类型: ${inst.type}`, detail: null, extra: null, items: [],
          fetchedAt: new Date().toISOString(),
        };
      }
      if (lc.status !== 'active') {
        return {
          id: inst.id,
          name: inst.name,
          ok: false,
          skipped: true,
          skipStatus: lc.status,
          error: lc.reason,
          detail: null,
          extra: null,
          items: [],
          fetchedAt: new Date().toISOString(),
        };
      }
      let r = await adapter.collect(cfg, inst.id, inst.name);
      const errText = () =>
        String(r.error || '') +
        ' ' +
        String(r.detail || '') +
        ' ' +
        (Array.isArray(r.items) ? r.items.map((it) => (it.extra && it.extra.note) || '').join(' ') : '');
      // 瞬时失败（含 ok=true 但带 usage-error 条目的情况）→ 立即重试一次
      const hasErrorItem =
        Array.isArray(r.items) &&
        r.items.some((it) => /(error|failed)/i.test(it.key || '') && it.kind === 'info');
      if ((!r.ok || hasErrorItem) && TRANSIENT.test(errText())) {
        await new Promise((res) => setTimeout(res, 1200));
        r = await adapter.collect(cfg, inst.id, inst.name);
      }
      return {
        id: inst.id,
        name: inst.name,
        type: inst.type,
        ok: !!r.ok,
        skipped: !!r.skipped,
        error: r.error || null,
        detail: r.detail || null,
        noPlan: !!r.noPlan, // 已授权但账号无套餐（UI 友好呈现）
        extra: r.extra || null,
        items: Array.isArray(r.items) ? r.items : [],
        fetchedAt: new Date().toISOString(),
      };
    })
  );

  // 采集结果落库：供应商授权有效期（expiresAt）由平台接口返回的最新数据自动写入 SQLite，
  // 作为生命周期"被动失效"的依据（配置页只读展示，不再手填）
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    const pv = s.value;
    if (pv.skipped || !Array.isArray(pv.items)) continue;
    const expiries = pv.items
      .map((it) => (it.expiresAt ? new Date(it.expiresAt).getTime() : NaN))
      .filter((t) => !Number.isNaN(t));
    if (!expiries.length) continue;
    // 取"最近的未来到期时间"（最先到期的有效授权）；全部已过期则取最早（供过期态展示）
    const now = Date.now();
    const future = expiries.filter((t) => t > now);
    const pick = Math.min(...(future.length ? future : expiries));
    try {
      recordFetchedExpiry(pv.id, new Date(pick).toISOString());
    } catch {
      /* 落库失败不影响本次采集结果 */
    }
  }

  // 兼容兜底：若某平台接口不返回到期时间，用历史落库值回填条目展示
  settled.forEach((s, i) => {
    if (s.status !== 'fulfilled') return;
    const pv = s.value;
    const pc = cfg.providers[pv.id];
    if (!pc || !pc.expiresAt || !Array.isArray(pv.items)) return;
    const iso = normalizeExpiry(pc.expiresAt);
    if (iso) {
      for (const it of pv.items) {
        if (!it.expiresAt) it.expiresAt = iso;
      }
    }
  });

  return {
    fetchedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    providers: settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : {
            id: instances[i].id,
            name: instances[i].name,
            type: instances[i].type,
            ok: false,
            skipped: false,
            error: '采集异常',
            detail: s.reason?.message || String(s.reason),
            items: [],
            fetchedAt: new Date().toISOString(),
          }
    ),
  };
}

/** "YYYY-MM-DD"（北京时间）或任意可解析日期 → ISO 字符串 */
function normalizeExpiry(v) {
  if (!v) return null;
  const s = String(v).trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? new Date(s + 'T12:00:00+08:00')
    : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
