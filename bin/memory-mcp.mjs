#!/usr/bin/env node
// 三端共用的记忆 MCP server（stdio，JSON-RPC 2.0，换行分隔）。
// Cursor、codebuddy 与 WorkBuddy 的 mcp.json 格式一致，同一份配置三端复用。
// 手写协议而不引依赖：这个 server 要被短命/常驻两种方式反复启动，依赖越少启动越快、越不易坏。

import { GROUPS, READ_LIMIT, paths } from '../lib/core/config.mjs'
import { fmtConfidence, readAllGroups, readGroup } from '../lib/core/store.mjs'
import { describeSettings, updateSetting } from '../lib/core/settings.mjs'
import { resolvePendingSession } from '../lib/core/sidepath.mjs'
import { UPDATE_ACTIONS, updateMemory } from '../lib/core/manage.mjs'
import { syncSnapshot } from '../lib/core/snapshot.mjs'
import { openWithDefaultApp } from '../lib/core/open-file.mjs'

const PROTOCOL_VERSION = '2024-11-05'

// 由 setup 写进 mcp.json 的 --agent 决定，用于隔离不同客户端的旁路待确认提案。
const agentIdx = process.argv.indexOf('--agent')
const AGENT = agentIdx >= 0 ? String(process.argv[agentIdx + 1] || '') : ''

const TOOLS = [
  {
    name: 'memory_list',
    description: '列出两组记忆的条数。rule 是无条件生效的规则与偏好，project 是按需召回的项目事实。用户要查看全部记忆时传 open=true，插件会刷新 memories.html 并用系统默认浏览器打开它。',
    inputSchema: {
      type: 'object',
      properties: { open: { type: 'boolean', description: '为 true 时刷新并在浏览器里打开 memories.html，供用户查看全部记忆' } },
      additionalProperties: false,
    },
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
    name: 'memory_update',
    description: '整理这个插件里已有的记忆：删除、合并或改写。只在用户明确要求、并且已经确认要执行的内容之后调用；新增记忆不用它，客户端自带的记忆也不用它。id 必须来自 memory_read 的返回。delete 删除 id，或一次删除 ids 里的多条，不存在的 id 跳过、其余照常删除；merge 保留 id、并掉 id2，正文换成 text，置信度取两条中较高的；replace 用 text 换掉 id 的正文，置信度不变。text 由用户给出或经用户确认，须为中文、自包含、6 到 400 个字。删除和被并掉的记忆进回收站，30 天内可以恢复。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: UPDATE_ACTIONS, description: 'delete 删除，merge 合并，replace 改写' },
        id: { type: 'string', description: '要删除或改写的记忆 id；合并时是要保留的那条。删除多条时用 ids' },
        ids: { type: 'array', items: { type: 'string' }, description: '一次删除多条时的记忆 id 列表，只在 delete 时使用' },
        id2: { type: 'string', description: '合并时要并掉的那条记忆 id，只在 merge 时使用' },
        text: { type: 'string', description: 'merge 和 replace 的新正文' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_resolve',
    description: '处理插件弹窗中的一条待确认记忆。sessionID 必须照抄插件提供的值，decision 必须与用户点选一致。正文、目标记忆和合并正文均由插件内部提案决定。',
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
    name: 'memory_config',
    description: '查看或修改记忆系统配置。不传参数即查看全部；传 key 与 value 则修改。可调项含 recallTopK（rule 和 project 每轮各自最多召回几条，默认 3）、recallMinScore（rule 的召回下限）与 recallMinScoreProject（project 的召回下限），各自与同类 top1×0.6 取更高者作为保留线；recallMinMargin（领先幅度门控，-1 为关闭）、confirm（写盘前是否弹确认）、decayDays（闲置满多少天扣一次置信度，正整数，默认 30）、enabled、sideApiBase、sideApiModel。sideApiBase 和 sideApiModel 没有缺省值，旁路必填。旁路 API 密钥不在这里，放在 side-secret.json 的 apiKey，同样必填。',
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

async function memoryList(args) {
  const groups = await readAllGroups()
  const total = GROUPS.reduce((n, g) => n + groups[g].length, 0)
  const lines = total === 0
    ? ['记忆库为空']
    : [
        `rule    ${groups.rule.length} 条 —— 无条件生效的规则与偏好，会话开始已全量注入，无需读取`,
        `project ${groups.project.length} 条 —— 项目事实，相关条目每轮自动召回；需要全量时用 memory_read("project")`,
      ]
  if (args.open === true) {
    await syncSnapshot()
    const opened = await openWithDefaultApp(paths.snapshot)
    lines.push(opened.ok
      ? `已用默认程序打开全部记忆：${paths.snapshot}`
      : `没能打开文件（${opened.detail}），全部记忆在：${paths.snapshot}`)
  }
  return text(lines.join('\n'))
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

async function memoryUpdate(args) {
  return text(await updateMemory(args))
}

async function memoryResolve(args) {
  const result = await resolvePendingSession(args.sessionID, args.decision, AGENT)
  return text(result.message)
}

async function memoryConfig(args) {
  if (!args.key) {
    const items = await describeSettings()
    const body = items.map((i) => `- ${i.key} = ${i.value}${i.isDefault ? '（默认）' : ''}`).join('\n')
    return text(`当前配置：\n${body}`)
  }
  if (args.value === undefined) return text('修改配置需要同时提供 key 与 value')
  const r = await updateSetting(args.key, args.value)
  return text(r.message)
}

const HANDLERS = {
  memory_list: memoryList,
  memory_read: memoryRead,
  memory_update: memoryUpdate,
  memory_resolve: memoryResolve,
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
  if (method === 'tools/list') return { tools: TOOLS }
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
