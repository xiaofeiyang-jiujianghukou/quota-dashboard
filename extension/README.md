# 会话同步扩展（Chrome）

登录**方舟 / 智谱 / MiniMax** 后，自动把控制台会话推送到你的云端 AI 套餐余量看板，**全程零操作**。

## 为什么需要它

方舟/智谱/MiniMax 的「套餐档位 + 到期时间」只能从控制台登录会话拿（没有开放 API）。云端看板够不到你浏览器里的登录态，所以由这个扩展在你浏览器里自动抓取会话、推给云端。

## 安装（一次，浏览器里操作，不碰终端）

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 右上角打开「**开发者模式**」
3. 点「**加载已解压的扩展程序**」，选择本目录 `extension/`
4. 点扩展图标 → 填「云端看板地址」（如 `https://你的域名`）和「鉴权 token」（云端 config.json 的 `authToken`，若云端没设 token 可留空）
5. 点「**测试连接**」确认通了，再点「**保存**」

完成。之后你在 Chrome 里登录方舟/智谱/MiniMax，扩展会自动抓会话推云端。

## 云端侧准备

云端看板的 `config.json` 里设置一个 `authToken`（防止公网任何人写你的配置）：

```json
{
  "authToken": "一段随机字符串",
  "providers": { "...": "..." }
}
```

或用环境变量 `QUOTA_AUTH_TOKEN` 设置。扩展里填相同的 token。

## 工作原理

| 平台 | 触发方式 | 抓取内容 |
|---|---|---|
| 方舟 | 登录时 cookie `userInfo`/`digest` 写入 | sessionCookie + csrfToken + webId |
| MiniMax | 登录时 cookie `_token` 写入 | sessionCookie + groupId |
| 智谱 | 访问 coding plan 页面时 API 请求头 | sessionToken（JWT） |

抓到的字段自动 `POST` 到云端 `/api/auth/update`（带 token），同平台 10 分钟内去重。

## 会话过期了怎么办

你重新登录对应平台即可 —— 扩展会自动重新抓取推送，无需任何额外操作。
