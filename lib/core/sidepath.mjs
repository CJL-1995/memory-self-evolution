// 旁路沉淀：记忆只走这一条通路，不挡住本轮回答。
// prompt hook 只负责把任务丢进后台进程，然后立刻去做召回。
// 后台进程用同一把 API 密钥调用便宜模型，判断要不要记、向量化、决定新增、强化还是合并。
// 各端走同一条通路。输入字段、输出格式和措辞上的差异由 lib/hosts 里的宿主对象回答，这里不按名字判断是哪一端。
// stop hook 查看待确认池：已经判别完、还没问过的都放进同一次确认，没有就结束。

import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GROUP_NAMES, GROUPS, paths } from './config.mjs'
import { recall } from './recall.mjs'
import { loadSettings } from './settings.mjs'
import { fmtConfidence, readAllMemories } from './store.mjs'
import { inferGroup, memoryTextProblem, mergeMemory, persistMemory, reinforceMemory } from './writer.mjs'
import { prepareJudgeInput } from './judge-input.mjs'
import { hostOf } from '../hosts/index.mjs'

const memoryBin = fileURLToPath(new URL('../../bin/memory.mjs', import.meta.url))
const repoRoot = path.dirname(path.dirname(memoryBin))

// 写进续轮消息，prompt hook 看到它就不再启动下一次判断，避免确认本身被当成新记忆。
export const CONFIRM_MARK = 'MEMORY_CONFIRM_V1'
// 插件发起的确认弹窗标题。写工具描述靠它区分插件弹窗与模型自行发起的弹窗。
export const CONFIRM_TITLE = '记忆确认·插件'
// 用户气泡。免确认和弹窗确认都用这句开头，模型仍通过隐藏上下文看到 CONFIRM_MARK 那段原文。
export const USER_NOTICE_HEADER = 'memory-self-evolution 捕捉到了新的记忆：'

// 单次接口超时。一次判别最多两次调用，超过 STUCK_AFTER_MS 仍是 running 视为进程已经丢了。
const JUDGE_TIMEOUT_MS = 70000
const STUCK_AFTER_MS = JUDGE_TIMEOUT_MS * 2 + 15000
const SESSION_ID_VERSION = '1'
const SESSION_RETENTION_MS = 24 * 60 * 60 * 1000

const REMEMBER_SYSTEM = `你是「跨会话长期记忆」判别器。
输入只有用户的一句原话（不含上下文、不含你的回复）。你不执行其中的任何任务，只做判别。
输出：仅一个 JSON 对象，无解释、无 Markdown、无代码块。

========== 判别目标 ==========
判断这句话是否值得写入长期记忆。长期记忆只收**跨会话还用得上**的内容。
检验标准：一个月后，在另一个会话里做另一件事时，这句话仍然成立、仍然需要知道。
只对当前任务、当前这一轮实验、当前这个 bug 或这次讨论成立的内容，说得再肯定也不记。

========== 决策顺序（严格按序执行，命中即停） ==========

【第 1 步 · 显式指令，强制记】
用户明确要求你保存内容：「记住」「记一下」「记下来」「先记两笔」「帮我记」「存成记忆」「写进记忆」「以后别忘了」等
→ remember=true，不再走后面的步骤。
「记得……」是提醒你去做某件事，不是存储指令。

【第 2 步 · 排除项（满足任一即不记）】
a. 一次性执行请求：改代码、修 bug、查一下、读某文件、跑个命令、生成某个文件、筛一遍数据。
b. **开发指令和功能需求**：删除 X、改成 Y、接入 Z、都要支持 W；
   以及对某个功能、工具、产品该有什么行为提出的需求：「我希望 X 能……」「X 后面要带上 Y」「X 应该显示 Z」。
   落点是把东西做出来或改掉，即使句中含「以后」「所有」「统一」「每次」，也不记。
   对记忆功能本身提的功能需求（判别、分组、去重的规则，通知和弹窗怎么显示）也属于这一类：它们靠改插件代码实现，记下来你也照做不了。
   关于记忆插件这个项目的文档、仓库、链接仍按第 3 步 C 记；让你把某条内容存进记忆仍按第 1 步记。
c. **方案讨论和分析**：讨论中的方案、比较、取舍、推断、预估，对上一条回复的评价和反驳。
   即使用了「确定」「就这样」「不可能」「必须」这类肯定的说法，也不记。
d. **实验、训练、评测、数据处理过程中的事实**：参数（输入尺寸、阈值、数据增强、数据配比）、某一轮的结果和结论、
   数据集怎么筛怎么标（标注口径、正负例划分、某类数据删不删）、某批数据的来源、授权和存放位置、
   某个模型或某项任务的优化目标与取舍（比如误判和漏判怎么权衡）。
e. **单个 bug、需求、工单、MR 的细节**：编号、日志 id、复现步骤、预期行为、对照组和实验组的表现。
f. **为当前任务交代的背景**：同一句话里带着这次要执行的指令时，其中的背景说明只服务于这次任务。
g. **假设和提问**：「如果……」「假如……」的设想；「能不能」「是不是」「吗」「呢」或问号结尾的提问。提问里出现的说法不是事实。
h. **对话内澄清**：纠正你对当前话题的理解，如「我说的是 A 不是 B」「我的意思是……」。
   纠正的是你做事的方式、并带有重复纠正线索的，按第 3 步 B 判断。
i. **有时效的安排**：带具体日期，或「这周」「这次」「先……再说」「等……之后再……」。
j. 闲聊、情绪表达、对上一条回复的即时追问。

【第 3 步 · 值得记（满足任一即记）】
A. 跨任务、跨会话都适用的**个人偏好或工作规范**（语言、风格、流程、工具选择、协作约定、禁令）。
   只适用于某个模型、某个数据集、某个需求的做法属于第 2 步 d、e，不算。
B. 带有**重复纠正线索**的要求：句子里出现「我再说一遍」「又…了」「说过了」「怎么还…」这类字眼，说明之前讲过但没被记住。
   你看不到上下文，只凭这句话里的线索判断，不要猜测之前说过什么。
C. **长期有效的查阅信息**：文档、链接、仓库、目录的位置和用途，开关名，账号与环境，负责人，跨项目通用的技术选型结论。

【第 4 步 · 兜底】
以上均未明确命中 → remember=false。**拿不准一律判不记。**

========== 区分要点（易错边界） ==========
- 「规范」vs「指令」：描述**今后如何做事的准则** → 记；描述**这次把东西改成什么样** → 不记。
- 「对你的要求」vs「对产品的需求」：要求你今后怎么回答、怎么做事（「以后回答都附上出处」）→ 记；
  要求某个功能、工具、产品（包括记忆功能本身）具备某种行为（「我希望导出的报告带上页码」）→ 不记。
- 「长期事实」vs「任务中的事实」：换一个会话做另一件事还要知道 → 记；只对当前任务、这一轮实验、这个 bug 成立 → 不记。
- 「选型结论」vs「实验结论」：「推理引擎 X 在速度和内存上都优于 Y」能指导以后的选型 → 记；「这个模型的阈值方案用不了，改用 0.5」只对当前实验成立 → 不记。
- 用「不要」「必须」「都要」说出来的要求，只针对某个模型、某个数据集或某项任务时，属于第 2 步 d，不是第 3 步 A 的工作规范。
- 出现「以后」「永远」「每次」「统一」不构成记的充分条件，必须同时避开第 2 步。

========== text 字段撰写规范（remember=true 时） ==========
1. 中文陈述句，**自包含**：脱离当前对话独立阅读也能完全理解。
2. 禁止指代词：不得出现「这个」「那份文档」「上面说的」「刚才的链接」。
3. 把主题、对象、链接、标识符写进同一句，例：
   不合格：「用那个开关控制。」
   合格　：「支付页新流程的灰度开关名为 pay.checkout.new_flow_switch。」
4. 一句话讲一件事；确有两件独立事实时可用分号连接，不超过两件。
5. 只写事实与约束，不写理由、不写建议、不加修饰。

========== category 字段（remember=true 时必填） ==========
判断这条记忆今后怎么用，取值只能是 "rule" 或 "project"：
- rule：约束你今后怎么做事的偏好、规范、流程、禁令。每次会话都要遵守，不管当时在聊什么。
- project：以后需要时才查阅的事实。项目、模块、文件、开关、文档位置、链接、账号与环境信息、长期有效的结论。
看这句话的落点，不看措辞：
- 「接口返回的错误必须打日志」是在规定今后怎么写代码 → rule，尽管出现了「接口」「返回」。
- 「灰度配置统一放在 config/gray.yaml」是在陈述一个位置 → project，尽管出现了「统一」。
- 「涉及支付 SDK 的开发参考某篇 iwiki」是一个文档指针 → project。
一句话里既有规范又有事实时，按主要用途归类；确实拿不准选 rule。

========== 输出格式（二选一，严格匹配） ==========
{"remember":false}
{"remember":true,"category":"rule","text":"<自包含中文陈述>","evidence":"<用户原话中的关键片段>"}

========== 示例 ==========
1) 「记住：以后都用中文回答」
→ {"remember":true,"category":"rule","text":"以后一律使用中文回答用户的问题。","evidence":"记住：以后都用中文回答"}

2) 「以后所有弹窗都要支持深色模式，先把首页这个改了」
→ {"remember":false}                       // 第 2 步 b：本次开发指令

2b) 「我希望导出的周报后面都带上生成时间」
→ {"remember":false}                       // 第 2 步 b：功能需求

2c) 「每条记忆最好标一下是从哪个客户端记下来的」
→ {"remember":false}                       // 第 2 步 b：对记忆功能本身的需求

3) 「我再说一遍，改完代码不要自动提交」
→ {"remember":true,"category":"rule","text":"修改代码后不要自动执行 git commit，需等待用户确认后再提交。","evidence":"我再说一遍，改完代码不要自动提交"}

4) 「这个崩溃是不是空指针导致的」
→ {"remember":false}                       // 第 2 步 g：提问

5) 「项目的灰度配置统一放在 config/gray.yaml」
→ {"remember":true,"category":"project","text":"本项目的灰度配置统一存放在 config/gray.yaml 文件中。","evidence":"灰度配置统一放在 config/gray.yaml"}

6) 「我觉得可以考虑改成事件驱动，你看呢」
→ {"remember":false}                       // 第 2 步 c：方案讨论

7) 「帮我把这个函数的日志补上 err_code」
→ {"remember":false}                       // 第 2 步 a：一次性执行

8) 「如果要支持离线翻译，端上模型的包体积扛得住吗」
→ {"remember":false}                       // 第 2 步 g：假设和提问

9) 「我说的是登录页的那个弹窗，不是首页的」
→ {"remember":false}                       // 第 2 步 h：对话内澄清

10) 「第二轮训练学习率降到 1e-4 效果更好，后面就用这个」
→ {"remember":false}                       // 第 2 步 d：实验参数和结论

11) 「截图类负例只保留横屏的，竖屏的都算边界」
→ {"remember":false}                       // 第 2 步 d：数据集的标注口径

11b) 「OCR 模型宁可少识别几个字，也不能把印章认成文字，你在中间找个平衡」
→ {"remember":false}                       // 第 2 步 d：某个模型的优化取舍，不是通用工作规范

12) 「工单 10086 的复现步骤是先切后台再回来，预期是不重新加载」
→ {"remember":false}                       // 第 2 步 e：单个工单的细节

13) 「这个目录放的是支付 SDK 的 demo，帮我在里面加个单测」
→ {"remember":false}                       // 第 2 步 f：为当前任务交代的背景

14) 「接口限流到月底，这几天先别跑全量回归」
→ {"remember":false}                       // 第 2 步 i：有时效的安排

15) 「搜索中台的接入文档在 https://wiki.example.com/p/123，以后用到时直接给我」
→ {"remember":true,"category":"project","text":"搜索中台的接入文档地址为 https://wiki.example.com/p/123。","evidence":"搜索中台的接入文档在 https://wiki.example.com/p/123"}

16) 「记一下：压测脚本的并发数先定成 200」
→ {"remember":true,"category":"project","text":"压测脚本的并发数定为 200。","evidence":"记一下：压测脚本的并发数先定成 200"}
   // 第 1 步：显式存储指令，即使内容是实验参数也记

17) 「以后写 Python 脚本都加类型注解」
→ {"remember":true,"category":"rule","text":"编写 Python 脚本时一律添加类型注解。","evidence":"以后写 Python 脚本都加类型注解"}

18) 「以后回答技术问题时都附上参考链接」
→ {"remember":true,"category":"rule","text":"回答技术问题时一律附上参考链接。","evidence":"以后回答技术问题时都附上参考链接"}
`

const DEDUP_SYSTEM = `你是「长期记忆判重器」。执行新记忆与库中余弦相似度最高的 3 条已有记忆之间的判重。

========== 输入 ==========
new：一条待写入的新陈述。
candidates：与 new 余弦相似度最高的 3 条已有记忆，每条含 id 和正文。
你只依据这些文本判断，不得脑补对话上下文、不得引入外部知识、不得推测未写明的意图。
相似度排序仅代表检索顺序，不代表语义等价，是否同一件事必须由下列规则独立判定。

========== 输出 ==========
仅一个 JSON 对象，无解释、无 Markdown、无代码块。四选一：

{"action":"create"}
{"action":"reinforce","id":"<命中记忆的 id>"}
{"action":"merge","id":"<要改写的记忆 id>","text":"<合并后的自包含中文正文>"}
{"action":"replace","id":"<被 new 取代的记忆 id>"}

========== 判别流程（严格按序） ==========

【第 1 步 · 逐条比对，找出是否存在「同一件事」的候选】
对 3 条候选只比对对象：说的是同一个主体吗（同一个人 / 项目 / 模块 / 文件 / 开关 / 规则域）。
结论指向同一条规则或同一件事实，才算同一个对象。
平台、语言、环境、时机不同，不在这一步判成新建。它们是适用范围，留给第 2 步。
  - 3 条对象都不同 → 【create】，流程结束。
  - 有多条对象相同 → 取规则域最吻合的那一条；仍并列时取相似度最高的一条。

【第 2 步 · 对命中的那一条，判断信息差】
逐项检查 new 相对该候选是否带来以下任一变化：
  a. 新事实：出现候选中没有的具体值（标识符、路径、链接、数值、新增步骤、新增例外）。
  b. 冲突：同一维度取值相反或不一致（做 A vs 不做 A、值 X vs 值 Y、允许 vs 禁止）。
     措辞不同也可能冲突：按 new 做事必然违反候选（或反之），就是冲突，例如「必须自己执行 X」vs「未经许可不得执行 X」。
  c. 范围扩大，或明确把旧范围收窄：new 覆盖的平台、语言、环境比候选更宽；或 new 明确要求这条规则以后只在更小的范围生效。

  - 无 a/b/c，只是换措辞、同义改写、详略不同 → 【reinforce】，回传该 id，正文不动。
  - new 是候选已经覆盖的子集，且没有新约束 → 【reinforce】，回传该 id，正文不动。不要把更宽的旧规则改窄。
  - 命中 b → 【replace】，回传该 id，不写正文，插件直接用 new 覆盖。b 优先于 a/c。
  - 只命中 a 或 c → 【merge】，回传该 id 并给出合并正文。

【第 3 步 · 兜底】
无法确认是不是同一个对象，或信息不足以判断 → 【create】。
宁可多建一条，不可错误合并或错误强化。
范围扩大，或明确把旧范围收窄，按第 2 步 c 合并。new 只是旧规则的子集时按强化，不要改窄旧规则。

========== merge 正文撰写规范 ==========
1. 中文陈述句，**自包含**：脱离当前对话与原记忆独立阅读也能完全理解。
2. 禁止指代词：不得出现「这个」「那份文档」「上面说的」「原来的规则」「如前所述」。
3. 禁止记录演进过程：不写「原先是 A 现改为 B」「之前的说法作废」，只写**当前生效的结论**。
4. merge 不处理冲突；合并正文里不得同时出现相互矛盾的两个约束，出现即说明应走 replace。
5. 新事实合并：把两边互不矛盾的具体值写进同一句，必要时用分号连接，整体不超过两个分句。
6. 范围扩大或明确收窄：直接写合并后的完整适用范围，不要枚举差异。子集且没有新约束时不要走合并。
7. 只写事实与约束，不写理由、不写建议、不加修饰。

========== 示例 ==========
1) new:「回答我的时候请使用中文」
   candidates: [{"id":"m1","text":"以后一律使用中文回答用户的问题"}, {"id":"m2","text":"代码注释使用中文"}, {"id":"m3","text":"提交信息用英文"}]
→ {"action":"reinforce","id":"m1"}
   // 对象一致，纯换措辞，无信息差

2) new:「写 Android 代码时函数要加一句注释」
   candidates: [{"id":"m4","text":"写 iOS 代码时新增函数要加一句注释"}, ...]
→ {"action":"merge","id":"m4","text":"在 iOS 和 Android 开发中，新写或修改的函数都要加一句简短注释。"}
   // 同一规则域，适用范围扩大（第 2 步 c）

3) new:「线上配置放在 config/prod.yaml」
   candidates: [{"id":"m5","text":"灰度配置统一存放在 config/gray.yaml"}, ...]
→ {"action":"merge","id":"m5","text":"本项目的灰度配置存放在 config/gray.yaml，线上配置存放在 config/prod.yaml。"}
   // 同一对象（配置文件布局），新增具体值（第 2 步 a）

4) new:「设计方案可以直接开始实现，不用先讨论」
   candidates: [{"id":"m6","text":"涉及设计方案时先给出方案讨论，不要直接执行实现"}, ...]
→ {"action":"replace","id":"m6"}
   // 冲突，以 new 为准（第 2 步 b）

4b) new:「改完代码后要自己执行编译验证，编译通过再交付」
   candidates: [{"id":"m11","text":"未经用户明确许可，不要执行项目工程的编译命令，编译验证由用户自行完成"}, ...]
→ {"action":"replace","id":"m11"}
   // 措辞不同但做法互斥，属于冲突；不得合并成「必须自行编译；未经许可不得编译」

5) new:「错误日志必须包含 err_code 字段」
   candidates: [{"id":"m7","text":"错误日志开关默认关闭"}, {"id":"m8","text":"日志文件保留 7 天"}, {"id":"m9","text":"崩溃日志上报到 Bugly"}]
→ {"action":"create"}
   // 话题相邻但对象不同，三条均非同一件事

6) new:「iOS 代码用 4 空格缩进」
   candidates: [{"id":"m10","text":"所有代码统一用 4 空格缩进"}, ...]
→ {"action":"reinforce","id":"m10"}
   // new 是已有规则的子集，没有新约束，不改正文，也不要把「所有代码」收窄成只剩 iOS
`

// 沉淀没有启用的原因，空串表示可以判别。
//   legacy-blocking  旧版本的阻塞模式已移除，配置里还留着 sideJudge=false。旁路会把用户原话发给外部接口，
//                    这类安装不自动改走旁路，重新运行 setup 之后才启动。
//   missing-api      旁路接口的 baseUrl、apiKey、apiModel 没配齐。
export async function sedimentBlocker(settings) {
  if (settings.sideJudge === false) return 'legacy-blocking'
  if (!settings.sideApiBase || !settings.sideApiModel || !(await readSideApiKey())) return 'missing-api'
  return ''
}

// 沉淀没启用时给主模型的说明。不能让它照旧保持沉默：用户会以为说过的话已经被记下。
export function sedimentOffNotice(blocker) {
  const how = blocker === 'legacy-blocking'
    ? `旧版本的阻塞模式已经移除，这台机器的配置还停在阻塞模式。启用方法：运行 node "${path.join(repoRoot, 'tools', 'setup.mjs')}" sidepath 改用旁路判别（会把用户原话发给配置的模型接口），再重启客户端`
    : `还没有配齐旁路判别接口。启用方法：在 ~/.memory-self-evolution/config.json 写入 sideApiBase、sideApiModel，在 ~/.memory-self-evolution/side-secret.json 写入 apiKey，或在 ${repoRoot} 里重新运行 npm run setup`
  return [
    `memory-self-evolution 的记忆沉淀未启用：${how}。`,
    '已有记忆照常注入和召回，但用户新说的偏好、规范和事实不会被记下。',
    '用户陈述这类内容或要求记住时，照做，并用一句话告诉用户它不会被记下，以及上面的启用方法；',
    `急用可以运行 node "${memoryBin}" rule add "<规则>" 直接添加一条规则。`,
    '不要自行发起记忆确认弹窗，也不要主动调用 memory_resolve。',
  ].join('')
}

export function isUserNotice(text) {
  return String(text || '').trim().startsWith(USER_NOTICE_HEADER)
}

// 插件自己发出的续轮和通知不判别；宿主送回来的、不是用户自己说的话也不判别。
export function shouldJudgePrompt(text, agent = '', payload = {}) {
  const t = String(text || '').trim()
  if (t.length < 6) return false
  if (t.includes(CONFIRM_MARK) || isUserNotice(t)) return false
  return hostOf(agent).isUserInput(payload || {}, t)
}

function promptHashOf(text) {
  const normalized = String(text || '').trim().replace(/\r\n?/g, '\n')
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

export function sessionIDFor(localSecret, agent, payload, promptText) {
  const host = hostOf(agent)
  const material = [
    String(agent || ''),
    host.sessionKey(payload || {}),
    host.turnKey(payload || {}),
    promptHashOf(promptText),
    SESSION_ID_VERSION,
  ].join('\0')
  return `s_${createHmac('sha256', String(localSecret || '')).update(material, 'utf8').digest('hex')}`
}

// 只认 JSON。模型没按格式输出时返回 null，调用方按「不是记忆」处理。
// 以前会把不含 JSON 的单行文本直接当成记忆正文，结果「这句话是临时提问，不需要写入长期记忆。」
// 这类拒绝理由也被存成了记忆。漏记可以靠用户再说一遍补回来，错记不行。
// category 是模型判断的分组，没给或不合法时为空串，由调用方退回字面信号。
export function parseRemember(raw) {
  const obj = extractJson(raw)
  if (!obj || !(typeof obj.remember === 'boolean' || obj.remember === 'true' || obj.remember === 'false')) return null
  const remember = obj.remember === true || obj.remember === 'true'
  if (!remember) return { remember: false }
  const text = String(obj.text || '').trim()
  if (!text) return null
  const category = String(obj.category || '').trim().toLowerCase()
  return {
    remember: true,
    text,
    evidence: String(obj.evidence || '').trim(),
    category: GROUPS.includes(category) ? category : '',
  }
}

export function parseDedup(raw, allowedIds) {
  const obj = extractJson(raw)
  if (!obj || typeof obj.action !== 'string') return null
  const allowed = new Set((allowedIds || []).map((id) => String(id)))
  if (obj.action === 'create') return { action: 'create' }
  const id = String(obj.id || '').trim()
  if (obj.action === 'reinforce') {
    if (!allowed.has(id)) return null
    return { action: 'reinforce', id }
  }
  if (obj.action === 'replace') {
    if (!allowed.has(id)) return null
    return { action: 'replace', id }
  }
  if (obj.action === 'merge') {
    const text = String(obj.text || '').trim()
    if (!allowed.has(id) || !text) return null
    return { action: 'merge', id, text }
  }
  return null
}

export function buildStopResponse(agent, userText, modelText) {
  if (!userText) return null
  return hostOf(agent).stopResponse(userText, modelText)
}

export function collectPending(jobs, agent = '', sessionKey = '') {
  return jobs
    .filter((job) => job
      && (!agent || job.agent === agent)
      && (!sessionKey || job.sessionKey === sessionKey)
      && job.status === 'ready'
      && !job.prompted
      && job.proposal
      && job.proposal.text)
    .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')))
}

// 写入层给的是本次实际加分。同一条记忆每天只加一次且有上限，所以可能是 0。
function gainText(gained) {
  const value = Number(gained)
  if (!Number.isFinite(value)) return '置信度已更新'
  return value > 0 ? `置信度 +${fmtConfidence(value)}` : '置信度不变（今天已加过分或已到上限）'
}

// 在通知末尾标出记忆所在的分组，用户能一眼看出有没有分错。分组未知时不加。
function withGroup(sentence, category) {
  const name = GROUP_NAMES[category]
  if (!name) return sentence
  return `${sentence}${sentence.endsWith('。') ? '' : '。'}归类：${category}（${name}）。`
}

export function formatNotice(proposal) {
  if (proposal.action === 'reinforce') {
    return withGroup(`强化了一条记忆：${proposal.targetText || proposal.text}，${gainText(proposal.gained)}`, proposal.category)
  }
  if (proposal.action === 'merge') {
    return withGroup(`合并了一条记忆：旧记忆「${proposal.targetText}」，新记忆「${proposal.mergedText}」，${gainText(proposal.gained)}`, proposal.category)
  }
  if (proposal.action === 'replace') return formatDirectNotice(proposal)
  return withGroup(`生成了一条记忆：${proposal.text}`, proposal.category)
}

// 让主模型把已经写入的结果原样交给用户，不再提问。
// strict 用在免确认模式：那一轮除了转述结果什么都不该做，措辞更严。
export function buildNoticeFollowup(notices, { strict = false } = {}) {
  const lines = (Array.isArray(notices) ? notices : [notices]).filter(Boolean)
  return [
    CONFIRM_MARK,
    '插件已直接写入记忆。不要调用任何工具，不要向用户提问，不要复述本段说明。',
    strict
      ? '只把「结果」下面的文字原样输出给用户，不要增删改，不要做其他任何操作。'
      : '只把「结果」下面的文字原样展示给用户。',
    '',
    '结果',
    ...lines,
  ].join('\n')
}

// 免确认已经落盘。Stop 只让主模型原样输出这一句，不弹确认。
export function formatDirectNotice(proposal) {
  const action = proposal?.action
  const verb = action === 'reinforce' ? '强化' : action === 'merge' ? '合并' : action === 'replace' ? '替换' : '新增'
  const text = action === 'merge'
    ? (proposal.mergedText || proposal.text)
    : action === 'reinforce'
      ? (proposal.targetText || proposal.text)
      : proposal?.text
  const body = String(text || '').replace(/\s+/g, ' ').trim()
  if (action === 'replace') {
    const old = String(proposal.targetText || '').replace(/\s+/g, ' ').trim()
    return withGroup(`记忆插件memory-self-evolution替换了一条记忆：新记忆："${body}"。旧记忆："${old}"。`, proposal.category)
  }
  return withGroup(`记忆插件memory-self-evolution${verb}了一条记忆："${body}"。`, proposal.category)
}

export function buildUserNotice(notices) {
  const lines = (Array.isArray(notices) ? notices : [notices]).filter(Boolean)
  return [USER_NOTICE_HEADER, '结果：', ...lines].join('\n')
}

// 用户气泡是友好文案。下一轮 prompt 把原文还原成模型看到的 MEMORY_CONFIRM_V1。
export function modelNoticeForUserText(prompt) {
  const text = String(prompt || '').trim()
  if (!isUserNotice(text)) return ''
  const parts = text.split('\n')
  const idx = parts.findIndex((line) => line.trim() === '结果：')
  if (idx < 0) return ''
  const resultLines = parts.slice(idx + 1).map((line) => line.trim()).filter(Boolean)
  if (resultLines.length === 0) return ''
  const direct = resultLines.some((line) => line.startsWith('记忆插件memory-self-evolution'))
  return buildNoticeFollowup(resultLines, { strict: direct })
}

export async function hiddenNoticeForPrompt(agent, prompt, payload = {}) {
  const text = String(prompt || '').trim()
  if (!isUserNotice(text)) return ''
  const file = paths.sideConfirm(agent, hostOf(agent).sessionKey(payload))
  try {
    const saved = JSON.parse(await fsp.readFile(file, 'utf8'))
    if (saved && String(saved.userText || '').trim() === text && saved.modelText) {
      await fsp.unlink(file).catch((error) => {
        console.error(`[memory] 删除弹窗确认原文失败: ${error.message}`)
      })
      return String(saved.modelText)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[memory] 读取弹窗确认原文失败: ${error.message}`)
  }
  return modelNoticeForUserText(text)
}

async function saveConfirmPair(agent, sessionKey, userText, modelText) {
  const file = paths.sideConfirm(agent, sessionKey)
  await fsp.mkdir(paths.sideDir, { recursive: true })
  const tmp = `${file}.tmp.${process.pid}`
  await fsp.writeFile(tmp, JSON.stringify({ userText, modelText }), 'utf8')
  await fsp.rename(tmp, file)
}

function memoryLabel(text, id) {
  const body = String(text || '').replace(/\s+/g, ' ').trim()
  if (body) return `「${body}」`
  return id ? `（${id}）` : ''
}

function quoted(body) {
  const text = String(body || '').trim()
  const end = /[。！？]$/.test(text) ? '' : '。'
  return `「${text}」${end}`
}

function confirmVisibleLine(proposal) {
  const text = String(proposal.text || '').trim()
  if (proposal.action === 'merge' && proposal.mergedText) {
    return `建议合并。新记忆${quoted(text)}并入已有记忆${memoryLabel(proposal.targetText, proposal.targetId)}。合并后${quoted(proposal.mergedText)}`
  }
  if (proposal.action === 'replace' && (proposal.targetText || proposal.targetId)) {
    return `建议替换。新记忆${quoted(text)}与已有记忆${memoryLabel(proposal.targetText, proposal.targetId)}冲突，替换后只保留新记忆。`
  }
  if ((proposal.action === 'reinforce' || proposal.action === 'unsure') && (proposal.targetText || proposal.targetId)) {
    return `建议强化已有记忆${memoryLabel(proposal.targetText, proposal.targetId)}。新说法${quoted(text)}`
  }
  return `建议新增记忆${quoted(text)}`
}

export function buildFollowup(agent, jobs) {
  const list = (Array.isArray(jobs) ? jobs : [jobs]).filter((job) => (job?.proposal || job)?.text)
  const host = hostOf(agent)
  const lines = [
    CONFIRM_MARK,
    `本轮回答已经结束。待确认记忆有 ${list.length} 条，现在只做一件事：把每一条都问一遍。`,
    `调用 ${host.askTool}，一次提问里每一条一道题。若这次调用只能放一道题，就按顺序连续调用，直到每一条都问过。`,
    '不要改用文字列草稿提问。',
    host.writeRule,
    `弹窗标题写「${CONFIRM_TITLE}」。选项的 id 与选项文案用同一段文字，选项文案一字不改。`,
    '用户点选返回后，每条都调用一次 memory_resolve，sessionID 使用该条给出的值。',
    'decision 映射：标签为 rule 的落成或仍新建选 create_rule；标签为 project 的选 create_project；强化选 reinforce；合并选 merge；替换选 replace；不落成选 discard。',
    '若提问工具返回 Skipped，或用户关闭、取消确认弹窗，不要调用 memory_resolve；未处理任务由每日僵尸清理兜底。',
    '',
  ]
  list.forEach((job, index) => {
    lines.push(...itemLines(job, index + 1))
    lines.push('')
  })
  return lines.filter((line) => line !== undefined && line !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function itemLines(job, index) {
  const proposal = job.proposal || job
  const alt = proposal.category === 'rule' ? 'project' : 'rule'
  return [
    `第 ${index} 条`,
    `sessionID：${job.id}`,
    `正文：${proposal.text}`,
    `推荐标签：${proposal.category}`,
    proposal.evidence ? `佐证：${proposal.evidence}` : '',
    proposal.score != null ? `与最相近记忆的相似度：${Number(proposal.score).toFixed(2)}` : '',
    proposal.targetText ? `最相近记忆：${proposal.targetText}` : '',
    proposal.mergedText ? `合并后正文：${proposal.mergedText}` : '',
    '题面：检测到一条记忆。是否落成记忆。',
    '选项：',
    ...followupOptions(proposal, alt),
  ].filter(Boolean)
}

function followupOptions(proposal, alt) {
  const body = memoryLabel(proposal.text)
  const createA = `落成，使用推荐标签 ${proposal.category}${body}`
  const createB = `落成，把标签改为 ${alt}${body}`
  const skip = '不落成'
  if (proposal.action === 'merge' && proposal.mergedText && (proposal.targetText || proposal.targetId)) {
    return [`合并进已有记忆 ${memoryLabel(proposal.targetText, proposal.targetId)}`, createA, createB, skip]
  }
  if (proposal.action === 'replace' && (proposal.targetText || proposal.targetId)) {
    return [`替换已有记忆 ${memoryLabel(proposal.targetText, proposal.targetId)}`, createA, createB, skip]
  }
  if (proposal.action === 'reinforce' && (proposal.targetText || proposal.targetId)) {
    return [`强化已有记忆 ${memoryLabel(proposal.targetText, proposal.targetId)}`, `仍新建，使用推荐标签 ${proposal.category}${body}`, `仍新建，把标签改为 ${alt}${body}`, skip]
  }
  if (proposal.action === 'unsure' && (proposal.targetText || proposal.targetId)) {
    return [`强化已有记忆 ${memoryLabel(proposal.targetText, proposal.targetId)}`, createA, createB, skip]
  }
  return [createA, createB, skip]
}

export async function maybeStartSideJob({ agent, payload, promptText }) {
  const settings = await loadSettings()
  if (!settings.enabled) return
  if (await sedimentBlocker(settings)) return
  const host = hostOf(agent)
  if (!shouldJudgePrompt(promptText, agent, payload)) return
  // 发给外部模型之前先在本地处理：去掉代码和粘贴块，抹掉形如密钥的字符串，剩下的还很长就不送判。
  const input = prepareJudgeInput(promptText)
  if (input.skip) {
    if (input.skip === 'too-long') console.error(`[memory] 旁路判别跳过：去掉代码与粘贴块后仍有 ${Array.from(input.text).length} 个字，按粘贴内容处理`)
    return
  }
  const sessionKey = host.sessionKey(payload)
  if (!sessionKey) {
    console.error(`[memory] 旁路分析缺少稳定会话 ID，已跳过 agent=${agent || 'unknown'}`)
    return
  }
  const localSecret = await readOrCreateSessionSecret()
  const id = sessionIDFor(localSecret, agent, payload, promptText)
  const file = paths.sideJob(id)
  const job = {
    version: 1,
    id,
    status: 'running',
    agent,
    sessionKey,
    generationKey: host.turnKey(payload),
    prompt: input.text,
    startedAt: new Date().toISOString(),
    prompted: false,
    proposal: null,
    reason: '',
  }
  try {
    await writeJsonExclusive(file, job)
  } catch (error) {
    if (error.code === 'EEXIST') return id
    console.error(`[memory] 创建旁路分析会话失败 sessionID=${id}: ${error.message}`)
    throw error
  }
  const child = spawn(process.execPath, [memoryBin, 'side-run', file], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MEMORY_SIDE_JUDGE: '1' },
  })
  child.unref()
  return id
}

export async function runSideJob(file) {
  const job = await readJson(file)
  if (!job || job.status !== 'running') return
  try {
    const settings = await loadSettings()
    const verdict = await askRemember(job.prompt, settings)
    if (!verdict) {
      await finish(file, { status: 'none', reason: 'judge-failed' })
      return
    }
    if (!verdict.remember) {
      await finish(file, { status: 'none', reason: 'not-memory' })
      return
    }
    const problem = memoryTextProblem(verdict.text)
    if (problem) {
      console.error(`[memory] 旁路判别给出的正文不合要求，不写入: ${problem}`)
      await finish(file, { status: 'none', reason: 'text-rejected' })
      return
    }
    const proposal = await buildProposal(job.agent, verdict, job.prompt, settings)
    if (!settings.confirm) {
      try {
        const applied = await applyProposal(proposal)
        await finish(file, { status: 'ready', proposal: applied.proposal, applied: true, notice: applied.notice, reason: '' })
      } catch (e) {
        console.error(`[memory] 免确认写入失败 text=${proposal.text}: ${e.message}`)
        await finish(file, { status: 'none', reason: e.message || 'write-failed' })
      }
      return
    }
    await finish(file, { status: 'ready', proposal, reason: '' })
  } catch (e) {
    console.error(`[memory] 旁路判断失败: ${e.message}`)
    await finish(file, { status: 'none', reason: e.message || 'error' })
  }
}

export async function takeSideFollowup(agent, payload, waitMs) {
  const host = hostOf(agent)
  const sessionKey = host.sessionKey(payload || {})
  if (!sessionKey) {
    console.error(`[memory] Stop 缺少稳定会话 ID，已跳过旁路结果 agent=${agent || 'unknown'}`)
    return null
  }
  await settleRunning(waitMs, agent, sessionKey)
  const settings = await loadSettings()
  const pending = collectPending(
    await listJobs({ includeUnpromptedApplied: !settings.confirm }),
    agent,
    sessionKey,
  )
  if (pending.length === 0) return null
  if (!settings.confirm) {
    const notices = []
    for (const job of pending) {
      if (!job.applied) {
        try {
          const applied = await applyProposal(job.proposal)
          job.proposal = applied.proposal
          job.applied = true
        } catch (e) {
          console.error(`[memory] 免确认写入失败 id=${job.id} text=${job.proposal?.text}: ${e.message}`)
          continue
        }
      }
      const notice = formatDirectNotice(job.proposal)
      notices.push(notice)
      await finish(job.file, { prompted: true, applied: true, notice, proposal: job.proposal }, { force: true })
    }
    if (notices.length === 0) return null
    const userText = buildUserNotice(notices)
    const modelText = buildNoticeFollowup(notices, { strict: true })
    if (host.followupReturnsAsPrompt) {
      try {
        await saveConfirmPair(agent, sessionKey, userText, modelText)
      } catch (error) {
        console.error(`[memory] 保存免确认结果原文失败，模型可能看不到输出说明: ${error.message}`)
      }
    }
    return buildStopResponse(agent, userText, modelText)
  }
  // 新一次弹窗会作废同一客户端之前问过但没点选的提案，避免后续写工具误消费旧提案。
  for (const stale of await pendingConfirmJobs({ agent, sessionKey })) {
    await finish(stale.file, { status: 'none', reason: 'superseded' }, { force: true })
  }
  const promptedAt = new Date().toISOString()
  for (const job of pending) {
    await finish(job.file, { prompted: true, promptedAt }, { force: true })
  }
  const applied = pending.filter((job) => job.applied && job.notice)
  const waiting = pending.filter((job) => !(job.applied && job.notice))
  const userParts = []
  const modelParts = []
  if (applied.length > 0) {
    const notices = applied.map((job) => job.notice)
    userParts.push(buildUserNotice(notices))
    modelParts.push(buildNoticeFollowup(notices))
  }
  if (waiting.length > 0) {
    userParts.push(buildUserNotice(waiting.map((job) => confirmVisibleLine(job.proposal))))
    modelParts.push(buildFollowup(agent, waiting))
  }
  const userText = userParts.join('\n\n')
  const modelText = modelParts.join('\n\n')
  if (!userText) return null
  // 续轮会作为下一条输入回来的宿主，要把给模型的指令存下来，再由 hiddenNoticeForPrompt 还原。
  if (host.followupReturnsAsPrompt) {
    try {
      await saveConfirmPair(agent, sessionKey, userText, modelText)
    } catch (error) {
      console.error(`[memory] 保存弹窗确认原文失败，模型可能看不到提问说明: ${error.message}`)
    }
  }
  return buildStopResponse(agent, userText, modelText)
}

async function applyProposal(proposal) {
  if (proposal.action === 'reinforce' && proposal.targetId) {
    const mem = await reinforceMemory(proposal.targetId)
    const next = { ...proposal, targetText: mem.text, gained: mem.gained, category: mem.category }
    return { proposal: next, notice: formatNotice(next) }
  }
  if (proposal.action === 'merge' && proposal.targetId && proposal.mergedText) {
    const mem = await mergeMemory(proposal.targetId, proposal.mergedText)
    const next = { ...proposal, mergedText: mem.text, gained: mem.gained, category: mem.category }
    return { proposal: next, notice: formatNotice(next) }
  }
  // 冲突时正文只取 new，不信任提案里任何模型改写的正文，保证旧约束不会残留。
  if (proposal.action === 'replace' && proposal.targetId && proposal.text) {
    const mem = await mergeMemory(proposal.targetId, proposal.text)
    const next = { ...proposal, text: mem.text, category: mem.category }
    return { proposal: next, notice: formatNotice(next) }
  }
  if (proposal.action === 'unsure') {
    console.error(`[memory] 判重结果不确定，免确认模式下按新增写入: ${proposal.text}`)
  }
  const mem = await persistMemory({
    text: proposal.text,
    category: proposal.category,
    evidence: proposal.evidence,
  })
  const next = { ...proposal, action: 'create', text: mem.text, category: mem.category }
  return { proposal: next, notice: formatNotice(next) }
}

async function buildProposal(agent, verdict, prompt, settings) {
  // 分组以判别模型的判断为主，字面信号只做交叉校验；模型没给出有效分组时才退回字面信号。
  // 两者不一致时仍采用模型的：确认模式下弹窗里两个标签都能选，免确认模式靠这条日志事后排查。
  const inferred = inferGroup(verdict.text)
  const category = verdict.category || inferred.group
  if (verdict.category && inferred.confident && inferred.group !== verdict.category) {
    console.error(`[memory] 分组判断不一致，采用判别模型的 ${verdict.category}（字面信号指向 ${inferred.group}）: ${verdict.text}`)
  }
  const candidates = await topCandidates(verdict.text)
  const similar = candidates[0] || null
  let action = 'create'
  let target = null
  let mergedText = ''
  if (similar) {
    const decided = await askDedup(verdict.text, candidates, settings)
    if (!decided) {
      action = 'unsure'
      target = similar
    } else if (decided.action === 'create') {
      action = 'create'
    } else {
      target = candidates.find((c) => c.memory.id === decided.id) || null
      if (!target) {
        action = 'unsure'
        target = similar
      } else {
        action = decided.action
        if (action === 'merge') {
          // 合并正文长度不合要求时不采用，退回成拿不准，让用户在强化和新建之间选。
          const problem = memoryTextProblem(decided.text)
          if (problem) {
            console.error(`[memory] 判重给出的合并正文不合要求，改按拿不准处理: ${problem}`)
            action = 'unsure'
          } else {
            mergedText = decided.text
          }
        }
      }
    }
  }
  return {
    text: verdict.text,
    evidence: verdict.evidence || String(prompt).slice(0, 200),
    category,
    action,
    targetId: target ? target.memory.id : '',
    targetText: target ? target.memory.text : '',
    mergedText,
    score: target ? target.score : (similar ? similar.score : null),
  }
}

async function topCandidates(text) {
  const all = await readAllMemories()
  if (all.length === 0) return []
  return recall([text], all, { topK: 3, gate: false })
}

export async function askRemember(prompt, settings) {
  const raw = await callHostModel(settings, REMEMBER_SYSTEM, prompt)
  if (!raw) return null
  const parsed = parseRemember(raw)
  if (!parsed) console.error(`[memory] 旁路判断无法解析: ${String(raw).replace(/\s+/g, ' ').slice(0, 300)}`)
  return parsed
}

async function askDedup(text, candidates, settings) {
  const payload = candidates.map((c) => ({ id: c.memory.id, text: c.memory.text }))
  const user = [
    `new：${text}`,
    `candidates：${JSON.stringify(payload)}`,
    'candidates 已按余弦相似度从高到低排列。',
  ].join('\n')
  const raw = await callHostModel(settings, DEDUP_SYSTEM, user)
  if (!raw) return null
  const parsed = parseDedup(raw, payload.map((item) => item.id))
  if (!parsed) console.error(`[memory] 旁路判重无法解析: ${String(raw).replace(/\s+/g, ' ').slice(0, 300)}`)
  return parsed
}

async function callHostModel(settings, systemPrompt, userPrompt) {
  const apiKey = await readSideApiKey()
  if (!apiKey || !settings.sideApiBase || !settings.sideApiModel) {
    throw new Error('旁路缺少 baseUrl、apiKey 或 apiModel，本轮跳过。写入 ~/.memory-self-evolution/config.json 的 sideApiBase、sideApiModel，以及 side-secret.json 的 apiKey')
  }
  return callApi(settings, apiKey, systemPrompt, userPrompt)
}

// 接口拒绝过 JSON 模式后，同一进程内不再带这个参数，免得判重那次调用再白试一回。
let jsonModeRejected = false
// 不认 response_format 的接口通常以这几个状态码拒绝请求。鉴权和限流的错误不在其中，重试没有意义。
const UNSUPPORTED_PARAM_STATUS = new Set([400, 404, 415, 422])

async function callApi(settings, apiKey, systemPrompt, userPrompt) {
  const base = String(settings.sideApiBase || '').replace(/\/$/, '')
  const url = base.endsWith('/chat/completions') ? base : `${base}/chat/completions`
  // 两段提示词都要求只输出一个 JSON 对象。支持 JSON 模式的接口会保证这一点，不认这个参数的接口去掉它重试一次。
  const send = async (jsonMode) => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: settings.sideApiModel,
          stream: true,
          ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS),
      })
    } catch (e) {
      throw new Error(`旁路接口请求失败: ${e.message}`)
    }
  }
  let res = await send(!jsonModeRejected)
  let raw = await res.text()
  if (!res.ok && !jsonModeRejected && UNSUPPORTED_PARAM_STATUS.has(res.status)) {
    console.error(`[memory] 旁路接口返回 ${res.status}，可能不支持 response_format，去掉后重试: ${raw.replaceAll(apiKey, '').replace(/\s+/g, ' ').slice(0, 200)}`)
    jsonModeRejected = true
    res = await send(false)
    raw = await res.text()
  }
  if (!res.ok) throw new Error(`旁路接口 ${res.status}: ${raw.replaceAll(apiKey, '').slice(0, 200)}`)
  const text = parseCompletion(raw)
  if (!text) throw new Error('旁路接口没有正文')
  return text
}

function parseCompletion(raw) {
  const body = String(raw || '').trim()
  if (body.startsWith('{')) {
    const obj = tryParse(body)
    const content = obj?.choices?.[0]?.message?.content
    if (typeof content === 'string' && content.trim()) return content.trim()
  }
  let out = ''
  for (const line of body.split('\n')) {
    const row = line.trim()
    if (!row.startsWith('data:')) continue
    const payload = row.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    const delta = tryParse(payload)?.choices?.[0]?.delta?.content
    if (typeof delta === 'string') out += delta
  }
  return out.trim()
}

async function readSideApiKey() {
  try {
    const parsed = JSON.parse(await fsp.readFile(paths.sideSecret, 'utf-8'))
    return String(parsed.apiKey || '').trim()
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[memory] 读取旁路密钥失败: ${e.message}`)
    return ''
  }
}

async function readOrCreateSessionSecret() {
  try {
    const value = String(await fsp.readFile(paths.sessionSecret, 'utf8')).trim()
    if (/^[a-f0-9]{64}$/.test(value)) return value
    throw new Error(`本地密钥格式无效 path=${paths.sessionSecret}`)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`[memory] 读取 sessionID 本地密钥失败 path=${paths.sessionSecret}: ${error.message}`)
      throw error
    }
  }
  await fsp.mkdir(path.dirname(paths.sessionSecret), { recursive: true })
  const candidate = randomBytes(32).toString('hex')
  try {
    await fsp.writeFile(paths.sessionSecret, `${candidate}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return candidate
  } catch (error) {
    if (error.code !== 'EEXIST') {
      console.error(`[memory] 创建 sessionID 本地密钥失败 path=${paths.sessionSecret}: ${error.message}`)
      throw error
    }
    const value = String(await fsp.readFile(paths.sessionSecret, 'utf8')).trim()
    if (/^[a-f0-9]{64}$/.test(value)) return value
    const invalid = new Error(`并发创建后的本地密钥格式无效 path=${paths.sessionSecret}`)
    console.error(`[memory] ${invalid.message}`)
    throw invalid
  }
}

// 只按任务状态判断，不看配置。MCP 进程里的配置是启动时读的，可能已经过期；
// 弹过窗、还没写入的任务只会在确认模式下产生，有这样的任务就说明用户确实被问过。
async function pendingConfirmJobs({ agent = '', sessionKey = '' } = {}) {
  return (await listJobs())
    .filter((job) => (!agent || job.agent === agent)
      && (!sessionKey || job.sessionKey === sessionKey)
      && job.prompted
      && !job.applied
      && job.status === 'ready'
      && job.proposal)
    .sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')))
}

const RESOLVE_DECISIONS = new Set(['create_rule', 'create_project', 'reinforce', 'merge', 'replace', 'discard'])

function allowedDecisions(proposal) {
  const allowed = new Set(['create_rule', 'create_project', 'discard'])
  if ((proposal.action === 'reinforce' || proposal.action === 'unsure') && proposal.targetId) allowed.add('reinforce')
  if (proposal.action === 'merge' && proposal.targetId && proposal.mergedText) allowed.add('merge')
  if (proposal.action === 'replace' && proposal.targetId) allowed.add('replace')
  return allowed
}

// 根据插件颁发的 sessionID 消费唯一待确认提案，调用参数不能覆盖提案正文或目标记忆。
export async function resolvePendingSession(sessionID, decision, agent) {
  const id = String(sessionID || '').trim()
  const selected = String(decision || '').trim()
  if (!id || !RESOLVE_DECISIONS.has(selected)) {
    return { ok: false, message: 'sessionID 或 decision 无效，已拒绝处理。' }
  }
  const job = (await pendingConfirmJobs()).find((item) => item.id === id && (!agent || item.agent === agent))
  if (!job) return { ok: false, message: '未找到可处理的记忆分析会话，可能已处理、过期或不属于当前客户端。' }
  if (!allowedDecisions(job.proposal).has(selected)) {
    return { ok: false, message: 'decision 与本次记忆分析提供的选项不匹配，已拒绝处理。' }
  }
  if (selected === 'discard') {
    await finish(job.file, { status: 'none', applied: false, reason: 'user-skip' }, { force: true })
    return { ok: true, message: '本次记忆已不落成。' }
  }
  const create = selected === 'create_rule' || selected === 'create_project'
  const proposal = {
    ...job.proposal,
    action: create ? 'create' : selected,
    category: create ? selected.slice('create_'.length) : job.proposal.category,
  }
  const applied = await applyProposal(proposal)
  await finish(job.file, { status: 'none', applied: true, notice: applied.notice }, { force: true })
  return { ok: true, message: applied.notice }
}

async function listJobs({ includeUnpromptedApplied = false } = {}) {
  let names = []
  try {
    names = await fsp.readdir(paths.sideDir)
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[memory] 读取待确认池失败: ${e.message}`)
    return []
  }
  const jobs = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.startsWith('confirm-')) continue
    const file = path.join(paths.sideDir, name)
    const job = await readJson(file)
    if (!job || !job.id || !job.status) continue
    // 免确认写入会先把 applied 设为 true，但 Stop 还没把结果交给模型。这种任务仍要返回。
    // 弹过窗但还没写入的提案留着，等主模型用 sessionID 调用 memory_resolve；新弹窗会作废旧提案。
    const awaitingDirectNotice = includeUnpromptedApplied && job.applied && !job.prompted && job.status === 'ready'
    if (!awaitingDirectNotice && (job.status === 'none' || job.applied)) {
      const terminalAt = Date.parse(job.finishedAt || job.startedAt || '')
      if (Number.isFinite(terminalAt) && Date.now() - terminalAt > SESSION_RETENTION_MS) {
        await fsp.rm(file, { force: true }).catch((error) => {
          console.error(`[memory] 清理过期旁路分析会话失败 sessionID=${job.id}: ${error.message}`)
        })
      }
      continue
    }
    jobs.push({ ...job, file })
  }
  return jobs
}

// 用户删除、合并或改写了一条记忆后，指向它的待确认提案（强化、合并、替换）都已经不成立，一并作废。
// 返回作废的条数。
export async function retireProposalsFor(ids, reason = 'target-changed') {
  const targets = new Set(ids.map(String))
  let retired = 0
  for (const job of await listJobs()) {
    if (job.status !== 'ready' || job.applied || !job.proposal || !targets.has(String(job.proposal.targetId || ''))) continue
    await finish(job.file, { status: 'none', reason }, { force: true })
    retired++
  }
  return retired
}

// 每日遗忘扫描的旁路兜底：只清理前一天及更早、已经弹窗但始终没有 resolve 的任务。
export async function cleanupZombieSideJobs(now = new Date()) {
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  let cleaned = 0
  let unasked = 0
  for (const job of await listJobs()) {
    if (job.status !== 'ready' || job.applied) continue
    if (!job.prompted) {
      // 判别完成时所在会话已经没有下一次 Stop，提案一直没弹出。不清理，那个会话再回答一次时仍会弹出，这里只计数。
      const readyAt = Date.parse(job.finishedAt || job.startedAt || '')
      if (Number.isFinite(readyAt) && readyAt < todayStart.getTime()) unasked++
      continue
    }
    const promptedAt = Date.parse(job.promptedAt || job.finishedAt || job.startedAt || '')
    if (!Number.isFinite(promptedAt)) {
      console.error(`[memory] 僵尸任务缺少有效时间，已跳过 sessionID=${job.id}`)
      continue
    }
    if (promptedAt >= todayStart.getTime()) continue
    await finish(job.file, { status: 'none', applied: false, reason: 'daily-zombie-cleanup' }, { force: true })
    cleaned++
  }
  if (unasked > 0) console.error(`[memory] 有 ${unasked} 条前一天及更早判别完成的记忆提案还没弹出确认，继续保留，所在会话下次回答结束时弹出`)
  return cleaned
}

async function settleRunning(waitMs, agent, sessionKey) {
  const deadline = Date.now() + Math.max(0, waitMs)
  for (;;) {
    const now = Date.now()
    let waiting = false
    for (const job of await listJobs()) {
      if (job.agent !== agent || job.sessionKey !== sessionKey) continue
      if (job.status !== 'running') continue
      const age = now - Date.parse(job.startedAt || '')
      if (Number.isFinite(age) && age > STUCK_AFTER_MS) {
        await finish(job.file, { status: 'none', reason: 'judge-timeout' }, { force: true })
        continue
      }
      waiting = true
    }
    if (!waiting || now >= deadline) return
    await sleep(200)
  }
}

async function finish(file, patch, { force = false } = {}) {
  const cur = await readJson(file)
  if (!cur) return null
  if (!force && (cur.prompted || cur.status === 'none')) return cur
  if (!force && cur.status !== 'running') return cur
  const next = { ...cur, ...patch, finishedAt: patch.finishedAt || new Date().toISOString() }
  await writeJson(file, next)
  return next
}

function extractJson(raw) {
  if (!raw) return null
  let text = String(raw).trim()
  const top = tryParse(text)
  if (top && typeof top === 'object') {
    if (typeof top.remember === 'boolean' || typeof top.action === 'string') return top
    if (top.structured_output && typeof top.structured_output === 'object') return top.structured_output
    if (typeof top.result === 'string') text = top.result
    else if (top.result && typeof top.result === 'object') return top.result
  }
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) text = fence[1]
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  return tryParse(text.slice(start, end + 1))
}

function tryParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8'))
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[memory] 读取旁路任务失败: ${e.message}`)
    return null
  }
}

async function writeJson(file, data) {
  const tmp = `${file}.tmp.${process.pid}`
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf-8')
  await fsp.rename(tmp, file)
}

async function writeJsonExclusive(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const handle = await fsp.open(file, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(data), 'utf8')
  } finally {
    await handle.close()
  }
}
