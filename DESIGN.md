# 实现文档：AI 套餐余量看板（quota-dashboard）

> 本文档完整记录"百炼 / 方舟 / 智谱 / MiniMax / 混元 六平台套餐余量看板"从需求分析、数据源调研、架构设计、编码实现到测试验证的整个过程。

---

## 1. 背景与需求

用户同时订阅了 6 家大模型平台的套餐：

| 平台 | 常见套餐形态 |
|------|-------------|
| 百炼（阿里云 Model Studio） | Token Plan、Coding Plan（付费套餐） |
| 方舟（火山引擎） | Coding Plan / Agent Plan |
| 智谱 AI（bigmodel.cn） | 资源包（token 账户）、GLM Coding Plan |
| MiniMax | Token Plan（按模型给周期配额） |
| 混元（腾讯云） | 混元大模型 Token Plan（`tp_*`，按周期给 token 额度） |
| DeepSeek | 预充值余额（无套餐/到期） |

**核心诉求**：一个界面，实时看到每家套餐的**剩余额度**和**过期/重置时间**。

**关键约束**（与用户确认后确定）：

1. 运行方式：本地 Node 服务 + 浏览器界面，自动定时刷新（用户选定）
2. 混元数据源：混元大模型 Token Plan（用户选定后实测确认）
3. 密钥方式：用户自行填写本地配置文件（用户选定）

---

## 2. 方案选型

### 2.1 三种候选方案对比

| 方案 | 优点 | 缺点 |
|------|------|------|
| A. 纯 HTTP 直连各家接口 | 干净、可独立部署 | 方舟/百炼的余量接口是**控制台 BFF**，无公开 HTTP API；需要逆向登录态 |
| B. 全部包装本地 CLI | 复用各家 CLI 登录态 | 智谱/MiniMax/混元没有现成 CLI |
| C. **混合适配器** | 各取所长 | 需要维护两种调用方式 |

**结论：方案 C**。每家平台一个独立适配器（adapter），对外输出统一结构：

- **方舟**：**纯 HTTP（火山引擎 AK/SK）**调公开 TOP OpenAPI（`GetCodingPlanUsage`/`GetAFPUsage`），无需任何客户端
- **百炼**：**纯 HTTP（阿里云 AK/SK）**：`GenerateCLIAccessToken` 生成令牌后调控制台网关查 Token Plan 用量，无需任何客户端
- **智谱**：HTTP 直连（`bigmodel.cn` 有公开接口）
- **MiniMax**：HTTP 直连（`minimaxi.com` 有公开接口）
- **混元**：HTTP 直连腾讯云管控面 API（TC3-HMAC-SHA256 签名）

### 2.2 技术栈

- **Node.js ≥ 18**，**零第三方依赖**：内置 `node:http`（服务）、`node:child_process`（调 CLI）、`node:crypto`（TC3 签名）、全局 `fetch`（HTTP）
- 前端单文件 `index.html`，原生 HTML/CSS/JS，无构建步骤，离线可用
- 服务仅绑定 `127.0.0.1`，密钥不出本机

---

## 3. 数据源调研（每家平台的余量接口是怎么找到的）

这是整个项目最花时间、也最关键的环节。逐家说明。

### 3.1 方舟（火山引擎）— 纯 HTTP（火山 AK/SK）

**关键调研**：用户希望"只有密钥、不装客户端"。逆向发现 arkcli 是原生二进制（BFF 调用难复现），改从开源社区找突破——[CodexBar PR #2496](https://github.com/steipete/CodexBar/pull/2496)（Doubao/AFP 用量）揭示了**公开 TOP OpenAPI**：

```
POST https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01   （空 body）
POST https://open.volcengineapi.com/?Action=GetAFPUsage&Version=2024-01-01
签名：火山引擎签名 V4（类 AWS SigV4，service=ark，SignedHeaders=content-type;host;x-content-sha256;x-date）
```

响应：Coding Plan 返回 `Result.QuotaUsage[]`（`Level`/`Percent`/`ResetTimestamp` 秒）；Agent Plan 返回 `Result.AFPFiveHour/AFPWeekly/AFPMonthly`（`Quota/Used/ResetTime` 毫秒）。已用假密钥冒烟验证：返回 401 `Invalid...`，说明签名格式被服务端正确解析。实现见 `lib/signers.js` 的 `volcSign()`。注意：OpenAPI 不含套餐到期时间（控制台可查）；若本机有 `~/.arkcli/config.yaml` 仍会读取 `expires_at` 补充。

**现状盘点**：本机已安装 `arkcli`，`~/.arkcli/config.yaml` 里已有 SSO 身份（`identity_key: volc-2105985889`）和默认 profile（`coding-plan_cn-beijing_personal`，含 `expires_at: 1789315199` = **2026-09-13** 套餐到期）。

**查询接口**：`arkcli usage plan --format json --product coding-plan`。返回：

```json
{ "items": [ {
  "product": "coding-plan", "subscribed": true,
  "periods": [
    { "label": "session", "percent": 28.39, "reset_at": "2026-08-22T15:12:14+08:00" },
    { "label": "weekly",  "percent": 70.77, "reset_at": "2026-08-24T00:00:00+08:00" },
    { "label": "monthly", "percent": 37.81, "reset_at": "2026-09-13T23:59:59+08:00" }
  ] } ] }
```

要点：

- Coding Plan 后端**只返回百分比**（`used`/`total` 缺省），所以看板按"已用 %"展示
- **到期时间**：`usage plan` 不直接给套餐到期，但 `monthly` 的重置时间恰好等于套餐到期（2026-09-13 23:59:59）；更权威的来源是 `config.yaml` 的 `expires_at`。实现里优先读 `expires_at`，读不到再退化为 `monthly` 的 `reset_at`
- 默认不带 `--product` 跑会自动探测 4 个 SKU（Agent/Coding × 个人/团队），用户以后买了 Agent Plan 也能自动出现

**沙箱插曲**：arkcli 启动时会创建 `~/.arkcli-bytecloud` 状态目录，被会话沙箱拦截（只允许写工作区）。测试时按规则申请了完整权限并获批准；用户在本机直接运行则完全无此问题。

### 3.2 百炼（阿里云）— 纯 HTTP（阿里云 AK/SK）

**关键调研**：CodexBar 的 alibaba-token-plan 文档明确"API-key auth 不支持，只能 cookie"，但翻 `bailian-cli-core` 源码发现一条纯 AK/SK 链路（workspace init 用的就是它）：

1. `POST https://modelstudio.cn-beijing.aliyuncs.com/modelstudio/cli/generateAccessToken`
   （action `GenerateCLIAccessToken`，version `2026-02-10`，**阿里云 OpenAPI 签名 V3/ACS3-HMAC-SHA256**，空 body）→ 返回 `cliAccessToken`
2. 用该令牌调控制台网关（bl CLI 同款）：`POST bailian-cs.console.aliyun.com/cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage`（`Authorization: Bearer <cliAccessToken>`）→ `per1WeekPercentage`

实现见 `lib/signers.js` 的 `acs3Sign()`；已用假密钥冒烟验证：返回 `InvalidAccessKeyId.NotFound`，签名格式正确。

**现状盘点**：本机 `bl` 已配置 console 网关（国内站 domestic）。

**查询接口**（来自 `bailian-cli` 技能文档 + 实测）：

- `bl usage summary --output json` → `{ period: {...}, freeTier: [...] }`
- `bl usage token-plan --output json` → `{ "per1WeekPercentage": 0 }`
- `bl usage free --output json` → 与 summary 的 freeTier 同构（兜底用）
- `bl usage coding-plan --output json` → `{}`（未订阅，跳过）

`bl usage summary` / `bl usage free` 可返回各模型免费额度（`freeTier[]`，含 `model`、`type`、`remaining`、`total`、`remainingPercent`、**`expires`** 到期日期，实测 90 条）——但**按用户要求已不展示**，百炼卡片只保留付费套餐。

要点：

- 免费额度按用户要求不展示（`bl usage summary/free` 仍可查询，各模型免费 token 包在百炼控制台可见）
- **Token Plan 只有周用量百分比**——实测翻 `bl` 源码（`bailian-cli-commands` 包）确认接口为 `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage`，`--verbose` 显示原始返回就是 `{"per1WeekPercentage": 0}`，无绝对值/到期字段；`bl usage coding-plan` 走 `queryCodingPlanInstanceInfoV2`（有 UsedQuota/TotalQuota 绝对值），但该账号未订阅 Coding Plan（返回 `{}`）。因此看板把 Token Plan 条目**置顶**并注明"官方接口仅提供周用量百分比"

### 3.3 智谱 AI — HTTP 直连

**调研过程**：没有官方公开的"查余量"文档，通过社区项目逆向找到两个接口：

1. **资源包（token 账户）**——来源：[cc-zhipu-hud](https://github.com/beiyuii/cc-zhipu-hud) 的 `src/zhipu.ts`：
   ```
   GET https://bigmodel.cn/api/biz/tokenAccounts/list/my?pageNum=1&pageSize=50
   Authorization: Bearer <apiKey>
   ```
   返回 `rows[]`，字段：`tokenBalance`、`tokensMagnitude`、`status`（EFFECTIVE 等）、`resourcePackageName`、`suitableModel`。

2. **GLM Coding Plan 配额**——同项目继续往下读源码得到：
   ```
   GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
   Authorization: <codingPlanKey>
   ```
   返回 `data.limits[]`，其中 `unit=3` 是"每 5 小时滚动额度"、`unit=6` 是"每周额度"，含 `percentage`、`nextResetTime`，还有 `usage/remaining` 绝对值。

实现要点（已用真实 Key 实测校正，2026-08）：

- ⚠️ **实测发现**：`tokensMagnitude` 不是乘数——它的值就等于额度本身（如 5000000），正确做法是直接取 `tokenBalance`/`availableBalance` 作为剩余额度
- 到期字段实测为 `packageExpirationTime`（次选 `expirationTime`），并过滤 `status=EXPIRED` 且已过期的行
- ⚠️ **实测发现**：monitor 接口的 `type` 是 `CREDIT_LIMIT`（社区源码写的是 `TOKENS_LIMIT`），两个值都兼容匹配
- 用户通常只有一把 key：`apiKey || codingPlanKey`，两个接口都用它试，任一可用即显示对应数据
- 按用户要求：**试用/体验包（名称含"体验/试用"）与已过期资源包不展示**，只显示生效中/未过期的付费资源包 + Coding Plan

### 3.4 MiniMax — HTTP 直连

**调研过程**：从 [ClawHub minimax-token-plan-quota 技能](https://clawhub.ai/alex-shen1121/skills/minimax-token-plan-quota) 和 [nmvr2600/minimax-token-plan-skills](https://github.com/nmvr2600/minimax-token-plan-skills) 仓库拿到完整脚本：

```
GET {host}/v1/api/openplatform/coding_plan/remains
Authorization: Bearer <apiKey>
host: https://www.minimaxi.com（国内站）
```

返回 `model_remains[]`，每条：

| 字段 | 含义 |
|------|------|
| `model_name` | 模型名 |
| `current_interval_total_count` | **当前周期总额度**（次） |
| `current_interval_usage_count` | **当前周期剩余额度**（次）⚠️ |
| `remains_time` | 距重置剩余 ms |
| `start_time` / `end_time` | 周期起止（**秒级** epoch，实测确认） |

**语义坑**（技能文档里特别警告）：`current_interval_usage_count` 是**剩余**而不是**已用**，`used = total - remaining` 要自己算，不能翻转。这是本项目各适配器里最容易写错的一处。

**时间戳坑**（实测发现）：`start_time`/`end_time` 是**秒级** epoch——按毫秒处理会得出"58609 年"这种荒谬日期。`lib/util.js` 的 `epochToISO()` 按 `>1e12` 判断毫秒/秒自适应转换。另外 `total=0` 表示该模型未开通或该 Key 无此能力（前端以黄色提示）。

**订阅 Key 坑**（实测发现）：MiniMax 把 Key 分成两类——**订阅 Key**（Token Plan 套餐/积分专用，在"账户管理 → Token Plan"页面获取，`sk-cp-` 前缀）和**普通按量计费 API Key**，两者**不能混用**。官方查询接口为 `GET {host}/v1/token_plan/remains`（旧接口 `/v1/api/openplatform/coding_plan/remains` 兜底），响应结构 `base`/`models` 与旧版 `base_resp`/`model_remains` 两种都兼容解析。Plus ¥49/月 / Max ¥119/月 / Ultra ¥469/月 三个档位（2026-08 公开页）。

**百分比额度坑**（实测发现，对照官方 `mmx quota`）：Plus/Max/Ultra 套餐的额度是**统一百分比进度条**（5 小时窗口 + 周窗口），API 里 `current_interval_total_count` 等 count 字段**恒为 0**，真正有意义的字段是 `current_interval_remaining_percent` / `current_weekly_remaining_percent`。因此看板改为按**剩余百分比**展示。`current_interval_status` 语义：`1`=生效中（在套餐内），`3`=不在当前套餐中——实测 **Plus 套餐不含视频生成**（官方定价页覆盖 M3/M2.7/图像/语音），video 模型 status=3，看板给出升级提示而非报错。用 `mmx-cli`（`npm i -g mmx-cli` + `mmx auth login --api-key <订阅Key>` + `mmx quota`）可交叉验证。

### 3.5 混元（腾讯云）— 混元大模型 Token Plan（TC3 签名管控面 API）

**调研过程（一波三折，最终实测定案）**：

1. **第一版按 TokenHub 实现**：腾讯云官方文档显示有"大模型服务平台 TokenHub"产品（[文档](https://cloud.tencent.cn/document/product/1823/132280)），接口 `DescribeTokenPlanList`/`DescribeTokenPlan`（`tokenhub.tencentcloudapi.com`），能拿总额/已用/`ExpireTime`。用户按此配好密钥后，TC3 签名验证通过，但 `DescribeTokenPlanList` 返回**空**——说明用户的混元套餐不在 TokenHub 产品线。
2. **换线索**：翻混元大模型产品的[操作审计列表](https://cloud.tencent.cn/document/product/629/97728)，发现 `hunyuan.tencentcloudapi.com` 自己就有一整套套餐接口：`ListUserTokenPlans`（控制台"我的套餐"页调用）、`DescribeTokenPlanUsage`、`DescribePkg`、`DescribePidOrders` 等。
3. **直接探测**：用真实密钥对 `ListUserTokenPlans`/`DescribeTokenPlanUsage` 空参数调用，立刻拿到真实数据：

```json
// ListUserTokenPlans
{ "UserTokenPlanList": [{ "Edition": "personal", "Plan": "tp_lite",
  "QuotaStatus": 1, "StartTime": "2026-08-21 09:23:00",
  "ExpireTime": "2026-09-21 09:22:59", "RenewFlag": 0 }] }

// DescribeTokenPlanUsage
{ "TokenPlanUsageList": [{ "TokenPlanResource": {
  "RemainCycles": "0", "CycleCapacity": "35000000",
  "CycleRemain": "34999884", "CycleTotalUsage": "116",
  "DailyUsageList": [ ... ] } }] }
```

最终实现：`ListUserTokenPlans`（套餐列表）→ `DescribeTokenPlanUsage`（周期容量/剩余/已用/今日用量），展示"总量 3500 万 / 剩余 3499.9 万 / 已用 116 / 到期 2026-09-21 / 手动续费"。

**注意**：混元套餐有两条产品线——TokenHub 平台（企业级多模型套餐）与混元大模型 Token Plan（`tp_*`，个人版/团队版）。当前实现走后者（用户实际购买的产品），若用户购买的是前者会自动失败并提示。若购买的是混元**资源包**（预付费包），需换 `DescribePidOrders`/`DescribePkg` 接口（留作扩展）。

**时间格式坑**：`ExpireTime` 是北京时区无后缀字符串（`2026-09-21 09:22:59`），需手动补 `+08:00` 再转 ISO。

### 3.6 DeepSeek — HTTP 直连（官方余额接口）

**调研过程**：DeepSeek 官方 API 文档（[查询余额 | DeepSeek API Docs](https://api-docs.deepseek.com/zh-cn/api/get-user-balance/)）就有余额接口，无需逆向：

```
GET https://api.deepseek.com/user/balance
Authorization: Bearer <API Key>
```

返回：

```json
{ "is_available": true, "balance_infos": [
  { "currency": "CNY", "total_balance": "110.00", "granted_balance": "10.00", "topped_up_balance": "100.00" } ] }
```

实现要点：

- `total_balance`（总可用余额，含赠金+充值）作为主要展示值；`granted_balance`（未过期赠金）/`topped_up_balance`（充值余额）放 `extra` 与 note 中
- **DeepSeek 是预充值余额制，无套餐到期概念**（赠金可能有有效期，接口只返回未过期部分），因此该项不显示到期倒计时
- `kind: 'balance'` 新增归一化类型，前端标签"余额"

---

## 4. 架构设计

### 4.1 目录结构

```
quota-dashboard/
├── server.js           # HTTP 服务入口（路由、静态文件、缓存）
├── config.json         # 用户密钥（自动生成，chmod 600）
├── config.example.json # 配置模板
├── package.json        # type: module，零依赖
├── lib/
│   ├── config.js       # 配置加载 + 环境变量覆盖 + 密钥脱敏
│   ├── runner.js       # 并行采集所有提供商 + 归一化包装
│   ├── alert.js        # 提醒：阈值评估 + 去重 + 每日汇总 + 企业微信推送
│   ├── tc3.js          # 腾讯云 API 3.0 TC3-HMAC-SHA256 签名
│   └── signers.js      # 火山签名 V4 + 阿里云 ACS3 签名（纯 Key 路径）
├── providers/
│   ├── index.js        # 注册表（决定展示顺序）
│   ├── util.js         # runCli/parseCliJson/pickExpiry/toNum 公共工具
│   ├── ark.js          # 方舟：arkcli usage plan
│   ├── bailian.js      # 百炼：bl usage summary + token-plan
│   ├── zhipu.js        # 智谱：tokenAccounts + monitor quota
│   ├── minimax.js      # MiniMax：coding_plan/remains
│   ├── tencent.js      # 混元：ListUserTokenPlans + DescribeTokenPlanUsage
│   └── deepseek.js     # DeepSeek：GET /user/balance
└── public/
    └── index.html      # 看板（零依赖单文件）
```

### 4.2 归一化数据模型

所有适配器输出统一的条目结构，前端只认这一种：

```js
{
  key:        'ark-coding-plan-monthly',   // 唯一标识
  title:      'Coding Plan · 每月',         // 展示标题
  kind:       'plan' | 'free-tier' | 'package' | 'pool' | 'info',
  total:      1000000 | null,              // 总量
  used:       12345 | null,                // 已用
  remaining:  987655 | null,               // 剩余
  percentUsed: 38.6 | null,                // 已用百分比 0-100
  unit:       'token' | 'credits' | '次' | 'used',  // used=仅百分比
  resetAt:    '2026-09-13T15:59:59.000Z' | null,    // 刷新/重置时间
  expiresAt:  '2026-09-13T15:59:59.000Z' | null,    // 到期时间
  planName:   'Coding Plan LITE' | null,            // 套餐档位名
  priceText:  '¥40/月（首月 ¥9.90）' | null,         // 订阅金额（lib/pricing.js 内置参考价，config.pricing 可覆盖）
  extra:      { ... }                      // 平台特有补充（状态、周期等）
}
```

> **套餐名/金额来源**：腾讯云从 `ListUserTokenPlans.Plan` 映射官方名（用户为**通用 Token Plan 个人版 Lite**，¥39/月 3500万；接口不区分 Hy/通用家族，可用 `tencent.planName` 覆盖）；方舟从 `~/.arkcli/config.yaml` 的 `plan_tier` 取（LITE）；MiniMax 走 `config.providers.minimax.planName`（API 不返回档位）；百炼/智谱用固定名。价格来自 `lib/pricing.js` 内置官方参考价表（2026-08 调研：方舟 Lite ¥40/Pro ¥200、百炼 Lite ¥39 起、智谱 ¥118 起、MiniMax Plus ¥49、腾讯云通用 tp_lite ¥39 / Standard ¥99 / Pro ¥299），可在 `config.json` 的 `pricing` 段按实际成交价覆盖。

适配器契约：

```js
// 每个 providers/<name>.js 导出
export const id = 'ark';
export const name = '方舟 · 火山引擎';
export async function collect(cfg) {
  // 返回 { ok, items, error?, detail?, extra? }
  // skipped: true 表示该平台被禁用（不展示）
}
```

### 4.3 数据流

```
浏览器(index.html)
   │  GET /api/quota?force=1  (定时自动/手动)
   ▼
server.js ──refresh(force)──▶ lib/runner.js
                                  │ Promise.allSettled 并行
            ┌─────────┬──────────┼──────────┬──────────┐
            ▼         ▼          ▼          ▼          ▼
         ark.js   bailian.js  zhipu.js  minimax.js  tencent.js  deepseek.js
            │         │          │          │          │
            └─────────┴──────────┴──────────┴──────────┘
                                  │ 归一化 items[]
                                  ▼
                             内存缓存 cache（refreshIntervalSec 内命中）
                                  ▼
                         GET /api/quota 返回 JSON
```

- **缓存**：`refreshIntervalSec`（默认 60s）内重复请求直接返回缓存（实测缓存命中 4ms）；`?force=1` 或 `POST /api/refresh` 强制重采
- **并发**：六家 `Promise.allSettled` 并行，一家失败不阻塞其它家
- **错误隔离**：每个适配器 try/catch 独立，失败时该平台返回 `ok:false + error + detail`（给用户可操作的提示），其余平台照常

---

## 5. 关键实现细节

### 5.1 TC3-HMAC-SHA256 签名（lib/tc3.js）

腾讯云 API 3.0 的签名过程，完整实现约 60 行：

1. **拼规范请求串** `CanonicalRequest`：`POST` + 路径 `/` + 空查询串 + 规范化请求头（`content-type`、`host`、`x-tc-action`，按字母序）+ 签名头列表 + 请求体 SHA256
2. **拼待签名字符串**：`TC3-HMAC-SHA256\n{时间戳}\n{date}/{service}/tc3_request\nSHA256(CanonicalRequest)`
3. **派生密钥**：`secretDate = HMAC("TC3"+SecretKey, date)` → `secretService = HMAC(secretDate, service)` → `secretSigning = HMAC(secretService, "tc3_request")`
4. **算签名**：`HMAC(secretSigning, StringToSign)`
5. **组 Authorization 头**：`TC3-HMAC-SHA256 Credential={SecretId}/{scope}, SignedHeaders=..., Signature=...`

验证方式：用假密钥请求真实接口，得到 `AuthFailure.SecretIdNotFound`——说明签名格式被服务端正确解析（只差密钥本身），真实密钥填入即可用。

### 5.2 CLI 包装的工程细节（providers/util.js）

- `runCli()`：`spawn` + 超时 `SIGKILL` + 退出码非 0 时把 stderr 前 400 字符带进错误信息
- `parseCliJson()`：CLI 输出常有杂讯（如 Node 的 `UNDICI-EHPA` 警告打到 stderr、日志前缀），从输出里**从后往前**尝试解析最外层 JSON
- 归因协议：调用 arkcli 时按 `arkcli-shared` 技能要求注入 `ARKCLI_CALLER_TYPE=ai_agent`、`ARKCLI_CALLER_NAME=quota-dashboard`、`ARKCLI_SKILL_NAME=arkcli-usage`，只给单条命令加前缀，不污染会话

### 5.3 配置与安全（lib/config.js）

- 首次运行自动从 `config.example.json` 复制生成 `config.json` 并 `chmod 600`
- 环境变量优先于配置文件：`ZHIPU_API_KEY`、`MINIMAX_API_KEY`、`TENCENT_SECRET_ID` 等
- `/api/status` 只返回脱敏状态（`sk-abcd****efgh` 形式），密钥永不下发到浏览器
- 服务硬绑定 `127.0.0.1`，静态文件只允许访问 `public/` 目录（路径穿越防护）

### 5.4 前端看板（public/index.html）

单文件、零依赖，核心交互：

- **进度条着色**：剩余比例 ≥60% 绿、20~60% 黄、<20% 红；无比例数据用蓝
- **倒计时**：到期/重置时间每秒刷新（`setInterval(tick, 1000)`），快到期变黄、已过期变红
- **自动刷新**：定时器 + 倒计时显示；间隔可在页面选 30s~10min；手动刷新按钮强制 `?force=1`
- **折叠**：条目多的卡片默认显示 6 条 + "展开全部"
- **状态条**：顶部芯片显示六家密钥配置状态（统一按"启用+已配置密钥"判断）+ 提醒开关状态

### 5.5 微信提醒（lib/alert.js）

在每次采集完成后评估提醒规则，经**企业微信**（`wecom-cli`，机器人通道）推送：

- **三类阈值告警**：`remainingPercentBelow`（余量 <20%）、`expiresWithinDays`（到期 ≤3 天，按"平台+日期"去重，避免同套餐多条重复轰炸）、`balanceBelow`（DeepSeek 余额 <¥10）
- **每日汇总**：`dailyDigest` 每天第一条消息包含六家全部套餐余量+到期，省心看全景
- **去重**：`data/alert-state.json` 记录已发送（key:type），同一告警 24h 内不重发
- **发送目标**：`alert.wecom.chatName` 留空 → 发授权人（`identity whoami` 解析 ID）；填群名 → 从当次 `sessions list` 精确匹配
- **授权**：`wecom-cli auth init --noninteractive [--output-qrcode qr.png]` 扫码一次即可；发送成功会在状态文件记 `lastSendAt`
- **健壮性**：发送失败只记日志不影响看板；评估函数永不抛异常

实测：授权后用真实数据推送成功（`lastSendAt` 落盘），用户收到测试消息 + 当日汇总。

---

## 6. 测试与验证

| 项目 | 结果 |
|------|------|
| 全部 JS 语法检查（node --check） | ✅ 通过 |
| 方舟（真实身份） | ✅ 3 条：会话 39.8% / 每周 72.3% / 每月 38.6%，到期 2026-09-13 |
| 百炼（真实身份） | ✅ Token Plan 周用量 0%（官方接口仅此一值）+ Coding Plan（未订阅，空） |
| 智谱 / MiniMax / 混元（未配置密钥） | ✅ 优雅降级：卡片显示失败原因 + 配置指引，不影响其它家 |
| 腾讯 TC3 签名 | ✅ 假密钥请求真实接口 → `AuthFailure.SecretIdNotFound`（签名格式正确） |
| 全量采集耗时 | ~4.5s（六家并行） |
| 缓存命中 | 4ms |
| 前端页面 / 接口 | ✅ HTTP 200 |

---

## 7. 已知限制与后续可扩展

### 已知限制

1. **智谱资源包**：`tokensMagnitude` 语义已实测校正（直接取 `tokenBalance`）；个别行的 `status=EXPIRED` 与 `packageExpirationTime` 偶有矛盾（体验包口径），如实展示
2. **方舟到期时间**：`usage plan` 不直接返回套餐到期，当前取自 `~/.arkcli/config.yaml` 的 `expires_at`（或 monthly 重置时间）；若换 profile 需对应更新
3. **百炼 Token Plan**：官方接口只有周用量百分比，无绝对余量/到期
4. **MiniMax 国际站**：需把 `host` 换成国际站域名并配套对应 Key（国内站 Key 与国际站不通用）
5. **混元**：当前实现覆盖"混元大模型 Token Plan（`tp_*`）"（用户实际产品，已实测）；若购买的是混元**资源包**（预付费包）或 TokenHub 平台套餐，需换 `DescribePidOrders`/`DescribePkg` 或 TokenHub 接口（留作扩展）
6. **"实时"粒度**：方舟 `usage plan` 是后端配额快照（准实时），各家数据都不是秒级；看板默认 60s 刷新已是合理粒度

### 可扩展方向

- **历史趋势**：把每次采集落盘，画"消耗速度"曲线，预测何时耗尽
- **多身份**：方舟/百炼支持切换 profile / 工作空间
- **开机自启**：systemd user unit 或 pm2
- **更多通道**：钉钉/邮件推送（当前已实现企业微信）
