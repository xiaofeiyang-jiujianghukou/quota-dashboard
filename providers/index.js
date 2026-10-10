// 提供商注册表：按「类型」注册适配器（同一类型可挂多个实例，如 ark / ark2 / ark3 多账号）
// 实例（id + 类型 + 展示名）由配置页动态增删，落库 SQLite（providers.extra.type / extra.name）
import * as ark from './ark.js';
import * as zhipu from './zhipu.js';
import * as deepseek from './deepseek.js';
import * as minimax from './minimax.js';

/** 类型 → 适配器（collect(cfg, pid, displayName)）+ 默认展示名 */
export const ADAPTERS = {
  ark: { collect: ark.collect, name: '方舟' },
  zhipu: { collect: zhipu.collect, name: '智谱' },
  minimax: { collect: minimax.collect, name: 'MiniMax' },
  deepseek: { collect: deepseek.collect, name: 'DeepSeek' },
};

/** 实例 id → 类型（去掉尾部序号：ark2 → ark，ark-3 → ark） */
export function typeOf(pid) {
  return String(pid).replace(/[-_]?\d+$/, '') || String(pid);
}

/** 主力 tab 包含的类型（其余进「备用」tab） */
export const MAIN_TAB_TYPES = ['ark', 'zhipu', 'deepseek'];
