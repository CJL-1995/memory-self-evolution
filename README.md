# memory-self-evolution

给 **Cursor**、**codebuddy** 和 **WorkBuddy** 用的自进化长期记忆。它把你在对话里表达过的偏好、规范和项目事实沉淀下来，靠本地向量模型按相关性召回。记忆强度统一用置信度描述：新建固定 0.5，强化或合并 +0.1，实际召回注入 +0.05，同一条记忆每天合计最多加 0.1，上限 1；闲置满 30 天（`decayDays` 可配置）实际扣除 0.05，降到 0.4 及以下标记废弃，一次都没被用到的新记忆最短 60 天被遗忘。

记忆文件存在 `~/.memory-self-evolution/`，三端共用同一份，本地完成向量编码。旁路判别会向配置的模型 API 发送用户原话和判重所需的相近记忆，不是完全离线运行。用户原话在发送前会先在本地处理：去掉代码块和成片的代码、日志行，把形如密钥的字符串替换成 `[已隐去]`；处理后不足 6 个字或超过 500 个字的不发送。判重时发送的相近记忆不做这层处理。

## 它解决什么

同一条偏好反复讲。换个会话又要重新交代项目背景。规则说过但模型下次就忘了。

这个工具的做法是：把这类内容落盘，然后在**两个时机**把它送回模型的上下文——会话开始时无条件注入规则，每轮输入时按语义相关性召回项目事实。

## 记忆分两类

| 类别 | 注入方式 | 典型内容 |
|---|---|---|
| `rule` | 会话开始按置信度注入未废弃规则的前 50 条，不依赖语义匹配 | 「回答用中文」「改完代码不要自动 commit」 |
| `project` | 每轮按语义相关性召回 | 「支付页新流程的灰度开关是 xxx」「ImageLoader 负责图片加载与缓存」 |

这一刀是按**怎么用**划分的，不是按主题。规则必须无条件注入，因为向量召回按语义相关性触发，覆盖不了「用户没提及但规则本该生效」的情况——你说「帮我改下这个函数」时，「改完不要自动 commit」和这句话在语义上并不相似，实测这类输入的召回分数只有 0.12~0.24，和无关输入完全重叠。这是机制上的边界，不是召回质量问题。

## 安装

需要 Node 20 以上。在终端里执行：

```bash
git clone https://github.com/CJL-1995/memory-self-evolution.git
cd memory-self-evolution
npm install
npm run setup
```

已经 clone 过时，在仓库目录重新执行 `npm install && npm run setup`。`npm run setup` 必须在终端里跑，它会按下面的顺序做完。

1. 只问三件事，其余配置用默认值。
   - 旁路式还是阻塞式。直接回车默认旁路式。
   - 弹出确认还是自动追加。直接回车默认弹出确认。
   - 选了旁路式，再填 `baseUrl`、`apiKey`、`apiModel`。这三项没有缺省值。输入 `skip` 跳过，安装后自己写入 `~/.memory-self-evolution/config.json` 的 `sideApiBase`、`sideApiModel`，以及 `side-secret.json` 的 `apiKey`。缺任何一项，旁路这一轮不写记忆。
2. 把选择写进 `~/.memory-self-evolution/`。目录不存在时会建出来。这里只落配置和密钥，记忆文件要等第一次写入才出现。同事装完是空记忆库。
3. 下载向量模型 `bge-base-zh-v1.5`（约 98MB）到本仓库的 `node_modules/@huggingface/transformers/.cache/`。缓存已在则直接复用。下载失败时安装中止，后面的 hook 和 MCP 不会注册。
4. 用当前 `node` 的绝对路径，把 hook 和 MCP 写进本机已经安装的客户端。没装的客户端跳过。已有的其他 hook 和 MCP 保留。本插件注册过时，只更新 node 与仓库路径，不会追加第二条。

| 客户端 | hook | MCP |
|---|---|---|
| Cursor（存在 `~/.cursor`） | `hooks.json` 的 `sessionStart`、`beforeSubmitPrompt`、`stop` | `mcp.json` 的 `memory-self-evolution` |
| codebuddy（存在 `~/.codebuddy`） | `settings.json` 的 `SessionStart`、`UserPromptSubmit`、`Stop` | `mcp.json` 的 `memory-self-evolution` |
| WorkBuddy（存在 `~/.workbuddy`） | `settings.json` 的 `SessionStart`、`UserPromptSubmit`、`Stop` | `mcp.json` 的 `memory-self-evolution` |

三端各自启动同一套 MCP 程序，共享本机记忆文件，不是共用一个常驻进程。旁路还是阻塞不改变装上去的程序，只改变 `config.json` 里的 `sideJudge`。进程启动后读这个值：旁路只列出统一确认工具 `memory_resolve`，不列出 `memory_propose`、`memory_persist`、`memory_reinforce`、`memory_merge`；阻塞模式列出后四个，不列出 `memory_resolve`。hook 两组模式都装，和通路无关。

注册完成后重启 Cursor、codebuddy 和 WorkBuddy，MCP 才会加载。之后只改通路时运行 `node tools/setup.mjs sidepath` 或 `node tools/setup.mjs blocking`，不再提问，同样会先确认模型缓存再重新注册；重新注册会清理旧版本遗留的本插件工具后 Hook，不影响其他插件。WorkBuddy 的 `UserPromptSubmit` 超时 10 秒，宿主会等 hook 返回后再把本轮交给模型，和 codebuddy 相同。

## 卸载

```bash
npm run uninstall
```

插件仓库保留。它会删掉安装时落下的向量模型、三端里本插件的 hook，以及 `mcp.json` 里的 `memory-self-evolution`。其他 hook 和 MCP 不动。

`~/.memory-self-evolution/` 目录保留。`rule.jsonl`、`project.jsonl`、`memories.md`、`embeddings.jsonl`、`project-memory` 保留。`config.json`、`side-secret.json`、`session-secret` 和 `side/` 删除。重新安装时再跑 `npm run setup`，模型会重新下载，配置和本地密钥会在需要时重新生成。卸完后重启三个客户端，MCP 才会从已经打开的会话里消失。

## 怎么让它记住东西

沉淀只走一条通路，由 `sideJudge` 决定。`confirm` 只决定写盘前弹不弹确认，两条通路都适用。

**旁路（`sideJudge=true`，安装时直接回车即此项）。** hook 在后台判断这句该不该记，不挡住本轮回答。工具列表只提供 `memory_resolve(sessionID, decision)`。`confirm=false` 时后台直接写入、强化或合并，`stop` 只让主模型把结果原样展示出来。`confirm=true` 时，`stop` 让主模型弹出确认，先不写；插件为每条提案给出 sessionID，用户点选后主模型调用一次 `memory_resolve`。decision 统一为 `create_rule`、`create_project`、`reinforce`、`merge`、`discard`。插件只消费 sessionID 对应的当前客户端待确认提案，正文、目标记忆和合并正文不能由主模型覆盖；无效、跨客户端、已处理或动作不匹配的 sessionID 会被拒绝，新一次弹窗会作废同一客户端之前问过但没点选的提案。sessionID 使用本地 256 位密钥，对 `agent + conversation_id + generation_id + SHA256(prompt) + version` 做 HMAC-SHA256；同一 Hook 重试得到同一个 sessionID，并通过排他建档只启动一次分析。已结束任务保留 24 小时作为幂等墓碑。密钥首次使用时自动生成到 `~/.memory-self-evolution/session-secret`，权限 600，不经 MCP 或上下文返回。使用 CodeBuddy IDE 自定义智能体时，工具白名单里必须包含 `ask_followup_question`，否则无法弹窗。三端共用同一条旁路：请求 `sideApiBase/chat/completions`。`sideApiBase`、`sideApiModel` 和 `side-secret.json` 中的 `apiKey` 都没有缺省值，缺任何一项这一轮不写、也不弹窗。

旁路任务按 `agent + sessionKey` 强制隔离。Cursor 的 sessionKey 取 `conversation_id`，CodeBuddy / WorkBuddy 取 `session_id`。每次 Stop 只等待、展示和作废当前客户端当前会话的任务；其他会话或其他客户端的任务继续留在池中，等自己的 Stop 处理。Cursor 用于还原隐藏确认指令的临时文件也按客户端和会话分别保存。宿主没有提供稳定会话 ID 时 fail closed：本轮不启动旁路分析并记录原因，避免空 ID 串会话。正式落盘后的 `rule` / `project` 仍是跨会话共享的长期记忆。

**阻塞（`sideJudge=false`）。** 旁路不启动。先运行 `node tools/setup.mjs blocking`，它把 `sideJudge` 写成 false，并把 MCP 装到本机已有的 Cursor、codebuddy、WorkBuddy。重启客户端后，主模型才能看到写记忆工具。你说「以后都要先跑测试再提交」，主模型调 `memory_propose` 拿到相近记忆和分组建议。`confirm=true` 时再用宿主应用内提问工具请你确认后落盘。Cursor 弹出 `AskQuestion`，CodeBuddy 和 WorkBuddy 弹出 `AskUserQuestion`。`confirm=false` 时，分组信号明确就按判重提示直接落盘；信号缺失时仍弹确认。`memory_propose` 返回最相近的两条记忆和相似度，由主模型判断新建、强化或合并。切回旁路运行 `node tools/setup.mjs sidepath`，然后重启。

**自己直接写。** 不想经过模型判断时：

```bash
node bin/memory.mjs rule add "所有异常处理处都需要添加日志"
```

早期版本还有一条关键词候选池通路（从历史会话里按信号词捞原话），已经移除：旁路有判别模型，阻塞模式由主模型主动提交，两条通路都不依赖它。旧版本留下的 `~/.memory-self-evolution/candidates.json` 不再被读写，可以自行删除。

## 注入与主模型职责

- **旁路模式**：`sessionStart` 只注入规则列表和职责边界，不附项目读取说明、沉淀规则、候选提示或 `confirm` 状态。记忆提取、判重和沉淀由后台负责，包括用户明确要求「记住」的情况；主模型专注当前任务，仅按插件后续指令执行确认或授权写入。
- **每轮旁路输入**：插件启用时，即使没有召回结果，也会追加以下提醒；确认续轮、结果通知和空输入不重复追加。阻塞模式不注入此提醒，也不受 `confirm` 值影响。

  > 记忆由 memory-self-evolution 插件在后台判断。用户陈述偏好、规范或要求记住时，你只需回应并照做：不要判断是否该记，不要调用提问工具发起「检测到一条记忆」确认，也不要主动调用 memory_resolve 或其它记忆写工具。只有收到含 MEMORY_CONFIRM_V1 的插件指令时，才按指令弹窗并处理对应 sessionID。

  插件发起的确认弹窗标题固定为「记忆确认·插件」。三端只在用户明确点选后调用 `memory_resolve`；明确选择「不落成」时传入同一 sessionID，并使用 `discard` 结束本次分析。提问工具自动返回 `Skipped`，或用户关闭/取消弹窗时不要调用 `memory_resolve`，未处理任务由下一次每日僵尸清理兜底。

- **阻塞模式**：保留规则列表、项目概览、沉淀规则及候选提示，由主模型判重并选择动作。
- **规则上限**：两种模式都从未废弃的 `rule` 中按已存储置信度降序选前 50 条，同分时最近活跃的在前。每轮语义召回仍从全部未废弃的 `rule` 和 `project` 中检索，不受该 50 条限制。
- **每轮召回**：`rule` 和 `project` 分别召回，各自过自己的阈值、各自最多 3 条，注入时分「规则」「项目事实」两组列出，不合并排序；两类都没有过线时不注入。打分减的是随仓库分发的固定背景均值，不依赖记忆池，所以只有 1 条记忆时也能召回。项目事实不在 `sessionStart` 注入，只通过每轮召回进入上下文。

## 置信度与旧数据兼容

正式记忆只维护 `confidence`，它表示强度，不是概率，范围 `0` 到 `1`。

| 场景 | 变化 |
|---|---|
| 新建（CLI、MCP、旁路一致） | 初始固定 `0.5`，不接受自定义值 |
| 强化或合并 | `+0.1` |
| 每轮实际召回并注入 | 每个命中 ID `+0.05` |

同一条记忆在一个本地日内只加一次分，合计不超过当天发生过的最大一档：只被召回是 `0.05`，当天有过强化或合并则补到 `0.1`。用户重述一条已有记忆时，这句话自己会先把它召回，随后的强化只补差额。新建当天视为已加过分。合并在当天已加满时照常替换正文，只是不再加分。置信度到 `1` 后不再增长，但当天第一次生效的召回或强化仍会刷新 `lastSeen`。通知里显示的是本次实际加分。

会话开始的规则注入、手动读取、判重检索和评测不加分；无命中或召回失败也不加分。实际生效的强化、合并和召回奖励会把 `lastSeen` 重置为当前时间。

每天首次 `sessionStart` 检查衰减：距离 `lastSeen` 满 `decayDays` 天（默认 30）的有效记忆，实际置信度扣除 `0.05` 并落盘，同时把时间戳更新为当前时间；未满不更新时间。修改 `decayDays` 用 `node bin/memory.mjs config decayDays 60`，或直接改 `config.json`，从次日首次会话开始生效。一次只扣一次，不追补历史多个周期。当天检查成功后记录在 `~/.memory-self-evolution/decay-state.json`，各客户端、各会话共用；当天后续会话直接跳过。没有新会话就不检查，`Stop` 不再执行衰减。

同一次每日维护还会清理旁路僵尸任务：仅处理前一天及更早、已经弹出确认但始终没有执行 `memory_resolve` 的任务，将其标记为 `daily-zombie-cleanup`。当天刚弹出的任务和从未弹窗的任务不会被提前清理；主模型正常执行 `discard` 时仍会立即结束，不等待每日兜底。

实际置信度降到 `0.4` 及以下即标记废弃。新记忆 `0.5` 起步，一次都没被召回或重述时，第 30 天 `0.45`、第 60 天 `0.4` 并废弃，这是默认配置下最短的遗忘时间；到过上限 `1` 的记忆要连续闲置 12 个周期才废弃。废弃记忆不参与规则注入、召回和判重相似度比较，不继续日常衰减，也不自动删除。显式强化或合并后高于 `0.4` 可以恢复。已扣分数不会因再次使用而还原，例如 `0.7` 衰减为 `0.65` 后召回一次变成 `0.7`。日检失败不会标记当天完成，下一次会话会重试。

旧记忆保留历史置信度，但超过上限 `1` 的值会在下一次日检时压到 `1`；读取时忽略旧 `observations`，组文件下次因内容、强度或废弃状态变化而重写时清除该字段，不在读取时批量迁移。卸载重装不会重置历史置信度。

正式记忆变更共用跨进程写锁，召回加分按组批量更新，不额外调用模型或重建已有向量；命中的记忆当天都已加过分时，这一轮不拿锁也不写盘。写锁被占着时，召回加分只等 300 毫秒就放弃这一次，召回内容照常返回；锁目录存在超过 15 秒会被当作残留回收。加分失败记录日志，但仍返回召回内容。更新代码后应重启各客户端的 MCP，避免旧进程继续使用旧规则。

## 命令

```bash
node bin/memory.mjs list                  # 两组各有多少条
node bin/memory.mjs read rule             # 看规则
node bin/memory.mjs read project          # 看项目事实
node bin/memory.mjs rule add "<规则>"      # 直接新增规则
node bin/memory.mjs config                # 查看配置
node bin/memory.mjs config recallTopK 5   # 改配置，下一轮输入即生效
npm run setup                                 # 交互安装并注册 Cursor / codebuddy / WorkBuddy
npm run uninstall                             # 卸掉模型、hook、MCP 和配置，保留记忆与插件仓库
node tools/setup.mjs sidepath                 # 切到旁路，确认模型缓存并重新注册
node tools/setup.mjs blocking                 # 切到阻塞，确认模型缓存并重新注册
npm test                                      # 隔离回归：置信度、工具入口、并发、旧数据兼容
npm run verify                                # 用当前用户的记忆池验证召回门控并按类输出阈值扫描，可能补建索引
npm run build-background                      # 重新生成背景均值，换模型或改编码后必须重跑
```

## MCP 工具

| 工具 | 作用 |
|---|---|
| `memory_list` | 两组记忆的条数 |
| `memory_read` | 按置信度返回某一组的前 50 条记忆，目前无分页 |
| `memory_propose` | 提交待沉淀内容，返回相近记忆与分组建议，不写正式记忆、不增加置信度（可能补建向量索引） |
| `memory_persist` | 正式写入，初始置信度固定 0.5 |
| `memory_reinforce` | 强化已有记忆（置信度 +0.1，同一条记忆每天合计最多 0.1，上限 1） |
| `memory_merge` | 用合并后的正文替换已有记忆，重新向量化，并强化一次 |
| `memory_resolve` | 旁路模式统一处理 sessionID 对应的新增、强化、合并或不落成决策 |
| `memory_config` | 查看或修改配置 |

`memory_propose`、`memory_persist`、`memory_reinforce`、`memory_merge` 只在阻塞模式出现；`memory_resolve` 只在旁路模式出现。`memory_propose` 不落盘：它返回最相近的两条记忆和相似度，让主模型判断新建、强化或合并。相似度越高，越应当强化，而不是新建。

## 配置

`~/.memory-self-evolution/config.json`，不存在时用默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后不注入任何记忆 |
| `recallTopK` | `3` | `rule` 和 `project` 每轮**各自**最多召回几条，正整数。是上限不是配额，不相关时一条都不注入 |
| `recallMinScore` | `0.22` | `rule` 的召回下限，`-1` 关闭。实际保留线是 `max(该值, rule 的 top1 × 0.6)`，再截到 `recallTopK` |
| `recallMinScoreProject` | `0.29` | `project` 的召回下限，规则同上，用 `project` 自己的 top1 算保留线。比 `rule` 高，是为了不让无关输入带出项目事实 |
| `recallMinMargin` | `-1` | 对第二名的领先幅度下限，默认关闭 |
| `confirm` | `true` | 写盘前是否弹确认。旁路和阻塞都适用。关掉后：旁路直接写入，`stop` 只展示结果；阻塞模式在分组明确时直接落盘，信号缺失时仍弹确认 |
| `sideJudge` | `true` | `true` 为旁路，`false` 为阻塞。两条通路互斥。不能用 `memory_config` 改，只能运行 `node tools/setup.mjs sidepath` 或 `node tools/setup.mjs blocking`，然后重启客户端 |
| `sideWaitMs` | `12000` | 回答结束后，`stop` 等待旁路结果的毫秒数 |
| `decayDays` | `30` | 闲置满多少天实际扣一次置信度（`0.05`），必须是正整数，写错时按 30 处理。日检每天只跑一次，改动从次日首次会话开始生效 |
| `sideApiBase` | 无 | 旁路接口根地址，必填，没有缺省值。安装时填写，或之后写入本文件 |
| `sideApiModel` | 无 | 旁路模型名，必填，没有缺省值 |

密钥不在这张表里。`~/.memory-self-evolution/side-secret.json` 的 `apiKey` 同样必填，权限 600。`~/.memory-self-evolution/session-secret` 是 sessionID 的 HMAC 本地密钥，首次旁路分析时自动生成，权限同样为 600。

## 实测数据

以下为历史标定结果，基于当时的 24 条真实记忆、16 条相关输入 + 11 条无关输入；不代表加入召回加分和写锁后的最新端到端耗时：

- 相关召回 **14/16**，无关误放行 2/11，其中真正污染上下文的（拉进 `project` 记忆的）**0 条**
- 2026-10-11 在 47 条记忆上重新标定（46 条相关 + 51 条无关输入）：相关召回 **42/46**，无关误放行 13/51，拉进 `project` 的仍是 **0 条**，阈值保持 0.22
- 同日召回改为两类分别召回、打分减固定背景均值：相关召回 **43/46**，无关误放行 11/51，拉进 `project` 的 **0 条**；记忆池只有 1 条时相关召回 95%，改造前是 0%
- 每轮 hook 端到端 **0.23 秒**，其中模型冷启动 104ms、单条编码 5.2ms
- 1 万条记忆时的相似度计算 **6.2ms**——瓶颈不在算法，在索引的读盘与解析

功能回归使用 `npm test`：当前包含 95 项隔离测试，覆盖置信度、HMAC sessionID 幂等、客户端与会话隔离、Skip/取消兜底、每日僵尸任务清理、每日实际衰减、衰减天数配置、时间戳重置、跨会话去重、CLI/MCP/旁路入口、旧数据兼容、召回边界、并发更新与锁恢复，不读取个人记忆或请求模型 API（旁路接口用假的实现代替）。`npm run verify` 是另一套依赖当前用户记忆池的召回评测，用例需按自己的记忆库写在 `~/.memory-self-evolution/verify-cases.json`，格式见 `tools/verify-gate.mjs` 头部注释。

## 已知限制

规则首次注入和分类读取均有 50 条上限，`memory_read` 暂无分页；未注入的规则只能依赖后续相关召回，不能保证所有规则同时生效。置信度有上限且每天只加一次，常用的记忆会在十天左右都到 `1`：它只区分在用和闲置，不反映使用频率的高低。遗忘只对没被召回的记忆生效，不准确但常被召回的记忆不会自己消失。

正文写得不自包含的记忆召不回来。比如正文只有「tab 的接入文档链接为…」而不说自己是关于什么的，问「实验设置的文档」就匹配不上。沉淀时正文必须能脱离当时的对话独立读懂。

记忆正文限制在 6 到 400 个字，新建、合并、替换都按它检查，超出的拒绝写入；免确认模式下被拒不会有提示，只留日志。密钥经旁路沉淀时已被替换成 `[已隐去]`，要存这类内容只能用 `node bin/memory.mjs rule add`。

背景均值来自 60 句通用陈述句，阈值是在一份记忆库上标定的。换掉一半背景句时相关召回基本不变，但无关输入带出 `rule` 的次数会明显波动；改动 `tools/background-sentences.json` 后要重跑 `npm run build-background` 和 `npm run verify`。

向量索引用 jsonl 存，每个浮点数占约 20 字节、比 float32 二进制膨胀 5 倍。到约 3.4 万条记忆时会撞上 V8 单字符串长度上限，读写都会抛 `RangeError`。届时需要换二进制格式。

## 设计文档

本仓库版本对应的置信度演化、召回策略、判重和遗忘机制说明，见 [DESIGN.md](./DESIGN.md)。
