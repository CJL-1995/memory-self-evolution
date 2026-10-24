# memory-self-evolution

给 **Cursor**、**codebuddy**、**WorkBuddy** 和 **Claude Code** 用的自进化长期记忆。它把你在对话里表达过的偏好、规范和项目事实沉淀下来，靠本地向量模型按相关性召回。记忆强度统一用置信度描述：新建固定 0.5，强化或合并 +0.1，实际召回注入 +0.05，同一条记忆每天合计最多加 0.1，上限 1；闲置满 30 天（`decayDays` 可配置）实际扣除 0.05，降到 0.4 及以下标记废弃，一次都没被用到的新记忆最短 60 天被遗忘。

记忆文件存在 `~/.memory-self-evolution/`，几个客户端共用同一份，本地完成向量编码。沉淀新记忆要靠一个你自己提供的模型接口（OpenAI 兼容的 `chat/completions`）：旁路判别会向它发送用户原话和判重所需的相近记忆，不是完全离线运行。没配这个接口时，注入和召回照常工作，但不会记下新内容。用户原话在发送前会先在本地处理：去掉代码块和成片的代码、日志行，把形如密钥的字符串替换成 `[已隐去]`；处理后不足 6 个字或超过 500 个字的不发送。判重时发送的相近记忆不做这层处理。

## 它解决什么

同一条偏好反复讲。换个会话又要重新交代项目背景。规则说过但模型下次就忘了。

这个工具的做法是：把这类内容落盘，然后在**两个时机**把它送回模型的上下文——会话开始时无条件注入规则，每轮输入时按语义相关性分别召回规则和项目事实。

## 记忆分两类

| 类别 | 注入方式 | 典型内容 |
|---|---|---|
| `rule` | 会话开始按置信度注入未废弃规则的前 50 条，不依赖语义匹配；每轮输入时，相关的规则还会再被召回一次 | 「回答用中文」「改完代码不要自动 commit」 |
| `project` | 只在每轮输入时按语义相关性召回，会话开始不注入 | 「支付页新流程的灰度开关是 xxx」「ImageLoader 负责图片加载与缓存」 |

这一刀是按**怎么用**划分的，不是按主题。规则必须无条件注入，因为向量召回按语义相关性触发，覆盖不了「用户没提及但规则本该生效」的情况——你说「帮我改下这个函数」时，「改完不要自动 commit」和这句话在语义上并不相似，实测这类输入的召回分数只有 0.12~0.24，和无关输入完全重叠。这是机制上的边界，不是召回质量问题。

## 安装

需要 Node 20 以上。在终端里执行：

```bash
git clone https://github.com/CJL-1995/memory-self-evolution.git
cd memory-self-evolution
npm install
npm run setup
```

已经 clone 过时，在仓库目录重新执行 `npm install && npm run setup`。`npm run setup` 要在终端里跑，它会按下面的顺序做完。没有终端时它不提问、不改已有配置，后面的下载和注册照做。

1. 只问两件事，其余配置用默认值。装了 Claude Code 时会多问一件：是否给 `memory_resolve` 免批准，见下面「在 Claude Code 里」。
   - 弹出确认还是自动追加。直接回车默认弹出确认。
   - 旁路判别接口的 `baseUrl`、`apiKey`、`apiModel`。这三项没有缺省值。输入 `skip` 跳过，安装后自己写入 `~/.memory-self-evolution/config.json` 的 `sideApiBase`、`sideApiModel`，以及 `side-secret.json` 的 `apiKey`。三项配齐之前不会沉淀新记忆，见下面「没配齐接口时」。
2. 把选择写进 `~/.memory-self-evolution/`。目录不存在时会建出来。这里只落配置和密钥，记忆文件要等第一次写入才出现。同事装完是空记忆库。
3. 下载向量模型 `bge-base-zh-v1.5`（约 98MB）到本仓库的 `node_modules/@huggingface/transformers/.cache/`。缓存已在则直接复用。下载失败时安装中止，后面的 hook 和 MCP 不会注册。
4. 用当前 `node` 的绝对路径，把 hook 和 MCP 写进本机已经安装的客户端。没装的客户端跳过。已有的其他 hook 和 MCP 保留。本插件注册过时，只更新 node 与仓库路径，不会追加第二条。同时把整理记忆用的 skill 复制到各端的个人 skill 目录（`~/.cursor/skills`、`~/.codebuddy/skills`、`~/.workbuddy/skills`、`~/.claude/skills` 下的 `memory-self-evolution-manage`），见下面「整理记忆」。

| 客户端 | hook | MCP |
|---|---|---|
| Cursor（存在 `~/.cursor`） | `hooks.json` 的 `sessionStart`、`beforeSubmitPrompt`、`stop` | `mcp.json` 的 `memory-self-evolution` |
| codebuddy（存在 `~/.codebuddy`） | `settings.json` 的 `SessionStart`、`UserPromptSubmit`、`Stop` | `mcp.json` 的 `memory-self-evolution` |
| WorkBuddy（存在 `~/.workbuddy`） | `settings.json` 的 `SessionStart`、`UserPromptSubmit`、`Stop` | `mcp.json` 的 `memory-self-evolution` |
| Claude Code（存在 `~/.claude`） | `settings.json` 的 `SessionStart`、`UserPromptSubmit`、`Stop` | 用 `claude mcp add --scope user` 注册，落在 `~/.claude.json` |

各端各自启动同一套 MCP 程序，共享本机记忆文件，不是共用一个常驻进程。工具列表固定为 `memory_list`、`memory_read`、`memory_update`、`memory_resolve` 和 `memory_config`。主模型能直接改记忆的只有 `memory_update`，只在你明确要求整理记忆时使用；新增记忆不经过主模型。

注册完成后重启 Cursor、codebuddy、WorkBuddy 和 Claude Code，MCP 才会加载。之后只想重新注册时（比如换了 node 或挪了仓库）运行 `node tools/setup.mjs sidepath`，不再提问，同样会先确认模型缓存再重新注册；重新注册会清理旧版本遗留的本插件工具后 Hook，不影响其他插件。只想处理某一端时加 `--only`，比如 `node tools/setup.mjs --only claude`：只注册这一端，不问确认方式和接口，也不读写其它客户端的配置文件。注册的 hook 超时：会话开始 10 秒，回答结束 20 秒；每轮输入的 hook 在 Cursor 是 5 秒，在 codebuddy 和 WorkBuddy 是 10 秒，宿主会等它返回后再把本轮交给模型。

## 卸载

```bash
npm run uninstall
```

插件仓库保留。它会删掉安装时落下的向量模型、各端里本插件的 hook、MCP 注册和 skill。其他 hook、MCP 和 skill 不动。只想去掉某一端时用 `node tools/uninstall.mjs --only claude`，这时向量模型、配置和其它客户端都不动。

`~/.memory-self-evolution/` 目录保留。里面只删 `config.json`、`side-secret.json`、`session-secret` 和 `side/`，其余都不动：记忆 `rule.jsonl` 和 `project.jsonl`、向量索引 `embeddings.jsonl`、给人核对的快照 `memories.html`、回收站 `trash.jsonl`、日检记录 `decay-state.json`、评测用例 `verify-cases.json`。重新安装时再跑 `npm run setup`，模型会重新下载，配置和本地密钥会在需要时重新生成。卸完后重启各客户端，MCP 才会从已经打开的会话里消失。

## 怎么让它记住东西

沉淀只走旁路这一条通路。`confirm` 只决定写盘前弹不弹确认。

**记什么。** 只记跨会话还用得上的内容：跨任务都适用的偏好和工作规范；文档、链接、仓库、目录、开关、账号这类长期查阅信息；跨项目通用的技术选型结论。只在当前任务里成立的内容不记，说得再肯定也一样：方案讨论和分析；实验、训练、数据处理里的参数、阶段结论和标注口径；单个 bug、需求或 MR 的细节；为当前任务交代的背景；假设和提问；对话内的澄清；带期限的安排。你明确说「记住」「记一下」时照记，不受这些限制。

**旁路。** hook 在后台判断这句该不该记，不挡住本轮回答。判别模型一次给出该不该记、记忆正文和分组（`rule` 或 `project`），输出不是 JSON 的按不记处理；要记的再和最相近的 3 条已有记忆比一次，定出新增、强化、合并还是替换。能写记忆的工具只有 `memory_resolve(sessionID, decision)`。`confirm=false` 时后台直接新增、强化、合并或替换，`stop` 只让主模型把结果原样展示出来。`confirm=true` 时，`stop` 让主模型弹出确认，先不写；插件为每条提案给出 sessionID，用户点选后主模型调用一次 `memory_resolve`。decision 统一为 `create_rule`、`create_project`、`reinforce`、`merge`、`replace`、`discard`。`replace` 用在新说法和已有记忆冲突时，用新正文整条换掉旧记忆。新建和 `discard` 总是可选，`reinforce`、`merge`、`replace` 只在这条提案给出了对应选项时才接受。插件只消费 sessionID 对应的当前客户端待确认提案，正文、目标记忆和合并正文不能由主模型覆盖；无效、跨客户端、已处理或动作不匹配的 sessionID 会被拒绝，新一次弹窗会作废同一客户端同一会话之前问过但没点选的提案。sessionID 使用本地 256 位密钥，对 `agent + sessionKey + 每轮输入的 ID + SHA256(prompt) + version` 做 HMAC-SHA256（每轮输入的 ID 在 Cursor 是 `generation_id`，在 Claude Code 是 `prompt_id`，CodeBuddy 和 WorkBuddy 不提供）；同一 Hook 重试得到同一个 sessionID，并通过排他建档只启动一次分析。已结束任务保留 24 小时作为幂等墓碑。密钥首次使用时自动生成到 `~/.memory-self-evolution/session-secret`，权限 600，不经 MCP 或上下文返回。使用 CodeBuddy IDE 自定义智能体时，工具白名单里必须包含 `ask_followup_question`，否则无法弹窗。各端共用同一条旁路：请求 `sideApiBase/chat/completions`。`sideApiBase`、`sideApiModel` 和 `side-secret.json` 中的 `apiKey` 都没有缺省值，缺任何一项时不启动判别。

旁路任务按 `agent + sessionKey` 强制隔离。Cursor 的 sessionKey 取 `conversation_id`，CodeBuddy / WorkBuddy / Claude Code 取 `session_id`。每次 Stop 只等待、展示和作废当前客户端当前会话的任务；其他会话或其他客户端的任务继续留在池中，等自己的 Stop 处理。Cursor 用于还原隐藏确认指令的临时文件也按客户端和会话分别保存。宿主没有提供稳定会话 ID 时 fail closed：本轮不启动旁路分析并记录原因，避免空 ID 串会话。正式落盘后的 `rule` / `project` 仍是跨会话共享的长期记忆。

**没配齐接口时。** 判别不启动，不会沉淀新记忆；已有记忆照常注入和召回。这时会话开始和每轮输入注入的不再是「后台在判断」的提醒，而是「记忆沉淀未启用」和启用方法，你陈述偏好或要求记住时，主模型会告诉你这句话不会被记下。急用可以用下面的命令直接写。

**从旧版本的阻塞模式升级。** 阻塞模式（主模型调用 `memory_propose` 等工具自己写记忆）已经移除。配置里还留着 `sideJudge=false` 的安装不会自动改走旁路，因为旁路会把你的原话发给外部接口：升级后沉淀处于未启用状态，会话里有同样的提示。运行 `npm run setup` 或 `node tools/setup.mjs sidepath` 后改走旁路，再重启客户端；`node tools/setup.mjs blocking` 会报错退出。阻塞模式下主模型能结合整段对话来写记忆，旁路的判别模型只看你当前这一句，像「记住刚才那个结论」这种指代上文的话记不下来，要把内容说完整。

**自己直接写。** 不想经过模型判断时：

```bash
node bin/memory.mjs rule add "所有异常处理处都需要添加日志"
```

早期版本还有一条关键词候选池通路（从历史会话里按信号词捞原话），已经移除：旁路有判别模型，不依赖它。旧版本留下的 `~/.memory-self-evolution/candidates.json` 不再被读写，可以自行删除。

## 整理记忆：查看、删除、合并、改写

在任意一端的对话里直接说就行，比如「列出我的记忆」「把代理节点那条记忆删掉」「删除 id1 id2 id3」「把这两条合并成……」「这条改成……」。安装时放进各端的 skill（`memory-self-evolution-manage`）规定了主模型怎么做：只处理这个插件的记忆，不碰客户端自带的记忆，也不直接改记忆库里的文件。

| 操作 | 主模型调用 | 结果 |
|---|---|---|
| 查看全部 | `memory_list`，`open=true` | 刷新 `memories.html` 并用系统默认浏览器打开。旧版本留下的 `memories.md` 不再更新，生成新快照时会删掉 |
| 删除 | `memory_update`，`delete`，一条用 `id`，多条用 `ids` | 从分组文件、向量索引和快照里去掉，进回收站。多条时一次确认、一次调用；不存在的 id 跳过，其余照常删除，一个都不存在时报错 |
| 合并 | `memory_update`，`merge`，`id`、`id2`、`text` | 保留 `id`，正文换成你给的 `text` 并重算向量；`id2` 进回收站；置信度取两条中较高的 |
| 改写 | `memory_update`，`replace`，`id`、`text` | 正文换成 `text` 并重算向量，置信度不变 |

- **确认**：执行前主模型会把要做的事给你看，用提问工具让你选确认或取消。`memory_update` 不在 Claude Code 的免批准规则里，客户端按自己的权限设置可能再问一次。合并和改写的正文由你给出，6 到 400 个字。
- **回收站**：删除和被并掉的记忆进 `~/.memory-self-evolution/trash.jsonl`，保留 30 天，每日维护时清掉过期的。列出回收站用 `node bin/memory.mjs trash`，恢复用 `node bin/memory.mjs restore <id>`。
- **什么时候生效**：每轮召回立即生效；当前会话开始时已经注入的规则留在这个会话里，到下一个会话才消失。指向这条记忆的待确认提案会一并作废。
- **不会动的**：`project-memory/` 里被记忆指向的文档，以及目录里的 `*.bak-*` 备份。要彻底清除某条内容（比如带口令的），这两处要自己处理。
- **skill 是复制过去的**：仓库更新后重新运行 `npm run setup` 或 `node tools/setup.mjs sidepath`，才会更新各端的副本。

## 注入与主模型职责

- **会话开始**：`sessionStart` 只注入规则列表和职责边界，不附项目读取说明或 `confirm` 状态。记忆提取、判重和沉淀由后台负责，包括用户明确要求「记住」的情况；主模型专注当前任务，只在收到插件后续指令时按指令执行，不重新判断或改写提案。
- **每轮输入**：插件启用时，即使没有召回结果，也会追加以下提醒；确认续轮、结果通知和空输入不重复追加，也不受 `confirm` 值影响。旁路接口没配齐、或配置还停在旧版本的阻塞模式时，这段提醒和会话开始的职责边界都换成「记忆沉淀未启用」的说明和启用方法。

  > 记忆由 memory-self-evolution 插件在后台判断。用户陈述偏好、规范或要求记住时，你只需回应并照做：不要判断是否该记，不要调用提问工具发起「检测到一条记忆」确认，也不要主动调用 memory_resolve 或其它记忆写工具。只有收到含 MEMORY_CONFIRM_V1 的插件指令时，才按指令弹窗并处理对应 sessionID。

  插件发起的确认弹窗标题固定为「记忆确认·插件」。各端只在用户明确点选后调用 `memory_resolve`；明确选择「不落成」时传入同一 sessionID，并使用 `discard` 结束本次分析。提问工具自动返回 `Skipped`，或用户关闭/取消弹窗时不要调用 `memory_resolve`，未处理任务由下一次每日僵尸清理兜底。

- **Claude Code 里的说法不同**：会话开始的职责边界和上面这段每轮提醒，在 Claude Code 里换成只约束本插件的说法，不要求主模型放下 Claude Code 自带的记忆。
- **规则上限**：从未废弃的 `rule` 中按已存储置信度降序选前 50 条，同分时最近活跃的在前。每轮语义召回仍从全部未废弃的 `rule` 和 `project` 中检索，不受该 50 条限制。
- **每轮召回**：`rule` 和 `project` 分别召回，各自过自己的阈值、各自最多 3 条，注入时分「规则」「项目事实」两组列出，不合并排序；两类都没有过线时不注入。打分减的是随仓库分发的固定背景均值，不依赖记忆池，所以只有 1 条记忆时也能召回。项目事实不在 `sessionStart` 注入，只通过每轮召回进入上下文。

## 在 Claude Code 里

命令行和桌面端共用 `~/.claude`，注册一次两边都生效。hook 追加在 `~/.claude/settings.json` 里已有的 hook 之后，互不影响。

注册之后要重启 Claude Code。hook 对已经打开的会话立刻生效，MCP 却要到重启后才加载：这段时间里注入、召回和免确认的写入都正常，但开着确认时没法点选写入，主模型会提示你重启后再说一遍，不会弹窗。

- **MCP 的注册**：Claude Code 的用户级 MCP 存在 `~/.claude.json`，`settings.json` 里的 `mcpServers` 不生效，所以安装脚本调用 `claude mcp add --scope user` 来注册。它先找 `PATH` 里的 `claude`，没有就用桌面端自带的那个（`~/Library/Application Support/Claude/claude-code/` 下版本最新的）；都不在时用环境变量 `MEMORY_CLAUDE_BIN` 指明路径。找不到时 hook 照常注册，并打印出要手动运行的那条命令。
- **免批准规则**：Claude Code 默认每次调用 MCP 工具都要你批准。开着确认时，在记忆弹窗里点选之后，它还会再问一次是否允许调用 `memory_resolve`。安装时同意的话，脚本会在 `~/.claude/settings.json` 的 `permissions.allow` 里加一条 `mcp__memory-self-evolution__memory_resolve`，只放开这一个工具：它只收 sessionID 和你的选择，只能处理刚弹过窗的提案，改不了正文。没有终端时不加，需要的话照这个名字自己加。`memory_config` 能改判别接口的地址，不放开；`memory_update` 会删改已有记忆，也不放开。卸载时这条规则会一并去掉。
- **和自带记忆并存**：Claude Code 有自己的一套记忆，按项目存放。插件不去改它的开关，两边各记各的，同一句话可能两边都记下。想只用插件时，在 `~/.claude/settings.json` 里加 `"autoMemoryEnabled": false`。
- **不送去判别的输入**：子任务里的输入、斜杠命令、以标签开头的内容（任务通知、系统提醒这类由客户端送进来的输入）。召回照常进行。子任务结束时不续轮。
- **会话开始的注入有上限**：Claude Code 对单次注入限 1 万字，超过会被换成文件路径加一段预览。规则按置信度从高到低列，放不下的不列并注明条数，相关时仍会在每轮召回里出现。按 Claude Code 的文档，压缩上下文之后会再触发一次会话开始，规则随之重新注入。

## 置信度与旧数据兼容

正式记忆只维护 `confidence`，它表示强度，不是概率，范围 `0` 到 `1`。

| 场景 | 变化 |
|---|---|
| 新建（CLI、旁路一致） | 初始固定 `0.5`，不接受自定义值 |
| 强化或合并 | `+0.1` |
| 每轮实际召回并注入 | 每个命中 ID `+0.05` |

同一条记忆在一个本地日内只加一次分，合计不超过当天发生过的最大一档：只被召回是 `0.05`，当天有过强化或合并则补到 `0.1`。用户重述一条已有记忆时，这句话自己会先把它召回，随后的强化只补差额。新建当天视为已加过分。合并在当天已加满时照常替换正文，只是不再加分。置信度到 `1` 后不再增长，但当天第一次生效的召回或强化仍会刷新 `lastSeen`。通知里显示的是本次实际加分。

会话开始的规则注入、手动读取、判重检索和评测不加分；无命中或召回失败也不加分。实际生效的强化、合并和召回奖励会把 `lastSeen` 重置为当前时间。

每天首次 `sessionStart` 检查衰减：距离 `lastSeen` 满 `decayDays` 天（默认 30）的有效记忆，实际置信度扣除 `0.05` 并落盘，同时把时间戳更新为当前时间；未满不更新时间。修改 `decayDays` 用 `node bin/memory.mjs config decayDays 60`，或直接改 `config.json`，从次日首次会话开始生效。一次只扣一次，不追补历史多个周期。当天检查成功后记录在 `~/.memory-self-evolution/decay-state.json`，各客户端、各会话共用；当天后续会话直接跳过。没有新会话就不检查，`Stop` 不再执行衰减。

同一次每日维护还会清理旁路僵尸任务：仅处理前一天及更早、已经弹出确认但始终没有执行 `memory_resolve` 的任务，将其标记为 `daily-zombie-cleanup`。当天刚弹出的任务和从未弹窗的任务不会被提前清理；主模型正常执行 `discard` 时仍会立即结束，不等待每日兜底。判别完成时所在会话已经没有下一次回答的提案属于「从未弹窗」：它一直保留，那个会话再回答一次时才弹出；前一天及更早的这类提案，每日维护只记一条日志说明有几条。

实际置信度降到 `0.4` 及以下即标记废弃。新记忆 `0.5` 起步，一次都没被召回或重述时，第 30 天 `0.45`、第 60 天 `0.4` 并废弃，这是默认配置下最短的遗忘时间；到过上限 `1` 的记忆要连续闲置 12 个周期才废弃。废弃记忆不参与规则注入、召回和判重相似度比较，不继续日常衰减，也不自动删除。显式强化或合并后高于 `0.4` 可以恢复。已扣分数不会因再次使用而还原，例如 `0.7` 衰减为 `0.65` 后召回一次变成 `0.7`。日检失败不会标记当天完成，下一次会话会重试。

旧记忆保留历史置信度，但超过上限 `1` 的值会在下一次日检时压到 `1`；读取时忽略旧 `observations`，组文件下次因内容、强度或废弃状态变化而重写时清除该字段，不在读取时批量迁移。卸载重装不会重置历史置信度。

正式记忆变更共用跨进程写锁，召回加分按组批量更新，不额外调用模型或重建已有向量；命中的记忆当天都已加过分时，这一轮不拿锁也不写盘。写锁被占着时，召回加分只等 300 毫秒就放弃这一次，召回内容照常返回；锁目录存在超过 15 秒会被当作残留回收。加分失败记录日志，但仍返回召回内容。更新代码后应重启各客户端的 MCP，避免旧进程继续使用旧规则。

## 命令

```bash
node bin/memory.mjs list                  # 两组各有多少条
node bin/memory.mjs read rule             # 看规则
node bin/memory.mjs read project          # 看项目事实
node bin/memory.mjs rule add "<规则>"      # 直接新增规则
node bin/memory.mjs trash                 # 列出回收站
node bin/memory.mjs restore <id>          # 从回收站恢复一条记忆
node bin/memory.mjs config                # 查看配置
node bin/memory.mjs config recallTopK 5   # 改配置，下一轮输入即生效
npm run setup                                 # 交互安装并注册 Cursor / codebuddy / WorkBuddy / Claude Code
node tools/setup.mjs --only claude            # 只注册某一端，不问确认方式和接口，不碰其它客户端
node tools/uninstall.mjs --only claude        # 只去掉某一端的 hook、MCP 和 skill，模型、配置和其它客户端不动
npm run uninstall                             # 卸掉模型、hook、MCP 和配置，保留记忆与插件仓库
node tools/setup.mjs sidepath                 # 不提问，确认模型缓存并重新注册；旧的阻塞模式配置同时改为旁路
npm test                                      # 隔离回归，不读个人记忆、不请求模型接口
npm run verify                                # 用当前用户的记忆池验证召回门控并按类输出阈值扫描，可能补建索引
npm run rebuild-index                         # 备份旧索引后按当前模型重建全部向量，换模型或手改过记忆正文后用
npm run build-background                      # 重新生成背景均值，换模型或改编码后必须重跑
```

## MCP 工具

| 工具 | 作用 |
|---|---|
| `memory_list` | 两组记忆的条数；带 `open=true` 时刷新并在浏览器里打开 `memories.html` |
| `memory_read` | 按置信度返回某一组的前 50 条记忆，已废弃的也列出并标注，目前无分页 |
| `memory_update` | 你明确要求时删除、合并或改写已有记忆，见「整理记忆」 |
| `memory_resolve` | 统一处理 sessionID 对应的新增、强化、合并、替换或不落成决策 |
| `memory_config` | 查看或修改配置 |

新增记忆不经过主模型：`memory_resolve` 只能处理插件已经弹过窗的提案，正文和目标记忆都取自提案，只按任务状态判断、不读配置。`memory_update` 只改已有的记忆，不能新增。另外的写入方式是命令行的 `rule add` 和 `restore`。

## 配置

`~/.memory-self-evolution/config.json`，不存在时用默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后 hook 不注入任何记忆，旁路判别也不启动。命令行不受影响 |
| `recallTopK` | `3` | `rule` 和 `project` 每轮**各自**最多召回几条，正整数。是上限不是配额，不相关时一条都不注入 |
| `recallMinScore` | `0.22` | `rule` 的召回下限，`-1` 关闭。实际保留线是 `max(该值, rule 的 top1 × 0.6)`，再截到 `recallTopK` |
| `recallMinScoreProject` | `0.29` | `project` 的召回下限，规则同上，用 `project` 自己的 top1 算保留线。比 `rule` 高，是为了不让无关输入带出项目事实 |
| `recallMinMargin` | `-1` | 对第二名的领先幅度下限，默认关闭 |
| `confirm` | `true` | 写盘前是否弹确认。关掉后后台直接写入，`stop` 只展示结果。改完从下一轮输入开始生效，不用重启客户端 |
| `sideWaitMs` | `12000` | 回答结束后，`stop` 等待旁路结果的毫秒数 |
| `decayDays` | `30` | 闲置满多少天实际扣一次置信度（`0.05`），必须是正整数，写错时按 30 处理。日检每天只跑一次，改动从次日首次会话开始生效 |
| `sideApiBase` | 无 | 旁路接口根地址，必填，没有缺省值。安装时填写，或之后写入本文件。和 `sideApiModel`、`apiKey` 三项没配齐时不沉淀新记忆 |
| `sideApiModel` | 无 | 旁路模型名，必填，没有缺省值 |

密钥不在这张表里。`~/.memory-self-evolution/side-secret.json` 的 `apiKey` 同样必填，权限 600。`~/.memory-self-evolution/session-secret` 是 sessionID 的 HMAC 本地密钥，首次旁路分析时自动生成，权限同样为 600。

## 实测数据

2026-10-11 在一份 47 条的真实记忆库（`rule` 28 条、`project` 19 条）上测得，输入是 46 条相关 + 51 条无关：

- 相关召回 **43/46**；无关输入有 11/51 带出了记忆，带出的都是 `rule`，真正污染上下文的（带出 `project` 的）**0 条**
- 记忆库只有 1 条时相关召回 95%
- 每轮输入的 hook 端到端 **0.22~0.24 秒**，进程启动、加载模型、编码、打分、给命中的记忆加分并写盘都在内；有没有命中相差约 10 毫秒
- 模型选型时单独测得的冷启动是 104ms，单条编码 5.2ms
- 1 万条记忆时的相似度计算 **6.2ms**（合成数据）——瓶颈不在算法，在索引的读盘与解析

改造前（两类合在一起排序、打分减当前记忆池的均值）同一批输入是 42/46 和 13/51，记忆库只有 1 条时召不回。阈值不是常数：换模型、改编码或重新生成背景均值后都要用 `npm run verify` 重新标定，记忆库明显变大后也值得重跑一次。

功能回归使用 `npm test`：全部是隔离测试，覆盖置信度、HMAC sessionID 幂等、客户端与会话隔离、Skip/取消兜底、每日僵尸任务清理、每日实际衰减、衰减天数配置、时间戳重置、跨会话去重、CLI/MCP/旁路入口、接口没配齐和旧阻塞配置下的提示、旧数据兼容、召回边界、并发更新与锁恢复，Claude Code 这一端的适配和安装，删除、合并、改写与回收站、skill 的安装，以及下面「代码结构」里说的两份三端快照，不读取个人记忆或请求模型 API（旁路接口用假的实现代替）。`npm run verify` 是另一套依赖当前用户记忆池的召回评测，用例需按自己的记忆库写在 `~/.memory-self-evolution/verify-cases.json`，格式见 `tools/verify-gate.mjs` 头部注释。

## 代码结构

- `bin/`：两个入口。`memory.mjs` 是 hook 和命令行，`memory-mcp.mjs` 是 MCP 服务。
- `lib/core/`：记忆的读写、召回、旁路判别和确认流程，各端共用，不按名字判断是哪一端。
- `lib/hosts/`：各端在 hook 协议上的差异，一个客户端一个文件：事件名、输入字段、注入和续轮的输出格式、续轮指令里随客户端变的措辞。
- `tools/hosts/`：各端的注册和移除，`setup` 和 `uninstall` 共用。
- `skills/`：整理记忆用的 skill，`setup` 复制到各端的个人 skill 目录。

接入新的客户端，是在 `lib/hosts/` 和 `tools/hosts/` 各加一个文件并登记一行，要实现的成员写在这两个目录的 `index.mjs` 开头。

Cursor、CodeBuddy、WorkBuddy 的行为由两份快照锁住：`tests/fixtures/host-snapshot.json` 记录这三端在每个 hook 事件下交给客户端的内容，`tests/fixtures/install-snapshot.json` 记录安装和卸载写出的配置文件和打印的结果。两份都是在抽出 `lib/hosts/` 之前的代码上生成的。一次改动不该影响这三端时，这两份文件必须一个字都不变；确实要改这三端的行为时，用 `UPDATE_HOST_SNAPSHOT=1 npm test` 重新生成，并逐行核对差异。

## 已知限制

规则首次注入和分类读取均有 50 条上限，`memory_read` 暂无分页；未注入的规则只能依赖后续相关召回，不能保证所有规则同时生效。置信度有上限且每天只加一次，常用的记忆会在十天左右都到 `1`：它只区分在用和闲置，不反映使用频率的高低。遗忘只对没被召回的记忆生效，不准确但常被召回的记忆不会自己消失。

正文写得不自包含的记忆召不回来。比如正文只有「tab 的接入文档链接为…」而不说自己是关于什么的，问「实验设置的文档」就匹配不上。沉淀时正文必须能脱离当时的对话独立读懂。

记忆正文限制在 6 到 400 个字，新建、合并、替换都按它检查，超出的拒绝写入；免确认模式下被拒不会有提示，只留日志。密钥经旁路沉淀时已被替换成 `[已隐去]`，要存这类内容只能用 `node bin/memory.mjs rule add`。

没有改分组的操作。要把一条记忆换到另一组，只能手动改 `rule.jsonl`、`project.jsonl`（记录里的 `category` 字段要一起改），改完再跑一次 `npm run rebuild-index`。

主模型会不会按 skill 走插件的工具，而不是去改客户端自带的记忆，取决于它有没有加载这个 skill。skill 按你的说法匹配加载，不保证每次都加载。

hook 每次都重新读 `config.json`，注入、判别和弹不弹确认都跟着最新的配置走。MCP 进程只在启动时读一次，受影响的只有 `memory_config` 自己：它显示的是进程启动时的值加上它自己改过的值；用它改一项时，其它项会按这份旧值一起写回文件，盖掉之后在命令行、文件或另一个客户端里改过的值。`memory_resolve` 不读配置。另外，用命令或 `memory_config` 改过任意一项后，全部配置项都会按当时的值写进文件，之后仓库更新的默认值不会自动生效。

Claude Code 这一端的弹窗确认（回答结束时续一轮、弹出提问、点选后调用 `memory_resolve`）已经在真实的桌面端会话里完整走通过。定时任务和 `/loop` 送进来的输入长什么样没有实测，现在是按开头的形状挡掉的。

判别模型只看用户当前这一句，而且是本地处理之后的 6 到 500 个字。指代上文的话、要结合好几轮才看得出的纠正、主模型自己查出来而用户没有说出口的事实，都不会被记下。

背景均值来自 60 句通用陈述句，阈值是在一份记忆库上标定的。换掉一半背景句时相关召回基本不变，但无关输入带出 `rule` 的次数会明显波动；改动 `tools/background-sentences.json` 后要重跑 `npm run build-background` 和 `npm run verify`。

向量索引用 jsonl 存，每个浮点数占约 20 字节、比 float32 二进制膨胀 5 倍。到约 3.4 万条记忆时会撞上 V8 单字符串长度上限，读写都会抛 `RangeError`。届时需要换二进制格式。
