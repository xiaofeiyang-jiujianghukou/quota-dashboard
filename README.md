# AI 套餐余量看板 (quota-dashboard)

一个纯本地运行的浏览器看板，**实时**展示你订阅的 AI 平台套餐余量与到期时间：

| 平台 | 鉴权方式 | 展示内容 |
|------|----------|----------|
| **方舟**（火山引擎） | 配置页「授权登录」（控制台会话 Cookie + CSRF，**免 AK/SK**）| Coding Plan 与 Agent Plan **各自**的 会话/每日/每周/每月 配额 + 套餐名 + 官方实时价 + **各自到期时间** |
| **智谱 AI** | 配置页「授权登录」（控制台会话，**免 API Key**）| GLM Coding Plan 5 小时/每周 额度% + 套餐档位/价格/到期 |
| **MiniMax** | 订阅 Key 或控制台会话 | Token Plan 各模型 剩余百分比/本周剩余/重置时间 |
| **DeepSeek** | API Key（余额）+ 控制台会话（消费统计）| 账户余额（充值/赠金，**无到期概念=永久**）+ 峰谷时段 + 价目 + 消费统计 |

> 鉴权方式：**方舟 / 智谱** 只需在配置页点一次「授权登录」，在打开的浏览器里登录一次即长期有效（令牌自动续期）；
> **MiniMax / DeepSeek** 支持同样的授权登录，也可手动粘贴 Key。

## 特性

- 🖥️ 本地 Node 服务（仅绑定 `127.0.0.1`），浏览器打开即用，无任何第三方依赖
- ⏱️ 自动定时刷新（默认 60s，可在页面上选 30s~10min）+ 手动刷新
- 📅 到期/重置时间实时倒计时（每秒更新），快到期变黄、已过期变红
- 🎨 进度条按余量着色（绿 >60% / 黄 20~60% / 红 <20%）
- 🛡️ 授权凭据只存在本机 `data/dashboard.db`（权限 600）与授权浏览器配置目录，不会回传到页面；**无需安装任何平台客户端**
- 🚦 未配置密钥的提供商优雅降级：卡片显示失败原因与配置指引，不影响其它平台
- 🔔 **微信提醒**：余量低于阈值 / 到期前 N 天 / 余额不足时，经**企业微信**机器人推送到微信；每天一次全部套餐汇总（规则可在 config.json 调整，同一告警 24h 内不重复）
- 💰 **套餐名称 + 订阅金额**：每个套餐条目展示档位名与月费（如 `Coding Plan LITE · ¥40/月`），内置官方参考价，可在 `config.json` 的 `pricing` 段按实际金额覆盖
- 📅 **套餐到期时间**：方舟/百炼/混元从官方接口自动获取（含倒计时）；智谱/MiniMax 接口不提供，在 `config.json` 对应 provider 填 `expiresAt`（如 `"2026-09-30"`）即可显示
- 📱 **内置微信提醒面板**：看板右上角「🔔 微信提醒」→ 点「扫码授权」自动安装 wecom-cli 并生成二维码，企业微信扫一次即打通，可直接发测试消息；无需命令行

## 快速开始

```bash
cd quota-dashboard

# 方式一：手动启动（前台运行）
node server.js
#   面板：http://127.0.0.1:8899
#   配置页：http://127.0.0.1:8899/config

# 方式二：一键启动 + 开机自启（推荐）
./install-autostart.sh          # 注册为 systemd 用户服务，开机/重启自动拉起（免登录常驻）
./run.sh status                 # 查看状态（含授权配置目录是否保留）
./run.sh restart                # 优雅重启（不会删除授权配置，登录态不失效）
./install-autostart.sh --uninstall   # 取消开机自启
```

首次使用：打开配置页 → 「＋ 新增供应商」→ 选类型 → 点「🔐 授权登录」→ 在弹出的浏览器里登录一次即可。
之后每次采集都会自动带着该登录态取数；令牌过期会**自动静默续期**，无需反复授权。

## 配置与面板分离（v2 架构）

- **面板 `/`**：只呈现**有效**供应商的余量/到期数据，纯展示。
- **配置页 `/config`**：管理各供应商的授权凭据（密钥/Cookie）与生命周期：
  - **主动生效/失效**：一键「启用 / 停用」，停用立即从看板移除；
  - **被动失效**：授权有效期由每次授权/采集后从**平台接口拉取的最新数据自动落库**（`providers.expires_at`），到期系统自动判为「已过期」并从看板移除；配置页只读展示，不接受手填；
  - 状态机：`有效 active` / `已停用 disabled` / `已过期 expired` / `未配置 unconfigured`（`lib/lifecycle.js`）。
- **存储分层**：
  - `config.json` — 仅全局设置（端口、提醒规则、定价覆盖等）；
  - `data/dashboard.db`（SQLite，`node:sqlite` 内置模块，零第三方依赖）— 供应商授权凭据、启停状态、**平台拉取的授权有效期**（`lib/store.js`，采集后由 `lib/runner.js` 自动回写）。

## 密钥配置（config.json / SQLite）

> v2 起 **供应商密钥与启停不再写在 config.json**：到配置页 `http://127.0.0.1:8899/config` 在线填写，
> 数据落库 `data/dashboard.db`。config.json 保留全局设置（旧文件里的 providers 段首次启动自动迁移，之后不再读取）：

```jsonc
{
  "port": 8899,                 // 服务端口
  "refreshIntervalSec": 60,     // 服务端缓存/自动刷新间隔（秒）
  "requestTimeoutMs": 30000,    // 单平台请求超时
  "providers": {
    "ark":      { "enabled": true, "accessKeyId": "", "secretKey": "", "region": "cn-beijing" },  // 火山引擎 AK/SK（纯 HTTP）
    "bailian":  { "enabled": true, "accessKeyId": "", "accessKeySecret": "" },  // 阿里云 AK/SK（纯 HTTP）
    "zhipu":    { "enabled": true, "apiKey": "", "codingPlanKey": "" },  // 智谱开放平台 API Key
    "minimax":  { "enabled": true, "apiKey": "", "host": "https://www.minimaxi.com" },
    "tencent":  { "enabled": true, "secretId": "", "secretKey": "", "region": "ap-guangzhou" },
    "deepseek": { "enabled": true, "apiKey": "" }
  }
}
```

密钥获取位置：

- **方舟**：https://console.volcengine.com/iam/keymanage （访问控制 IAM → API 访问密钥）创建 AK/SK（`AKLT` 开头）查配额；**可选**：配置 `ark.sessionCookie/csrfToken/webId`（控制台 F12 → ListSubscribeTrade 请求）可自动获取**真实档位/到期**，否则读本机 `~/.arkcli/config.yaml` 或手动 `expiresAt`。
- **百炼**：https://ram.console.aliyun.com/manage/ak （RAM 访问控制 → AccessKey）创建 AccessKey，填入 `bailian.accessKeyId/accessKeySecret`（`LTAI` 开头）；纯 HTTP 查 Token Plan 周用量。
- **智谱**：https://open.bigmodel.cn → API Keys。`apiKey` 查资源包余量；`codingPlanKey`（GLM Coding Plan 专用 Key）查 5 小时/每周配额，不填则只查资源包。
- **MiniMax**：https://www.minimaxi.com → 账户管理 → Token Plan 页面获取**订阅 Key**（`sk-cp-` 开头，Token Plan 专用；普通 API Key 查不到套餐额度）。国内站默认 `host=https://www.minimaxi.com`；国际站改为 `https://api.minimax.io` 并换国际版订阅 Key。
- **混元（腾讯云）**：https://console.cloud.tencent.com/cam/capi 创建 API 密钥（SecretId/SecretKey），查询混元大模型 Token Plan（`ListUserTokenPlans` + `DescribeTokenPlanUsage`）。注意：若买的是混元**资源包**（非 Token Plan），请告知，可换用 `DescribePidOrders`/`DescribePkg` 接口。
- **DeepSeek**：https://platform.deepseek.com → API Keys 创建；官方余额接口 `GET https://api.deepseek.com/user/balance`（Bearer Key），预充值余额制，无套餐到期时间。

也支持环境变量覆盖（优先级高于 config.json）：`ARK_ACCESS_KEY_ID`、`ARK_SECRET_KEY`、`ARK_REGION`、`BAILIAN_ACCESS_KEY_ID`、`BAILIAN_ACCESS_KEY_SECRET`、`ZHIPU_API_KEY`、`ZHIPU_CODING_PLAN_KEY`、`MINIMAX_API_KEY`、`MINIMAX_API_HOST`、`TENCENT_SECRET_ID`、`TENCENT_SECRET_KEY`、`TENCENT_REGION`、`DEEPSEEK_API_KEY`、`QUOTA_PORT`、`QUOTA_REFRESH_SEC`。

### 微信提醒（企业微信）

提醒走本机 `wecom-cli`（企业微信机器人通道）：

1. **授权**（仅一次）：`wecom-cli auth init --noninteractive`，用**企业微信 App** 扫码（或先 `--output-qrcode qr.png` 生成二维码图片再扫）
2. **接收人**：`alert.wecom.chatName` 留空 = 发给自己（授权人）；填群名 = 发到最近会话中同名的群/单聊
3. **规则**：`remainingPercentBelow` 余量低于 X%（默认 20）、`expiresWithinDays` 到期前 X 天（默认 3）、`balanceBelow` 余额低于 ¥X（默认 10）、`dailyDigest` 每天一条全部套餐汇总
4. 同一告警 24h 内不重复发送；发送记录在 `data/alert-state.json`

> 注意：这里指的是**企业微信**（微信生态的办公 IM）。个人微信没有官方自动化通道，wecom-cli 只支持企业微信机器人。若还没有企业微信，可在 work.weixin.qq.com 用微信扫码开通（个人也可创建）。

## 前置要求

- Node.js ≥ 18（用到了内置 `fetch`），或 **Docker**
- **无需安装任何客户端**：方舟/百炼走纯 HTTP（AK/SK），智谱/MiniMax/混元/DeepSeek 走官方 API（Key/Secret）
- 仅微信提醒可选依赖 `wecom-cli`（`npm i -g @wecom/cli`，`wecom-cli auth init` 扫码一次）

## 接口

| 接口 | 说明 |
|------|------|
| `GET /` | 看板页面 |
| `GET /api/quota` | 全部平台额度数据（服务端缓存，未到刷新间隔直接返回缓存）；`?force=1` 强制重新采集 |
| `POST /api/refresh` | 强制刷新 |
| `GET /api/status` | 各平台密钥配置状态（脱敏） |

## 目录结构

```
quota-dashboard/
├── server.js           # HTTP 服务入口（仅 127.0.0.1）
├── config.json         # 你的密钥（自动生成，权限 600）
├── config.example.json # 配置模板
├── lib/
│   ├── config.js       # 配置加载 + 环境变量覆盖 + 脱敏
│   ├── runner.js       # 并行采集所有提供商
│   └── tc3.js          # 腾讯云 API 3.0 (TC3-HMAC-SHA256) 签名
├── providers/
│   ├── index.js        # 注册表
│   ├── ark.js          # 方舟（GetCodingPlanUsage/GetAFPUsage，纯 HTTP）
│   ├── bailian.js      # 百炼（GenerateCLIAccessToken → 控制台网关，纯 HTTP）
│   ├── zhipu.js        # 智谱（tokenAccounts + monitor quota）
│   ├── minimax.js      # MiniMax（coding_plan/remains）
│   ├── tencent.js      # 混元（ListUserTokenPlans / DescribeTokenPlanUsage）
│   └── deepseek.js     # DeepSeek（GET /user/balance）
└── public/
    └── index.html      # 看板（零依赖单文件）
```

## 常见问题

- **方舟显示"未配置方舟 AK/SK"**：在火山引擎控制台 → 访问控制（IAM）→ API 访问密钥 创建 AK/SK，填入 `ark.accessKeyId/secretKey`。到期时间不在 OpenAPI 中，控制台可查。
- **百炼显示"未配置百炼 AK/SK"**：在阿里云 RAM 访问控制创建 AccessKey，填入 `bailian.accessKeyId/accessKeySecret`。
- **混元查询失败**：确认 SecretId/SecretKey 有效；若报"账号下没有混元 Token Plan 套餐"，说明买的是混元资源包而非 Token Plan，可告知后改用 `DescribePidOrders`/`DescribePkg` 接口。
- **端口被占用**：改 `config.json` 的 `port` 或设置 `QUOTA_PORT`。
