# agent/ — Commander 的 Agent 接入面

依据 `personal-agent-hub/docs/AGENT_API_STANDARD.md` v1。**就地接入**（标准里的 B 类形状）：
四个契约端点挂在项目本来就有的那一个服务上（`src/server/cli.js`，默认 `127.0.0.1:8787`），
不新增端口、不新增进程、不新增数据库连接 —— 和双击 `启动.bat` 起来的是同一个应用，
网页界面、REST 路由、Agent 工具读的是同一份 `App` 容器与同一个 SQLite。

## 启动

```bash
npm run agent:serve          # 8787 上已有服务就直接复用，没有就拉起来；把实际地址写进 agent/.endpoint
npm run agent:serve -- --foreground   # 跟着终端跑，Ctrl+C 收尾
npm run agent:mcp            # MCP stdio 桥（任何 MCP 客户端直接起这个文件就能拿到同一套工具）
```

也可以用 `node agent/serve.mjs --port=8788` 或环境变量 `COMMANDER_PORT` / `AGENT_BASE_URL` 改端口与地址。

> **端口只是默认值，不是事实。** 8787 被占时 `cli.js` 会自动 +1（最多 +20），并把**实际**
> URL 写进 `<数据目录>/server-url.txt`；`agent/serve.mjs` 读那份文件后落到 `agent/.endpoint`，
> MCP 桥优先读 `.endpoint`。任何调用方都不该硬编码 8787。
> 这些脚本**一个进程都不杀** —— 8787 上可能是用户正在用的实时服务。

## HTTP 契约

```
GET  /api/health          -> {ok:true,data:{project,version,agent_api,uptime_ms,tools,base_url,at,ok}}
GET  /api/agent/manifest  -> {ok:true,data:{project,version,base_url,agent_api,tools:[…],endpoints:{…}}}
GET  /api/agent/tools     -> {ok:true,data:[{name,description,input_schema,risk}]}
POST /api/agent/tool      -> {ok:true,data:…,tool,risk,ms}
失败 -> {ok:false,error:{code,message,hint?}} （unknown_tool 另带机器可读的 available:[…]）
```

四个端点走 `src/server/http-server.js` 的 `{__raw:true,status,payload}` 出口，所以外壳那句
「把 handler 返回值包成 `{data:…}`」不会套到它们头上；`/api/health` 因此同时满足两个契约 ——
`data.ok` / `data.at` 是这个仓库界面一直在读的两个键，保留。`version` 取自 `package.json`。

状态码的判据只有一条：**能不能被调用方修**。工具名写错、少传必填项、没传 `confirm` → 400；
id 不存在 → 404；重复登记 → 409；未信任却要求执行命令 → 403。服务自己炸了才是 500，
而且 500 的 message 里不会带堆栈。

## 工具清单

**清单的真话只有 `GET /api/agent/tools` 一份。** 下表是同一份注册表的人读副本，
`tests/integration/agent-api.test.js` 会逐个名字比对这份 README 和那份注册表，谁先漂移谁变红。

| 工具 | risk | 需要 confirm | 它实际调用的东西 |
| --- | --- | --- | --- |
| `commander.projects.list` | read | — | `app.listProjects()` + `app.projectCard()` |
| `commander.project.get` | read | — | 数据库里那一行的核心字段（`app.getProject()`） |
| `commander.project.card` | read | — | `app.projectCard()` —— 界面读的就是这一份 |
| `commander.dashboard` | read | — | `app.dashboard()` |
| `commander.attention` | read | — | `app.attentionCenter()` |
| `commander.security` | read | — | `app.securityModel()` |
| `commander.system` | read | — | `app.systemInfo()` |
| `commander.search` | read | — | `app.search.query()`（FTS，不可用时 LIKE 回退并如实标注） |
| `commander.discovery` | read | — | `app.discover()` —— 只读盘上目录标记 |
| `commander.jobs.list` | read | — | `app.queue.list()` |
| `commander.jobs.stats` | read | — | `app.queue.stats()` |
| `commander.relocation.preview` | read | — | `app.relocationPlan()`（纯提案，一个字节都不改） |
| `commander.job.cancel` | write | 否（可逆的小写入） | `app.queue.cancel()` —— 真的杀进程树 |
| `commander.project.scan` | exec | **是** | `app.queueScan()` —— 与网页「重新扫描」同一条实现 |
| `commander.project.add` | exec | **是** | `app.addProjectAndClassify()` —— 与拖拽导入同一条实现 |
| `commander.project.trust` | exec | **是**（两个方向都要） | `app.setProjectTrust(…, {source:'agent'})` |

没有返回写死样例数据的工具：每一条都能被指回一个 `app` 上的方法，
数字与界面同源（否则同一个事实会有两个答案）。

### confirm 判据（集中强制）

`confirm` 的检查写在 `executeAgentTool` 一处（`agent/contract.mjs:confirmRequiredFor` 是唯一判据），
不在 16 个 handler 里各写一遍 —— 否则「新加一个 exec 工具忘了装闸门」就是下一个缺陷：

- `exec`（真的起进程、真的执行某个目录里的脚本）→ 必须 `confirm === true`，缺失或 `false`/字符串都拒；
- `write` → 只有名字或描述里有删除 / 清空 / 覆盖 / 重置这类不可逆动词时才要。
  取消一个自己排队的任务不强制：硬要 confirm 只会把调用方训练成无脑传 `true`，那才是真正的安全退化。

拒绝时长这样（HTTP 400）：

```json
{ "ok": false, "error": {
  "code": "confirm_required",
  "message": "「commander.project.scan」是 exec：…… 收到的 confirm 是 缺失 —— 只有布尔 true 才算数。",
  "hint": "想清楚了再调一次：{\"tool\":\"commander.project.scan\",\"input\":{\"projectId\":\"…\",\"confirm\":true}}。先看不花钱的那份：commander.projects.list / commander.project.card / commander.attention。" } }
```

### 大结果与截断

列表类工具都收 `limit`（每个都写明了上限），并且如实回
`returned / total / truncated`（`note` 里给出下一步）。宁可少给并说清楚，
也不悄悄砍一半让调用方以为拿到的是全部。

### 故意**不是**工具的动作

删除项目记录、清空源目录（`src/core/source-purge.js`，要回显目录名口令）、git 推送到远端
（`src/core/github-publisher.js`）这些真正不可逆的动作，只留在需要人亲自点的界面上，
不暴露为 Agent 工具。标准里那条「真正不可逆的动作不暴露」在项目侧同样成立。

## 本机边界（不在这里重复实现）

入站判定只有一处：`src/server/local-guard.js` —— Host 必须是回环三形式加本机实际监听端口、
带 Origin/Referer 必须同源、`COMMANDER_LOCAL_TOKEN` 设置后非 GET 必须带令牌。
四个契约端点与界面、SPA 走**同一道闸门**；`agent/` 里任何「看起来像校验」的代码都不是闸门。
服务只绑 `127.0.0.1`，非回环的 `--host` 直接拒绝启动。

## 注册到 personal-agent-hub

`config/catalog.json` 里 `commander` 的条目由本人自己登记（本仓库不改动 personal-agent-hub）。
需要的信息：`api.default_base = http://127.0.0.1:8787`、`api.health = /api/health`、
`api.envelope = data`、`api.start.command = node agent/serve.mjs`、`api.ui = http://127.0.0.1:8787/`、
`api.open.command = 启动.bat`（或 `desktop/AIProjectCommander.exe`），`root = ~/Desktop/项目/AI-Project-Commander`。
