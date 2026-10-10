#!/usr/bin/env node
// 三端共用的记忆 MCP server（stdio，JSON-RPC 2.0，换行分隔）。
// Cursor、codebuddy 与 WorkBuddy 的 mcp.json 格式一致，同一份配置三端复用。
// 手写协议而不引依赖：这个 server 要被短命/常驻两种方式反复启动，依赖越少启动越快、越不易坏。

import { GROUPS, READ_LIMIT } from '../lib/core/config.mjs'
import { fmtConfidence, readAllGroups, readAllMemories, readGroup } from '../lib/core/store.mjs'
import { recall } from '../lib/core/recall.mjs'
import { inferGroup, mergeMemory, persistMemory, reinforceMemory } from '../lib/core/writer.mjs'
import { dropCandidate, listCandidates } from '../lib/core/candidates.mjs'
import { describeSettings, loadSettings, updateSetting } from '../lib/core/settings.mjs'
import { resolvePendingSession } from '../lib/core/sidepath.mjs'

const PROTOCOL_VERSION = '2024-11-05'

// 由 setup 写进 mcp.json 的 --agent 决定，用于隔离不同客户端的旁路待确认提案。
const agentIdx = process.argv.indexOf('--agent')
const AGENT = agentIdx >= 0 ? String(process.argv[agentIdx + 1] || '') : ''

const TOOLS = [
  {
    name: 'memory_list',
    description: '列出两组记忆的条数。rule 是无条件生效的规则与偏好，project 是按需召回的项目事实。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'memory_read',
    description: `读取某一组的全部记忆，按置信度降序。超过 ${READ_LIMIT} 条时返回前 ${READ_LIMIT} 条并注明总量。每轮的自动召回若没给出你需要的内容，再调用它兜底。`,
    inputSchema: {
      type: 'object',
      properties: { group: { type: 'string', enum: GROUPS, description: 'rule=规则与偏好，project=项目事实' } },
      required: ['group'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_propose',
    description:
      '提交一条值得长期记住的记忆（用户的偏好、规范、项目事实，或对同一件事的第二次纠正）。仅阻塞模式使用，不直接落盘。返回最相近的两条记忆、相似度，以及新建、强化或合并的判重提示。相似度越高越应当强化，而不是新建。确认模式下先按提示选定动作，再用宿主提问工具确认后落盘。一次性任务细节不要提交。正文必须自包含。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '一句清晰、可执行、自包含的中文陈述' },
        evidence: { type: 'string', description: '简短佐证，说明用户在哪句话里表达了它' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_persist',
    description: '把记忆正式写入，初始置信度固定为 0.5。阻塞模式在 memory_propose 之后、且用户已确认时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '记忆正文，中文，须自包含' },
        category: {
          type: 'string',
          enum: GROUPS,
          description: 'rule=无条件遵守的偏好与规范，每轮都会注入；project=需要时才查阅的项目事实，靠相关性召回。拿不准时选 rule：漏判规则会让它静默失效，多判只是多占一点上下文。',
        },
        evidence: { type: 'string' },
      },
      required: ['text', 'category'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_reinforce',
    description: '强化一条已有记忆（置信度 +0.1）。阻塞模式在用户确认强化后调用。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要强化的已有记忆 id' },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_merge',
    description: '用合并后的正文替换一条已有记忆，丢掉旧向量并重新编码，同时做一次强化（置信度 +0.1）。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '要改写的已有记忆 id' },
        text: { type: 'string', description: '合并后的自包含中文正文，写当前生效的结论' },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_resolve',
    description: '处理插件弹窗中的一条待确认记忆。仅旁路模式使用；sessionID 必须照抄插件提供的值，decision 必须与用户点选一致。正文、目标记忆和合并正文均由插件内部提案决定。',
    inputSchema: {
      type: 'object',
      properties: {
        sessionID: { type: 'string', description: '插件为本次记忆分析颁发的 sessionID' },
        decision: {
          type: 'string',
          enum: ['create_rule', 'create_project', 'reinforce', 'merge', 'replace', 'discard'],
          description: '用户最终选择的新建规则、新建项目事实、强化、合并、替换冲突记忆或不落成',
        },
      },
      required: ['sessionID', 'decision'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_review',
    description: '列出从历史会话累积的待确认候选记忆（按出现次数降序）。用户说要处理候选、或会话开始提示有待确认候选时调用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'memory_discard',
    description: '丢弃一条候选记忆。reject 为 true 时在 30 天内不再就同一内容提问。',
    inputSchema: {
      type: 'object',
      properties: {
        fingerprint: { type: 'string', description: 'memory_review 返回的候选指纹' },
        reject: { type: 'boolean', description: '是否同时加入拒绝名单' },
      },
      required: ['fingerprint'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_config',
    description: '查看或修改记忆系统配置。不传参数即查看全部；传 key 与 value 则修改。可调项含 recallTopK（每轮召回条数上限）、recallMinScore（每条召回的绝对下限，与 top1×0.6 取更高者）/ recallMinMargin（领先幅度门控，-1 为关闭）、confirm（写盘前是否弹确认，旁路和阻塞都适用）、decayDays（闲置满多少天扣一次置信度，正整数，默认 30）、enabled、sideApiBase、sideApiModel。sideApiBase 和 sideApiModel 没有缺省值，旁路必填。旁路 API 密钥不在这里，放在 side-secret.json 的 apiKey，同样必填。sideJudge 不能在这里改，切换通路用 node tools/setup.mjs sidepath 或 node tools/setup.mjs blocking。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        value: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
]

const text = (s) => ({ content: [{ type: 'text', text: s }] })

// 旁路只暴露统一确认工具；阻塞模式继续使用原有的提案与写入工具。
const SIDEPATH_HIDDEN = new Set(['memory_propose', 'memory_persist', 'memory_reinforce', 'memory_merge'])
const BLOCKING_HIDDEN = new Set(['memory_resolve'])

function sidepathWriteRefusal() {
  return text('当前是旁路模式，没有 memory_propose。要不要记由后台判断。')
}

const PROPOSE_TOP_K = 2

const DEDUP_HINT = [
  '判重由你完成。相似度只说明检索有多近，不代替判断。',
  '- 相似度越高，越应当强化已有记忆，而不是新建一条近义重复。',
  '- 先看是不是同一件事：对象相同、结论指向同一规则域才算。平台、语言不同仍是同一件事，不要因此新建。',
  '- 同一件事，只是换措辞，或新陈述是已有规则已经覆盖的子集、没有新约束：调用 memory_reinforce，id 用上面列出的 id，正文不动。不要把更宽的旧规则改窄。',
  '- 同一件事，但有新事实、取值冲突、适用范围扩大，或明确要求旧规则以后只在更小的范围生效：调用 memory_merge。id 必须用上面列出的 id，不要编造。text 写合并后的当前结论，自包含；冲突以本次陈述为准，不冲突的旧信息保留；不要写「原先怎样、现在改成怎样」。',
  '- 拿不准就新建，不要错误合并。',
].join('\n')

function otherGroup(group) {
  return group === 'rule' ? 'project' : 'rule'
}

function hostQuestionGuide(prompt, options) {
  const optionLines = options.map((label) => `- ${label}`).join('\n')
  return [
    '下一步必须调用当前宿主的应用内提问工具，由它弹出确认。禁止在对话里写草稿或列表，禁止使用系统弹窗。',
    'Cursor 用 AskQuestion，CodeBuddy 与 WorkBuddy 用 AskUserQuestion。题面和选项照抄，不要改写。',
    '',
    `题面：${prompt}`,
    '选项：',
    optionLines,
    '',
    '用户点选落成之后调用 memory_persist。选「不落成」则不要写盘。',
  ].join('\n')
}

async function memoryList() {
  const groups = await readAllGroups()
  const total = GROUPS.reduce((n, g) => n + groups[g].length, 0)
  if (total === 0) return text('记忆库为空')
  return text(
    [
      `rule    ${groups.rule.length} 条 —— 无条件生效的规则与偏好，会话开始已全量注入，无需读取`,
      `project ${groups.project.length} 条 —— 项目事实，相关条目每轮自动召回；需要全量时用 memory_read("project")`,
    ].join('\n')
  )
}

async function memoryRead(args) {
  const group = String(args.group || '').trim().toLowerCase()
  if (!GROUPS.includes(group)) return text(`参数 group 必须是 ${GROUPS.join(' 或 ')}`)
  const mems = await readGroup(group)
  if (mems.length === 0) return text(`「${group}」下没有记忆`)
  const head = `${group}（共 ${mems.length} 条${mems.length > READ_LIMIT ? `，以下为前 ${READ_LIMIT} 条` : ''}）`
  const body = mems
    .slice(0, READ_LIMIT)
    .map((m, i) => `${i + 1}. ${m.deprecated ? '[已废弃] ' : ''}${m.text}（置信度 ${fmtConfidence(m.confidence)}，id ${m.id}）`)
    .join('\n')
  return text(`${head}\n${body}`)
}

async function listTools() {
  const settings = await loadSettings()
  const hidden = settings.sideJudge ? SIDEPATH_HIDDEN : BLOCKING_HIDDEN
  return TOOLS.filter((tool) => !hidden.has(tool.name))
}

async function memoryPropose(args) {
  const settings = await loadSettings()
  if (settings.sideJudge) return sidepathWriteRefusal()

  const content = String(args.text || '').trim()
  if (!content) return text('参数 text 不能为空')
  const all = await readAllMemories()
  // 关掉门控拿最相近的两条。分数只交给模型参考，不在这里决定新建、强化或合并。
  let similar = []
  try {
    similar = await recall([content], all, { topK: PROPOSE_TOP_K, gate: false })
  } catch (e) {
    console.error(`[memory] 判重召回失败，跳过相近记忆提示: ${e.message}`)
  }

  const lines = [`待沉淀内容：${content}`]
  if (similar.length > 0) {
    lines.push('', `最相近的 ${similar.length} 条已有记忆（合并或强化时 id 用这里的值）：`)
    similar.forEach((s, i) => {
      lines.push(`${i + 1}. id：${s.memory.id}`)
      lines.push(`   相似度：${s.score.toFixed(2)}`)
      lines.push(`   分组：${s.memory.category}`)
      lines.push(`   正文：${s.memory.text}`)
    })
    lines.push('', DEDUP_HINT)
  } else {
    lines.push('', '没有语义相近的已有记忆。按新建处理，调用 memory_persist。')
  }

  const guess = inferGroup(content)
  const groupNote = guess.confident ? '正文的语气信号明确' : '正文没有明确信号，这是保守默认值'
  lines.push('', `分组建议：${guess.group}（${groupNote}）`)

  if (!settings.confirm && guess.confident) {
    lines.push('', similar.length > 0
      ? '当前不需要确认，且分组信号明确：按上面的规则直接调用。memory_reinforce 和 memory_merge 的 id 用上面列出的 id。'
      : '当前不需要确认，且分组信号明确：直接调用 memory_persist。')
    return text(lines.join('\n'))
  }

  if (similar.length === 0) {
    const alt = otherGroup(guess.group)
    lines.push('', hostQuestionGuide(
      `检测到一条记忆，建议落成 ${guess.group}。是否落成记忆。\n正文：${content}\n推荐标签：${guess.group}`,
      [
        `落成，使用推荐标签 ${guess.group}`,
        `落成，把标签改为 ${alt}`,
        '不落成',
      ],
    ))
    return text(lines.join('\n'))
  }

  lines.push('', blockingDedupConfirm(content, guess, similar))
  return text(lines.join('\n'))
}

function blockingDedupConfirm(content, guess, similar) {
  const alt = otherGroup(guess.group)
  const idLines = similar.map((s) => `- ${s.memory.id}`).join('\n')
  return [
    '先按判重规则选定新建、强化或合并，再用宿主提问工具弹出确认。禁止在对话里写草稿，禁止使用系统弹窗。',
    'Cursor 用 AskQuestion，CodeBuddy 与 WorkBuddy 用 AskUserQuestion。',
    '',
    `正文：${content}`,
    `推荐标签：${guess.group}`,
    '可用的已有记忆 id：',
    idLines,
    '按选定的动作出题，不要把三种动作塞进同一题。id 只能从上面选：',
    '- 强化：选项为「强化已有记忆」加上选中的 id，以及「不落成」。点选强化后调用 memory_reinforce，id 用选中的 id。',
    '- 合并：题面写上合并后正文。选项为「合并进已有记忆」加上选中的 id，以及「不落成」。点选合并后调用 memory_merge，id 用选中的 id，text 用合并正文。',
    `- 新建：选项为「落成，使用推荐标签 ${guess.group}」「落成，把标签改为 ${alt}」「不落成」。点选落成后调用 memory_persist。`,
    '选「不落成」则不要写盘。',
  ].join('\n')
}

async function memoryPersist(args) {
  const settings = await loadSettings()
  if (settings.sideJudge) return text('旁路模式只允许使用 memory_resolve 处理插件待确认记忆。')
  const mem = await persistMemory({
    text: args.text,
    category: args.category,
    evidence: args.evidence,
  })
  const note = mem.category === 'rule' ? '下个会话开始起无条件注入' : '将按相关性自动召回'
  return text(`已沉淀为 ${mem.category}：${mem.text}（置信度 ${fmtConfidence(mem.confidence)}，id ${mem.id}）。${note}。`)
}

async function memoryReinforce(args) {
  const settings = await loadSettings()
  if (settings.sideJudge) return text('旁路模式只允许使用 memory_resolve 处理插件待确认记忆。')
  const mem = await reinforceMemory(String(args.id || '').trim())
  return text(`已强化 ${mem.category} 中的记忆：${mem.text}（置信度 ${fmtConfidence(mem.confidence)}）`)
}

async function memoryMerge(args) {
  const settings = await loadSettings()
  if (settings.sideJudge) return text('旁路模式只允许使用 memory_resolve 处理插件待确认记忆。')
  const mem = await mergeMemory(String(args.id || '').trim(), args.text)
  return text(`已合并进 ${mem.category} 中的记忆：${mem.text}（置信度 ${fmtConfidence(mem.confidence)}，id ${mem.id}）`)
}

async function memoryResolve(args) {
  const settings = await loadSettings()
  if (!settings.sideJudge) return text('memory_resolve 仅用于旁路模式的插件确认流程。')
  const result = await resolvePendingSession(args.sessionID, args.decision, AGENT)
  return text(result.message)
}

async function memoryReview() {
  const settings = await loadSettings()
  const items = await listCandidates()
  if (items.length === 0) return text('没有待确认的候选记忆')
  const body = items
    .map((c, i) => `${i + 1}. ${c.text}\n   出现 ${c.observations} 次，最近 ${String(c.lastSeen).slice(0, 10)}，指纹 ${c.fingerprint}`)
    .join('\n')
  const tail = settings.sideJudge
    ? '旁路模式没有 memory_propose，候选不能从这里落成。丢弃用 memory_discard。'
    : '请整理成编号列表询问用户：沉淀哪些、归到哪个标签、哪些丢弃。确认后对沉淀项调 memory_persist，对丢弃项调 memory_discard。'
  return text(`${items.length} 条待确认候选（按出现次数降序）：\n${body}\n\n${tail}`)
}

async function memoryDiscard(args) {
  const ok = await dropCandidate(String(args.fingerprint || '').trim(), { reject: !!args.reject })
  return text(ok ? '候选已丢弃' : '未找到该候选，可能已被处理')
}

async function memoryConfig(args) {
  if (!args.key) {
    const items = await describeSettings()
    const body = items.map((i) => `- ${i.key} = ${i.value}${i.isDefault ? '（默认）' : ''}`).join('\n')
    return text(`当前配置：\n${body}`)
  }
  if (args.key === 'sideJudge') {
    return text('sideJudge 不能在这里改。切换通路请在仓库里运行 node tools/setup.mjs sidepath 或 node tools/setup.mjs blocking，然后重启 Cursor、codebuddy、WorkBuddy。')
  }
  if (args.value === undefined) return text('修改配置需要同时提供 key 与 value')
  const r = await updateSetting(args.key, args.value)
  return text(r.message)
}

const HANDLERS = {
  memory_list: memoryList,
  memory_read: memoryRead,
  memory_propose: memoryPropose,
  memory_persist: memoryPersist,
  memory_reinforce: memoryReinforce,
  memory_merge: memoryMerge,
  memory_resolve: memoryResolve,
  memory_review: memoryReview,
  memory_discard: memoryDiscard,
  memory_config: memoryConfig,
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

async function handle(req) {
  const { id, method, params } = req
  if (method === 'initialize') {
    return {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'memory-self-evolution', version: '0.2.0' },
    }
  }
  if (method === 'tools/list') return { tools: await listTools() }
  if (method === 'tools/call') {
    const name = params && params.name
    const handler = HANDLERS[name]
    if (!handler) throw new Error(`未知工具「${name}」`)
    return await handler((params && params.arguments) || {})
  }
  if (method === 'ping') return {}
  throw new Error(`不支持的方法「${method}」`)
}

let buffer = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', async (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let req
    try {
      req = JSON.parse(line)
    } catch (e) {
      console.error(`[memory-mcp] 收到非法 JSON，已忽略: ${e.message}`)
      continue
    }
    // 通知类消息（无 id）不需要回复。
    if (req.id === undefined || req.id === null) continue
    try {
      send({ jsonrpc: '2.0', id: req.id, result: await handle(req) })
    } catch (e) {
      // 工具执行失败要以 isError 形式回给模型，让它能看到原因并自行调整，
      // 而不是抛协议级错误让整个 server 看起来坏掉。
      const isToolCall = req.method === 'tools/call'
      if (isToolCall) {
        send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: `执行失败：${e.message}` }], isError: true } })
      } else {
        send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: e.message } })
      }
      console.error(`[memory-mcp] ${req.method} 失败: ${e.stack || e.message}`)
    }
  }
})
