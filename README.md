# 听证会逐字稿网页校订台

供听证会**记录员**与**复核员**（及**参与者**）使用的网页校订台：导入带段号的 UTF-8 逐字稿后，
记录员可在段内选定字符范围提交“替换文字 + 依据”的修订提议；复核员可采纳、驳回提议并发布。
发布形成不可变版本；因发布而过期的提议可由记录员**续提**（按逐次发布的修订把原选区换算到当前正文后重提）；
参与者可对原文范围留下异议引用，修订使被引文字消失时保留原文快照并提示重新定位。
**复核员还可按段号把段落设为保密或解除保密**：保密立即作用于当前及全部历史版本的参与者视图，
已发布版本、提议、异议与回应的原始记录均不改写（工作人员视图不受影响）。

技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 无构建浏览器原生前端。

---

## 一、快速启动（Docker Compose 一键启动）

前置要求：已安装 Docker（含 Compose v2）。

```bash
# （可选）复制环境变量文件并按需修改端口、种子账户密码
cp .env.example .env

# 构建并后台启动
docker compose up -d --build

# 查看日志
docker compose logs -f
```

启动后浏览器访问：

> **http://localhost:3000**  （如修改了 `HOST_PORT`，则为 `http://localhost:<HOST_PORT>`）

停止与清理：

```bash
docker compose down          # 停止（保留数据卷 hearing-revision-data）
docker compose down -v       # 停止并删除数据卷（将清空全部数据）
```

SQLite 数据库保存在命名卷 `hearing-revision-data`（容器内 `/data/hearing.sqlite`）中。
如需用宿主机目录，可把 compose 中的卷改为 `./data:/data`。

### 演示账户（首次启动自动初始化）

| 角色 | 用户名 | 密码 | 可执行操作 |
| --- | --- | --- | --- |
| 记录员 | `recorder` | `recorder123` | 导入逐字稿、提交修订提议、只读查看发布核对 |
| 复核员 | `reviewer` | `reviewer123` | 采纳/驳回提议、发布前回应被触及异议、发布新版本、重新定位异议、**按段号保密/解除保密** |
| 参与者 | `participant` | `participant123` | 对原文范围提出异议、重新定位自己的异议（保密段除外）；保密段只看到占位 |

种子账户仅在数据库用户表为空时创建；可通过环境变量覆盖用户名与密码（见下文配置）。

---

## 二、本地直接运行（不用 Docker）

前置要求：Node.js ≥ 18（原生自带全局 `fetch`；开发环境为 Node 20）。better-sqlite3 为原生模块，
从 npm 安装时通常自动下载预编译二进制；若需源码编译，请准备 Python 3、make、g++。

```bash
npm install
npm start                 # 等价于 node src/server.js
```

然后访问 **http://localhost:3000**。

仅初始化数据库（建表 + 种子账户）不启动服务：

```bash
npm run init-db
```

运行测试（纯逻辑单元测试 + 启动临时服务的端到端测试）：

```bash
npm test
```

---

## 三、配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口（容器内）。宿主机端口用 compose 的 `HOST_PORT` 映射 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data`（本地）/ `/data`（容器） | SQLite 文件目录 |
| `DB_PATH` | `$DATA_DIR/hearing.sqlite` | 数据库文件完整路径 |
| `SESSION_TTL_MS` | `43200000` | 登录会话有效期（毫秒，默认 12 小时） |
| `SEED_RECORDIST_USER` / `SEED_RECORDIST_PASS` | `recorder` / `recorder123` | 记录员种子账户 |
| `SEED_REVIEWER_USER` / `SEED_REVIEWER_PASS` | `reviewer` / `reviewer123` | 复核员种子账户 |
| `SEED_PARTICIPANT_USER` / `SEED_PARTICIPANT_PASS` | `participant` / `participant123` | 参与者种子账户 |

> 安全提示：演示使用 HTTP 与种子密码。生产部署请置于 HTTPS 反向代理之后，并修改全部种子密码；
> 种子账户仅在首次初始化（用户表为空）时生效。

---

## 四、使用流程

1. **记录员登录 → 导入逐字稿**
   - 粘贴 UTF-8 文本或选择 `.txt` 文件。行首段号支持 `12. 正文`、`12、正文`、`12 正文`；
     无段号的非空行自动顺延编号；段号重复会报错拒绝导入。
   - 导入即发布**不可变的第 1 版**。全场只允许导入一次，重复导入返回 409 且不改变状态。
2. **记录员在正文中拖选段内文字 → “提交修订提议”**，填写替换文字（空串表示删除，禁止换行跨段）与必填依据。
   - 提议**绑定提交时的已发布版本**（基版），并保存基版原文摘录快照。
3. **复核员**在右侧“提议”面板或正文标记上：
   - **采纳**：进入发布暂存区；**驳回**：可附原因，已采纳的也可驳回移出暂存区。
   - 采纳时若与暂存区已采纳修订**范围交叠**，或提议**基版已过期**，该提议被标记为“冲突”并写明原因，**不覆盖任何其他修订**。
4. **复核员发布（发布前异议回应门槛）**：
   - 发布前系统按异议**当前锚点**与暂存修订逐条核对：同段内**码点半开区间相交**即视为触及；
     **零长度修订（纯插入）的插入点落在引用范围 `[start,end)` 内**（点等于起点算、等于终点不算）也算触及。
   - 每条被触及的异议，复核员都必须**逐条回应**：填写**非空说明**，回应自动关联该异议、
     触及它的**已采纳提议**，以及回应时的**版本与暂存区状态**（指纹）。
   - 采纳/驳回提议、重新定位或新建异议后，发布时会**重新核对受影响集合与回应绑定**：
     暂存集合变化（`STAGE_CHANGED`）、锚点变化（`ANCHOR_MOVED`）、关联提议集合变化（`PROPOSALS_CHANGED`）
     都会使旧回应失效；发布前**临时新建的被触及异议**同样必须先回应。
     任一失效或缺失回应时发布被 **409 拒绝**（错误信息逐条列出异议与失效原因），
     **版本、提议及决议均不改变**。暂存修订**未触及任何异议**时，仍按原规则发布（空暂存仍拒绝重复发布）。
   - 可通过 `GET /api/publish-check`（或总览 `GET /api/booth` 的 `publishCheck`）随时查看
     待回应项与失效原因；网页发布条与“异议”面板同样展示待回应项、失效原因与回应入口，
     待回应未结清时发布按钮禁用。
   - 同一异议重新回应会取代未发布的旧回应（旧回应以 `superseded` 留痕保留）。
   - 发布成功后回应随版**只读归档**：在对应历史版本视图的“发布前异议回应”中展示，
     异议原文快照与既有重定位规则保持不变。
   - 同一基版上互不重叠的采纳结果按段合并，形成**不可变新版本**；发布后所有仍待复核的提议一律
     标记为“基版已过期”冲突，需由记录员基于新版本重新提交（可手工重提，也可用下述“续提”）。
   可随时切换“发布预览”查看合并效果。
5. **续提（基版已过期提议的换算重提）**：记录员可对**本人**因发布被标为“基版已过期”的冲突提议，
   在提议卡片或详情弹窗中点击“续提到当前版本…”发起**续提预览**；非本人或非此类冲突（如范围交叠）的提议会被拒绝。
   - 系统按从原基版到当前版**逐次发布的修订**，把原段内码点半开选区换算到当前正文，
     显示目标选区、当前摘录、原替换文字与依据（纯几何换算，**不凭同文搜索猜测位置**）。
   - 仅当该选区**未被中途修订触及**（零长度选区则其插入点未被任何修订区间触及），
     且换算目标**不与当前已采纳（暂存区）提议交叠**时，确认后生成**关联原提议的新待复核提议**
     （沿用原替换文字与依据，绑定当前版本为新基版）。
   - 中途修订触及选区/插入点、目标段缺失、或预览之后版本/暂存区发生变化时，确认被拒绝并提示
     **重新预览**或在当前正文**手工选区提交**；原冲突提议、决议与历史版本均保持可追溯，
     新提议沿用现有复核与发布规则。
6. **异议引用**：任何登录用户都可拖选原文范围提出异议，系统保存被引原文快照。
   - 之后发布的修订若与引用范围相交，引用不会自动改指新文字：该异议在新版本中显示
     **“待重新定位”**警示，原文快照继续保留；可由提出者或复核员在当前版本上手动重新定位并留痕。
7. **版本查看**：“版本”面板可只读查看任一历史版本的**正文、决议（采纳/驳回/冲突/续提/发布留痕）、
   异议与发布前异议回应**；历史版本内容不随后续发布改变。
8. **段级保密（复核员，本轮新增）**：复核员在正文段尾点击“设为保密/解除保密”（或调用 HTTP API），
   也可在工具栏“保密留痕”中查看全部变更。
   - **保密以段号为准**：段号在各版本间不变（发布只改段内正文），一次设置**立即作用于当前及全部历史版本**的
     参与者视图；**不改写**任何已发布版本、提议、异议、回应与决议原始记录——工作人员（记录员/复核员）始终看到全部内容。
   - **参与者只看到保密占位**（“该段已按段号保密”），不获得该段正文、发布暂存预览、提议及其替换文字与依据、
     异议原文与说明、发布前回应和决议；**发布核对**（`GET /api/publish-check` 及总览中的 `publishCheck`）
     **仅供记录员与复核员查看**，参与者也**看不到版本备注**。
   - 参与者**不得在保密段新建异议，也不得把异议重新定位进/出保密段**（服务端 403 拒绝）；
     **保密前已存在的相关异议不删除、不改动**，仍由工作人员按原发布规则处理
     （采纳修订、发布前逐条回应、发布后待重新定位、由复核员重新定位等），仅对参与者隐藏。
   - **解除保密后**参与者重新可见该段正文与相关记录；保密/解除均在数据库事务中执行，
     留痕**操作人、时间与前后状态**（`public → secret` / `secret → public`）。
   - 失败均明确拒绝且不改变状态：未知段号 → 404；重复保密/对未保密段解除 → 409；非复核员操作 → 403。

所有失败场景（无权操作、非法字符范围、重复发布、重复导入、重复采纳/重定位等）均返回明确的
HTTP 状态码与中文原因，且在数据库事务中执行——失败即回滚，不改变任何状态。

### 字符范围口径

范围按 **Unicode 码点**计偏移、半开区间 `[start, end)`（前后端一致，emoji 等增补平面字符按 1 个字符计），
仅允许在同一段落内选择；`[0,2)` 与 `[2,4)` 视为不重叠，可无缝相接。

---

## 五、HTTP API 摘要

会话采用 HttpOnly Cookie（`POST /api/login` 返回 `session`）。除登录、静态资源外均需登录。

| 方法与路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/login` / `POST /api/logout` | 全部 | 登录 / 退出 |
| `GET /api/me` | 全部 | 当前用户 |
| `GET /api/booth` | 登录用户 | 当前版本正文、暂存区、提议、异议、版本列表；含 `secretSegs` 保密段号集合，参与者视角下保密段返回占位并过滤相关记录（不含 `publishCheck` 与版本备注） |
| `POST /api/doc/import` | 记录员 | 导入逐字稿（仅一次），形成 v1 |
| `POST /api/proposals` | 记录员 | 提交提议 `{seg,start,end,replacement,basis}` |
| `POST /api/proposals/:id/adopt` | 复核员 | 采纳；交叠/过期则返回冲突标记与原因 |
| `POST /api/proposals/:id/reject` | 复核员 | 驳回（可含 `reason`） |
| `POST /api/proposals/:id/rebase-preview` | 记录员（本人） | 续提预览：把“基版已过期”冲突提议的选区逐版换算到当前正文，返回目标选区/摘录/原替换文字与依据及确认凭证 |
| `POST /api/proposals/:id/rebase-confirm` | 记录员（本人） | 确认续提 `{token}`：校验凭证（版本与暂存区未变、选区未被触及、不与暂存区交叠）后生成关联原提议的新待复核提议 |
| `POST /api/publish` | 复核员 | 合并暂存修订并发布新版本 |
| `POST /api/objections` | 登录用户 | 对原文范围提出异议 `{seg,start,end,note}` |
| `POST /api/objections/:id/relocate` | 提出者或复核员 | 对“待重新定位”的异议手动重定位 |
| `POST /api/objections/:id/respond` | 复核员 | 发布前对被暂存修订触及的异议填写非空回应 `{note}`；自动关联异议、触及提议、当前版本与暂存指纹。未被触及时返回 409 |
| `GET /api/publish-check` | 记录员、复核员 | 只读发布前核对（参与者 403）：受影响异议、每条关联提议、回应绑定状态与失效原因（`missing` / `STAGE_CHANGED` / `ANCHOR_MOVED` / `PROPOSALS_CHANGED`）；工作人员的 `GET /api/booth` 在 `publishCheck` 字段返回相同内容 |
| `POST /api/segments/:seg/secret` | 复核员 | **按段号设为保密**。未知段号 404、重复设置 409；留痕操作人/时间/前后状态，立即作用于当前及全部历史版本的参与者视图 |
| `POST /api/segments/:seg/unsecret` | 复核员 | **解除保密**。未知段号 404、该段未保密时 409；解除后参与者重新可见 |
| `GET /api/secret-logs` | 复核员 | 保密变更留痕列表（段号、动作、前后状态、操作人、时间） |
| `GET /api/versions/:id` | 登录用户 | 只读查看不可变版本（正文/决议/异议/发布前异议回应）；参与者视角下保密段仅返回占位且按段过滤决议、异议、回应与版本备注 |

### 发布前异议回应调用示例（curl）

```bash
# 1) 复核员登录，保存会话 Cookie
curl -i -c /tmp/rev.cookie -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"reviewer","password":"reviewer123"}'

# 2) 发布前核对：查看被暂存修订触及的异议、关联提议与回应状态
curl -s -b /tmp/rev.cookie http://localhost:3000/api/publish-check
# {
#   "versionId": 2,
#   "stageFp": "[[5,2,9,18,\"3月上旬\"]]",
#   "items": [
#     { "objectionId": 1, "seg": 2, "start": 9, "end": 18,
#       "anchorStatus": "active", "quotedText": "2024年3月2日",
#       "proposalIds": [5], "response": null, "satisfied": false } ] }
# （已回应但失效时 response 为 {"id":..,"note":..,"invalidReason":"…","invalidCode":"STAGE_CHANGED"}）

# 3) 逐条回应：非空说明；关联异议/提议/版本/暂存状态由服务端绑定
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/objections/1/respond \
  -H 'Content-Type: application/json' \
  -d '{"note":"经核对原始录音，日期确应为3月上旬，异议不影响本次修订，准予发布并留痕。"}'
# {"ok":true,"id":1,"objectionId":1,"versionId":2,"proposalIds":[5]}

# 4) 回应未结清时发布 → 409 OBJECTION_RESPONSES_REQUIRED，错误逐条列出异议与失效原因；
#    全部 satisfied 后发布成功，回应随新版本只读归档
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/publish \
  -H 'Content-Type: application/json' -d '{"note":"第二次修订"}'
# {"ok":true,"versionId":3}
```

> 触及口径：非零长度修订与异议当前锚点的半开区间相交即触及；零长度修订（纯插入）的插入点
> 满足 `anchor.start ≤ 插入点 < anchor.end` 即触及（点在引用起点算、在终点不算）。
> 采纳/驳回提议、重新定位异议后须重新核对；重新回应同一异议会取代其未发布旧回应（旧回应留痕）。

### 段级保密调用示例（curl）

```bash
# 1) 复核员登录，保存会话 Cookie
curl -i -c /tmp/rev.cookie -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"reviewer","password":"reviewer123"}'

# 2) 把第 7 段设为保密（立即作用于当前及全部历史版本的参与者视图）
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/segments/7/secret
# {"ok":true,"seg":7,"secret":true,"logId":12,"previousState":"public","newState":"secret"}

# 3) 参与者总览/历史版本中该段只返回占位，且无该段提议、异议、发布核对与版本备注
curl -s -b /tmp/par.cookie http://localhost:3000/api/booth
#   {"seg":7,"text":"该段已按段号保密","secret":true}  // 不出现真实正文、stage.replacement、proposals/objections 记录
curl -s -b /tmp/par.cookie http://localhost:3000/api/versions/1
#   历史版本 v1 的第 7 段同样为占位（版本原始记录未被改写，工作人员仍可看到真实内容）

# 4) 失败场景：明确拒绝且不改变状态
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/segments/999/secret
#   404 {"error":"未知段号：当前版本 v3 中不存在第 999 段，无法设为保密","code":"NOT_FOUND"}
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/segments/7/secret
#   409 {"error":"第 7 段已是保密状态，请勿重复设置","code":"ALREADY_SECRET"}
# 参与者尝试保密（或访问发布核对/保密留痕）→ 403 FORBIDDEN
curl -s -b /tmp/par.cookie -X POST http://localhost:3000/api/segments/7/secret
#   403 {"error":"无权操作：参与者（participant）不能执行该操作，需要 reviewer 身份",…}

# 5) 参与者在保密段新建/重新定位异议 → 403，状态不变
curl -s -b /tmp/par.cookie -X POST http://localhost:3000/api/objections \
  -H 'Content-Type: application/json' -d '{"seg":7,"start":0,"end":2,"note":"x"}'
#   403 {"error":"第 7 段已保密：参与者不得在保密段新建异议","code":"FORBIDDEN"}

# 6) 解除保密：参与者重新可见；工作人员的校订与发布流程始终不受影响
curl -s -b /tmp/rev.cookie -X POST http://localhost:3000/api/segments/7/unsecret
# {"ok":true,"seg":7,"secret":false,"logId":13,"previousState":"secret","newState":"public"}

# 7) 查看保密变更留痕（仅复核员）
curl -s -b /tmp/rev.cookie http://localhost:3000/api/secret-logs
# {"logs":[{"id":13,"seg":7,"action":"declassify","previous_state":"secret","new_state":"public",
#           "created_at":"2026-10-01 01:02:03","actor_name":"复核员","actor_user":"reviewer"}, …]}
```

> 说明：保密状态以段号为键全局保存，不复制到每个版本——因此无需迁移历史数据，
> 设置/解除即时对所有版本生效；`versions.segments_json`、`proposals`、`objections`、
> `objection_responses` 等原始记录从不被更新，过滤只发生在面向参与者的视图层。

---

## 六、数据模型（SQLite）

- `versions`：不可变版本，`segments_json` 为该版全文快照，`decision_watermark` 界定该版可见的决议。
- `proposals`：修订提议；记录段号、码点范围、替换文字、依据、**基版 `base_version_id`**、
  基版原文摘录、状态机（pending → adopted/rejected/conflicted → published）与冲突原因。
  `conflict_kind` 区分冲突类别（`base_expired` 基版已过期 / `overlap` 范围交叠，旧库打开时自动补列并按原因文本回填）；
  `rebased_from_id` 记录续提来源——由哪个“基版已过期”冲突提议换算重提而来，双向可追溯。
- `decisions`：决议审计流（adopt / reject / conflict / rebase / publish），不可变追加。
- `objections` + `objection_anchors`：异议主表（含永久原文快照）与逐版本锚点；
  发布时按修订映射，相交即置 `needs_relocation`。`objection_logs` 记录创建与重定位操作。
- `objection_responses`：**发布前异议回应**。回应保存非空说明、触及该异议的暂存提议 id 快照
  （`proposal_ids_json`）、回应时版本（`version_id`）、暂存区指纹（`stage_fingerprint`）与异议锚点快照；
  未发布草稿可被重新回应取代（`status='superseded'`，留痕保留），发布核对通过后写入
  `published_version_id` 随版只读归档。发布事务内重新核对绑定，任一缺失/失效即整体回滚。
- `segment_secrets`：**段级保密状态**。以段号为主键（存在行即保密），全局一份，不随版本复制；
  因发布只改段内正文、段号跨版本不变，故一条记录立即作用于当前及全部历史版本。
- `secret_logs`：**保密/解除保密留痕**。记录段号、动作（`classify`/`declassify`）、操作人、
  时间与前后状态（`previous_state`/`new_state`），不可变追加。保密不更新任何版本与业务记录表，
  对参与者的屏蔽只在视图层按 `segment_secrets` 过滤。

---

## 七、目录结构

```
.
├── Dockerfile               # 多阶段构建（原生模块编译 + 精简运行镜像）
├── docker-compose.yml       # 一键启动，含数据卷与健康检查
├── .env.example             # 配置样例（端口、会话、种子账户）
├── package.json
├── sample-transcript.txt    # 示例逐字稿
├── src
│   ├── server.js            # Express 路由与错误出口
│   ├── auth.js              # Cookie 会话与角色鉴权
│   ├── db.js                # SQLite 连接、建表、种子账户
│   ├── store.js             # 业务核心：导入/提议/复核/发布/续提/异议/版本视图
│   └── text.js              # 码点偏移、范围校验、合版、引用映射、续提换算
├── public                   # 浏览器前端（原生 HTML/CSS/JS，无构建步骤）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test
    ├── unit.test.js         # 文本算子与解析的单元测试
    └── e2e.test.js          # 临时库 + 真实 HTTP 的端到端测试
```
