// 公共工具：CLI 子进程执行、JSON 解析
import { spawn } from 'node:child_process';

/**
 * 执行本地 CLI 并返回 stdout。超时自动 SIGKILL。
 */
export function runCli(cmd, args, { env, timeoutMs = 60000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        env: env || process.env,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      reject(new Error(`无法启动 ${cmd}: ${e.message}`));
      return;
    }
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new Error(`无法启动 ${cmd}: ${e.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
      } else {
        const msg = (err || out).trim().slice(0, 400);
        reject(new Error(`${cmd} 退出码 ${code}${msg ? '：' + msg : ''}`));
      }
    });
  });
}

/** 从 CLI 输出中提取首个 JSON 对象/数组（容忍前后杂讯，如 npm 警告） */
export function parseCliJson(text) {
  const t = String(text || '');
  const starts = [];
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '{' || c === '[') starts.push(i);
  }
  // 从后往前尝试解析（取最外层完整 JSON）
  for (let i = starts.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(t.slice(starts[i]));
    } catch {
      /* try next */
    }
  }
  throw new Error('无法从输出中解析 JSON');
}

export function withTimeout(promise, ms, label = '请求超时') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return Promise.race([
    promise,
    new Promise((_, rej) => {
      timer.unref();
      controller.signal.addEventListener('abort', () => rej(new Error(`${label}（${ms}ms）`)));
    }),
  ]);
}

/** 在对象上探测常见的"过期时间"字段 */
export function pickExpiry(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const keys = [
    'expireTime', 'expireAt', 'expiryTime', 'endTime', 'gmtExpire',
    'validEndTime', 'endDate', 'expireDate', 'expires', 'expire_time',
  ];
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '' && obj[k] !== 0) return String(obj[k]);
  }
  return null;
}

export function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 兼容毫秒/秒两种 epoch 时间戳 → ISO 字符串。
 * >1e12 视为毫秒，否则视为秒（如 MiniMax 返回秒级 end_time）。
 */
export function epochToISO(v) {
  const n = toNum(v);
  if (n == null) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}
