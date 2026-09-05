// 并行采集所有提供商，归一化结果
import { providers } from '../providers/index.js';

// 瞬时网络错误的特征（宿主机网络抖动/超时/DNS），命中则自动重试一次再返回，避免卡片因一次抖动空掉
const TRANSIENT = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket hang up|network|timeout|aborted/i;

export async function collectAll(cfg) {
  const started = Date.now();
  const settled = await Promise.allSettled(
    providers.map(async (pv) => {
      let r = await pv.collect(cfg);
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
        r = await pv.collect(cfg);
      }
      return {
        id: pv.id,
        name: pv.name,
        ok: !!r.ok,
        skipped: !!r.skipped,
        error: r.error || null,
        detail: r.detail || null,
        extra: r.extra || null,
        items: Array.isArray(r.items) ? r.items : [],
        fetchedAt: new Date().toISOString(),
      };
    })
  );

  // 配置级到期时间覆盖：API 未提供套餐到期时间的平台，用 config.providers.<id>.expiresAt 补充
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
            id: providers[i].id,
            name: providers[i].name,
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
