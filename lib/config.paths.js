// 共享路径常量（独立成文件避免 config.js ↔ store.js 循环依赖）
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');
export const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');
export const EXAMPLE_CONFIG_PATH = path.join(ROOT_DIR, 'config.example.json');

// 说明：不再自动生成 config.json。
// 全局设置直接用 config.example.json 作为默认值（只读），供应商与授权一律以 SQLite 为准。
// 如需自定义全局设置，才自行创建 config.json（可选）。
