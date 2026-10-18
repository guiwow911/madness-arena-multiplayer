# 暴力迪吧联合计划 · 网页联机版

给原版 Flash 游戏《暴力迪吧联合计划 v1.8》加上网页联机能力：每个玩家在浏览器里运行同一份被补丁的 SWF（基于 Ruffle WebAssembly 模拟器），通过一个单端口的 Node 服务器交换角色坐标，所有人能实时看到彼此（以彩色菱形 + 名牌标记显示）。

## 联机原理（延迟最低的单端口架构）

```
 [你的浏览器 A]  Ruffle 跑 patched_online.swf（AS2）
        │  AS2 XMLSocket 无法直连 TCP
        ▼  Ruffle 自动经 socketProxy 走 WebSocket
 ws(s)://<服务器>/proxy
        │
   ┌────▼────┐
   │ server.js│  Node 单进程 · 单端口 $PORT
   │  - 静态托管 index.html / SWF / ruffle
   │  - 把每个 WS 连接当作一名玩家
   │  - 统一处理 join/state 并广播
   └────┬────┘
        │  服务器广播 peerJoin / state
        ▼
 [你的浏览器 B]  … 同样连到 /proxy，收到坐标后画出菱形标记
```

- **一个进程、一个端口**即可同时承担：网页托管、浏览器页面 WebSocket、Ruffle 的 socket 代理转发。没有额外的 TCP 端口代理，因此是延迟最低的实现。
- 坐标每 **50ms** 上报一次（`online_client.as` 中 tick 间隔），远端队友移动很跟手。
- 原版 SWF 未被修改；所有改动只存在于补丁版 `patched_online.swf`。

## 目录结构

```
render_deploy/
├─ server.js          单端口服务器（HTTP + WebSocket + socketProxy）
├─ index.html         网页：昵称输入、连接/断开、Ruffle 嵌入
├─ patched_online.swf 补丁版 SWF（含联机逻辑）
├─ ruffle/            Ruffle 自托管资源（ruffle.js + wasm + core chunks）
├─ render.yaml        Render 声明式配置（可选）
└─ package.json
```

## 本地运行

```bash
cd render_deploy
PORT=8081 node server.js
# 浏览器打开 http://127.0.0.1:8081
```

打开**两个**浏览器窗口（或两个标签页）都访问该地址，各点「连接服务器」，即可看到对方出现在竞技场中。
（建议进入竞技场战斗后移动，双方以菱形 + 名牌互见；未进战斗时用演示坐标在屏幕上移动以便快速验证。）

## 部署到 Render

### 方式一：Render Blueprint（推荐）
1. 把 `render_deploy/` 目录整体推送到 GitHub 仓库。
2. Render 控制台 → New → Blueprint，连接该仓库。
3. Render 会按 `render.yaml` 自动创建服务。无需 build（纯 Node，零依赖）。

### 方式二：手动 Web Service
1. Render → New → Web Service → 连仓库。
2. 填：Runtime = **Node**；Build Command = **留空**；Start Command = `node server.js`。
3. 部署完成后得到形如 `https://xxx.onrender.com` 的地址。

部署后给所有玩家发这个地址，各自打开并点「连接服务器」即可联机。Ruffle 会通过 `wss://你的域名/proxy` 自动完成 socket 转发，无需额外配置。

## 已确认的关键技术事实（Ruffle 0.7.1，AS1/AS2）

- Ruffle 对 AS1/AS2 的 `ExternalInterface` **没有实现**（对象为 `undefined`），因此本方案**不用** ExternalInterface，而是走 `XMLSocket` —— 它是可用的。
- 网页端 Ruffle 的 `XMLSocket` 不能直连 TCP（浏览器限制），必须配置 `socketProxy`，让连接经 WebSocket 转发到服务器。
- `socketProxy` 的 `host`/`port` 要与 SWF 内 `XMLSocket.connect(host,port)` 的目标匹配，`proxyUrl` 指向服务器 `/proxy`。
- AS2 无原生 JSON，协议用换行分隔的手写 JSON 字符串。

## 产物来源

- 原版：`暴力迪吧联合计划v1.8.swf`（未被改动，备份保留）
- 补丁构建脚本：`build/build_online.py`（frame9 注入 `online/as2/online_client.as`）
- 服务器逻辑最早也在 `online/server/` 有多端口原型，本处 `server.js` 为单端口精简版。