// 提供商注册表（顺序即看板展示顺序）
import * as ark from './ark.js';
import * as bailian from './bailian.js';
import * as zhipu from './zhipu.js';
import * as minimax from './minimax.js';
import * as tencent from './tencent.js';
import * as deepseek from './deepseek.js';

export const providers = [ark, bailian, zhipu, minimax, tencent, deepseek];
