// 提供商注册表（顺序即展示顺序；主力 tab 在前、备用 tab 在后）
import * as ark from './ark.js';
import * as zhipu from './zhipu.js';
import * as deepseek from './deepseek.js';
import * as bailian from './bailian.js';
import * as minimax from './minimax.js';
import * as tencent from './tencent.js';

export const providers = [
  ark, // 主力：方舟主账号
  zhipu, // 主力：智谱
  deepseek, // 主力：DeepSeek
  ark.ark2, // 备用：方舟第二个账号（config.providers.ark2）
  bailian, // 备用：百炼
  minimax, // 备用：MiniMax
  tencent, // 备用：混元
];

// 「主力」tab 包含的 provider id（其余进「备用」tab）
export const MAIN_TAB_IDS = ['ark', 'zhipu', 'deepseek'];
