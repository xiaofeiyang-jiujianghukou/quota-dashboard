// SQLite 存储层（node:sqlite 内置模块，Node ≥ 22.5，零第三方依赖）
//
// 职责：持久化「供应商授权 + 生命周期」，替代原来散落在 config.json 里的 providers 段。
//   - providers    生命周期：enabled（主动启停）、expires_at（授权有效期，被动失效依据）、extra（region/host 等杂项配置）
//   - credentials  授权凭据：每行一个字段（apiKey / secretKey / sessionCookie ...）
//   - meta         迁移标记等元信息
//
// config.json 仅保留全局设置（port / authToken / alert / pricing / refreshIntervalSec）。
// DB 文件：data/dashboard.db（仅本机），权限 600。

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, CONFIG_PATH } from './config.paths.js';

const DB_PATH = path.join(ROOT_DIR, 'data', 'dashboard.db');

let db = null;

function init() {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS providers (
      id          TEXT PRIMARY KEY,
      enabled     INTEGER NOT NULL DEFAULT 1,        -- 主动开关：1 启用 / 0 停用
      expires_at  TEXT NOT NULL DEFAULT '',          -- 授权有效期（被动失效依据），由采集结果自动写入，空 = 尚未获取到
      expires_fetched_at TEXT NOT NULL DEFAULT '',   -- 最近一次从平台拉到该有效期的时刻
      extra       TEXT NOT NULL DEFAULT '{}',        -- 杂项配置（region/host/budgetMonthly/planName 等）
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS credentials (
      provider_id TEXT NOT NULL,
      field       TEXT NOT NULL,
      value       TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (provider_id, field)
    );
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // 老库升级：补 expires_fetched_at 列（已有库没有该列）
  try {
    db.exec('ALTER TABLE providers ADD COLUMN expires_fetched_at TEXT NOT NULL DEFAULT \'\'');
  } catch {
    /* 列已存在 */
  }
  seedAndBackfill();
  try {
    fs.chmodSync(DB_PATH, 0o600);
  } catch {
    /* ignore */
  }
  return db;
}

// 首次初始化播种的默认实例（id / type / 名称 / 启用态）；实例身份的唯一事实源是 DB
const SEED_INSTANCES = [
  ['ark', 'ark', '方舟', 1],
  ['ark2', 'ark', '方舟②', 0],
  ['zhipu', 'zhipu', '智谱', 1],
  ['minimax', 'minimax', 'MiniMax', 1],
  ['deepseek', 'deepseek', 'DeepSeek', 1],
];

function typeOfId(pid) {
  return String(pid).replace(/[-_]?\d+$/, '') || String(pid);
}

/** 空库播种默认实例；老库行缺 type/name 时回填（保证实例身份只由 DB 决定，删除即消失） */
function seedAndBackfill() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM providers').get().n;
  if (!count) {
    const ins = db.prepare('INSERT INTO providers (id, enabled, extra) VALUES (?, ?, ?)');
    for (const [id, type, name, enabled] of SEED_INSTANCES) {
      ins.run(id, enabled, JSON.stringify({ type, name }));
    }
    return;
  }
  // 老库回填：migration 时代的行没有 type/name
  const legacyName = new Map(SEED_INSTANCES.map(([id, , name]) => [id, name]));
  for (const row of db.prepare('SELECT id, extra FROM providers').all()) {
    let extra = {};
    try {
      extra = JSON.parse(row.extra || '{}');
    } catch {
      /* ignore */
    }
    if (extra.type && extra.name) continue;
    const type = extra.type || typeOfId(row.id);
    const name = extra.name || legacyName.get(row.id) || type;
    db.prepare('UPDATE providers SET extra = ? WHERE id = ?')
      .run(JSON.stringify({ ...extra, type, name }), row.id);
  }
}

/** 全部供应商行：{ [pid]: { enabled, expiresAt, extra } } */
/**
 * 启动时用 config.json 补齐「库里缺失」的凭据（只补空，不覆盖已保存的值）。
 * 作用：config.json 作为兜底来源，避免凭据意外丢失后需要重新授权。
 */
export function backfillCredentialsFromConfig() {
  const d = init();
  let conf = {};
  try {
    conf = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return 0;
  }
  const src = conf.providers || {};
    // 只补「当前 schema 仍在用」的字段（AK/SK 等旧字段不再回填）
  const FIELDS = ['apiKey', 'sessionToken', 'sessionCookie', 'codingPlanKey', 'budgetMonthly', 'csrfToken', 'groupId'];
  let filled = 0;
  const rows = d.prepare('SELECT id FROM providers').all();
  for (const { id } of rows) {
    const from = src[id];
    if (!from) continue;
    const have = getCredentials(id);
    const patch = {};
    for (const k of FIELDS) {
      if (!have[k] && from[k]) patch[k] = String(from[k]);
    }
    if (Object.keys(patch).length) {
      setCredentials(id, patch);
      filled++;
    }
  }
  return filled;
}

export function allProviders() {
  const d = init();
  const out = {};
  for (const row of d.prepare('SELECT * FROM providers').all()) {
    let extra = {};
    try {
      extra = JSON.parse(row.extra || '{}');
    } catch {
      /* ignore */
    }
    out[row.id] = {
      enabled: !!row.enabled,
      expiresAt: row.expires_at || '',
      expiresFetchedAt: row.expires_fetched_at || '',
      extra,
    };
  }
  return out;
}

/** 单个供应商行（无则 null） */
export function getProvider(pid) {
  return allProviders()[pid] || null;
}

/** upsert 供应商生命周期字段 */
export function upsertProvider(pid, { enabled, expiresAt, extra } = {}) {
  const d = init();
  d.prepare('INSERT INTO providers (id) VALUES (?) ON CONFLICT(id) DO NOTHING').run(pid);
  if (typeof enabled === 'boolean') {
    d.prepare('UPDATE providers SET enabled = ?, updated_at = datetime(\'now\') WHERE id = ?').run(enabled ? 1 : 0, pid);
  }
  if (typeof expiresAt === 'string') {
    d.prepare('UPDATE providers SET expires_at = ?, updated_at = datetime(\'now\') WHERE id = ?').run(expiresAt.trim(), pid);
  }
  if (extra && typeof extra === 'object') {
    const cur = getProvider(pid)?.extra || {};
    const merged = { ...cur, ...extra };
    d.prepare('UPDATE providers SET extra = ?, updated_at = datetime(\'now\') WHERE id = ?')
      .run(JSON.stringify(merged), pid);
  }
}

/** 某供应商全部凭据：{ [field]: value } */
export function getCredentials(pid) {
  const d = init();
  const out = {};
  for (const row of d.prepare('SELECT field, value FROM credentials WHERE provider_id = ?').all(pid)) {
    out[row.field] = row.value;
  }
  return out;
}

/** 写一批凭据字段（值需非空字符串） */
export function setCredentials(pid, fields) {
  const d = init();
  const stmt = d.prepare(
    `INSERT INTO credentials (provider_id, field, value) VALUES (?, ?, ?)
     ON CONFLICT(provider_id, field) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  );
  let n = 0;
  for (const [k, v] of Object.entries(fields || {})) {
    if (typeof v !== 'string' || v.trim() === '') continue;
    stmt.run(pid, k, v.trim());
    n++;
  }
  return n;
}

/** 清除某供应商某凭据字段 */
/** 清空某实例的全部授权凭据（"取消授权"） */
export function clearAllCredentials(pid) {
  const d = init();
  const before = d.prepare('SELECT COUNT(*) AS n FROM credentials WHERE provider_id = ?').get(pid).n;
  d.prepare('DELETE FROM credentials WHERE provider_id = ?').run(pid);
  return before;
}

export function clearCredential(pid, field) {
  init().prepare('DELETE FROM credentials WHERE provider_id = ? AND field = ?').run(pid, field);
}

/** 新增供应商实例（id 全局唯一；type/name 存 extra，凭据后配） */
export function addProvider(id, type, name) {
  if (!id || !type) throw new Error('addProvider 需要 id 和 type');
  const d = init();
  const dup = d.prepare('SELECT id FROM providers WHERE id = ?').get(id);
  if (dup) throw new Error(`实例 id 已存在: ${id}`);
  d.prepare(
    "INSERT INTO providers (id, enabled, extra) VALUES (?, 1, ?)"
  ).run(id, JSON.stringify({ type, name: name || '' }));
}

/** 删除供应商实例：连同凭据一并清除（删除后立即从看板消失） */
export function deleteProvider(id) {
  const d = init();
  d.prepare('DELETE FROM providers WHERE id = ?').run(id);
  d.prepare('DELETE FROM credentials WHERE provider_id = ?').run(id);
}

/**
 * 把 WAL 里的改动落回主库文件（降低 WAL 异常导致数据回退的风险）。
 */
export function checkpoint() {
  try {
    init().exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return true;
  } catch {
    return false;
  }
}

/**
 * 自动备份：用 VACUUM INTO 生成一致性快照，保留最近 N 份。
 * 备份里含实例列表 + 全部授权凭据，出问题可一键恢复。
 */
export function backupNow(tag = '') {
  const d = init();
  const dir = path.join(ROOT_DIR, 'data', 'backups');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.join(dir, `dashboard-${stamp}${tag ? '-' + tag : ''}.db`);
  try {
    d.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  } catch {
    // 同名文件已存在等异常：换个带随机后缀的名字再试
    const alt = path.join(dir, `dashboard-${stamp}-${Math.random().toString(36).slice(2, 6)}.db`);
    try {
      d.exec(`VACUUM INTO '${alt.replace(/'/g, "''")}'`);
      return alt;
    } catch {
      return null;
    }
  }
  // 仅保留最近 20 份
  try {
    const files = fs
      .readdirSync(dir)
      .filter((x) => x.startsWith('dashboard-') && x.endsWith('.db'))
      .sort();
    while (files.length > 20) {
      const old = files.shift();
      fs.rmSync(path.join(dir, old), { force: true });
    }
  } catch {
    /* ignore */
  }
  return out;
}

export function getMeta(key) {
  const row = init().prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setMeta(key, value) {
  init()
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

/** 一次性迁移：把旧 config.json providers 段（密钥/启停/有效期）导入 SQLite */
export function migrateFromConfigJson(providersInFile) {
  if (!providersInFile || typeof providersInFile !== 'object') return 0;
  if (getMeta('migrated_from_config_json')) return 0;
  let n = 0;
  for (const [pid, pc] of Object.entries(providersInFile)) {
    if (!pc || typeof pc !== 'object') continue;
    const { enabled, expiresAt, ...rest } = pc;
    upsertProvider(pid, {
      enabled: enabled !== false,
      expiresAt: typeof expiresAt === 'string' ? expiresAt : '',
      extra: rest, // region/host/planName/budgetMonthly 等杂项进 extra；凭据字段也会落在 extra，读取时优先 credentials
    });
    // 凭据字段单独入 credentials（更清晰，也便于脱敏管理）
    const credFields = {};
    for (const [k, v] of Object.entries(rest)) {
      if (typeof v === 'string' && v.trim()) credFields[k] = v;
    }
    if (Object.keys(credFields).length) setCredentials(pid, credFields);
    n++;
  }
  setMeta('migrated_from_config_json', new Date().toISOString());
  return n;
}

/**
 * 采集结果回写：把从平台接口拉到的最新授权有效期落库。
 * 每次授权/采集都会刷新该值 —— 生命周期"被动失效"的唯一依据。
 * @param {string} pid 供应商 id
 * @param {string} iso 有效期（ISO 字符串）；空串表示平台未返回，保留旧值
 */
export function recordFetchedExpiry(pid, iso) {
  const t = String(iso || '').trim();
  if (!t) return false; // 平台本轮没返回有效期：不清空旧值
  upsertProvider(pid, {});
  init()
    .prepare(
      `UPDATE providers SET expires_at = ?, expires_fetched_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    )
    .run(t, pid);
  return true;
}

export const DB_FILE = DB_PATH;
