#!/usr/bin/env node
// 各宿主共用的记忆 CLI。Cursor / codebuddy / WorkBuddy / Claude Code 通过 hook 调用本入口拿注入文本，
// 人工也可直接用 list / read / rule 等子命令管理记忆库。
//
// 用法：
//   memory-self-evolution hook [--agent cursor|codebuddy|workbuddy|claude]   从 stdin 读 hook 事件，按事件类型注入记忆或取回旁路结果
//   memory-self-evolution list                              列出两组记忆的条数
//   memory-self-evolution read <rule|project>               打印该组记忆
//   memory-self-evolution rule add "<规则>"                  直接新增一条规则，不经模型判断
//   memory-self-evolution trash                             列出回收站里的记忆
//   memory-self-evolution restore <id>                      从回收站恢复一条记忆
//   memory-self-evolution config [key] [value]              查看或修改配置
//
// hook 按事件分派：session-start 注入 rule，prompt 注入每轮召回并启动旁路判别，stop 取回旁路的结果。
//
// 风控约定：hook 模式下任何异常都输出空 JSON 并以 0 退出。
// 记忆功能失效可以接受，阻塞用户发送 prompt 不可接受。

import { GROUPS, READ_LIMIT } from '../lib/core/config.mjs'
import { fmtConfidence, readAllGroups, readGroup } from '../lib/core/store.mjs'
import { renderRecall, renderSessionStart } from '../lib/core/render.mjs'
import { listTrash, persistMemory, restoreMemory } from '../lib/core/writer.mjs'
import { describeSettings, loadSettings, updateSetting } from '../lib/core/settings.mjs'
import { CONFIRM_MARK, hiddenNoticeForPrompt, isUserNotice, maybeStartSideJob, runSideJob, sedimentBlocker, sedimentOffNotice, takeSideFollowup } from '../lib/core/sidepath.mjs'
import { agentForEvent, eventKind, hostOf } from '../lib/hosts/index.mjs'

function readStdin() {
  return new Promise((resolve) => {
    let buf = ''
    if (process.stdin.isTTY) return resolve('')
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (c) => (buf += c))
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', (e) => {
      console.error(`[memory] 读取 hook 输入失败: ${e.message}`)
      resolve('')
    })
  })
}

// 每轮输入时提醒主模型：记忆由插件在后台处理。宿主可以给出自己的说法。
const PROMPT_REMINDER = '记忆由 memory-self-evolution 插件在后台判断。用户陈述偏好、规范或要求记住时，你只需回应并照做：不要判断是否该记，不要调用提问工具发起「检测到一条记忆」确认，也不要主动调用 memory_resolve 或其它记忆写工具。只有收到含 MEMORY_CONFIRM_V1 的插件指令时，才按指令弹窗并处理对应 sessionID。'

function detectAgent(argv, event) {
  const flagIdx = argv.indexOf('--agent')
  if (flagIdx >= 0 && argv[flagIdx + 1]) return argv[flagIdx + 1]
  return agentForEvent(event)
}

async function runHook(argv) {
  const raw = await readStdin()
  let payload = {}
  if (raw.trim()) {
    try {
      payload = JSON.parse(raw)
    } catch (e) {
      console.error(`[memory] hook 输入不是合法 JSON，按空输入处理: ${e.message}`)
    }
  }
  const event = String(payload.hook_event_name || '')
  const agent = detectAgent(argv, event)
  const host = hostOf(agent)
  const kind = eventKind(event) || (argv.includes('--session-start') ? 'session-start' : 'prompt')

  // 旁路模型自己的子进程也会触发 hook。这里直接退出，避免再启动一次判断。
  if (process.env.MEMORY_SIDE_JUDGE === '1') {
    process.stdout.write('{}')
    return
  }

  if (kind === 'stop') {
    let followup = null
    try {
      const settings = await loadSettings()
      // 子任务结束不是用户这一轮结束，不在那里续轮。
      const background = Boolean(host.isBackground && host.isBackground(payload))
      if (settings.enabled && !background) {
        followup = await takeSideFollowup(agent, payload, settings.sideWaitMs)
      }
    } catch (e) {
      console.error(`[memory] 旁路确认失败，本轮正常结束: ${e.message}`)
    }
    process.stdout.write(JSON.stringify(followup || {}))
    return
  }

  const promptText = host.promptText(payload)
  let reminder = ''
  if (kind === 'prompt') {
    try {
      const settings = await loadSettings()
      if (settings.enabled && promptText && !isUserNotice(promptText) && !promptText.includes(CONFIRM_MARK)) {
        const blocker = await sedimentBlocker(settings)
        reminder = blocker ? sedimentOffNotice(blocker) : (host.promptReminder || PROMPT_REMINDER)
      }
      await maybeStartSideJob({ agent, payload, promptText })
    } catch (e) {
      console.error(`[memory] 旁路启动失败，本轮不判断: ${e.message}`)
    }
  }

  const recalled = kind === 'session-start' ? '' : await renderRecall([promptText])
  const hidden = kind === 'prompt' ? await hiddenNoticeForPrompt(agent, promptText, payload) : ''
  const text = kind === 'session-start'
    ? await renderSessionStart({ boundary: host.sessionStartBoundary, maxChars: host.injectionLimit })
    : [hidden, reminder, recalled].filter(Boolean).join('\n\n')

  process.stdout.write(JSON.stringify(text ? host.wrapInjection(event, text) : {}, null, 0))
}

async function runList() {
  const groups = await readAllGroups()
  const total = GROUPS.reduce((n, g) => n + groups[g].length, 0)
  if (total === 0) {
    console.log('记忆库为空')
    return
  }
  console.log(`rule    ${groups.rule.length} 条（会话开始全量注入，无条件生效）`)
  console.log(`project ${groups.project.length} 条（按相关性自动召回）`)
  console.log(`共 ${total} 条`)
}

async function runRead(group) {
  if (!GROUPS.includes(group)) {
    console.error(`用法：memory-self-evolution read <${GROUPS.join('|')}>`)
    process.exitCode = 1
    return
  }
  const mems = await readGroup(group)
  if (mems.length === 0) {
    console.log(`「${group}」下没有记忆`)
    return
  }
  console.log(`${group}（共 ${mems.length} 条${mems.length > READ_LIMIT ? `，显示前 ${READ_LIMIT}` : ''}）`)
  mems.slice(0, READ_LIMIT).forEach((m, i) => {
    const dep = m.deprecated ? '[已废弃] ' : ''
    console.log(`${i + 1}. ${dep}${m.text}（置信度 ${fmtConfidence(m.confidence)}，id ${m.id}）`)
  })
}

// 直接新增规则，不经模型判断——用户说了就是规则。
async function runRuleAdd(text) {
  if (!text) {
    console.error('用法：memory-self-evolution rule add "<规则内容>"')
    process.exitCode = 1
    return
  }
  const mem = await persistMemory({ text, category: 'rule', evidence: '用户通过 CLI 直接添加' })
  console.log(`已新增规则：${mem.text}`)
  console.log(`置信度 ${fmtConfidence(mem.confidence)}，id ${mem.id}`)
  console.log('下个会话开始起无条件生效。')
}

async function runTrash() {
  const items = await listTrash()
  if (items.length === 0) {
    console.log('回收站是空的')
    return
  }
  console.log(`回收站（共 ${items.length} 条，最近删掉的在前，保留 30 天）`)
  items.forEach((item, i) => {
    const how = item.deletedReason === 'merge' ? `合并进 ${item.mergedInto}` : '删除'
    console.log(`${i + 1}. ${item.text}（${item.category}，id ${item.id}，${how}于 ${item.deletedAt}）`)
  })
}

async function runRestore(id) {
  if (!id) {
    console.error('用法：memory-self-evolution restore <id>')
    process.exitCode = 1
    return
  }
  const mem = await restoreMemory(id)
  console.log(`已恢复到 ${mem.category}：${mem.text}（置信度 ${fmtConfidence(mem.confidence)}，id ${mem.id}）`)
}

async function runConfig(key, value) {
  if (!key) {
    const items = await describeSettings()
    for (const i of items) console.log(`${i.key.padEnd(22)} = ${i.value}${i.isDefault ? '  (默认)' : ''}`)
    return
  }
  if (value === undefined) {
    console.error('用法：memory-self-evolution config <key> <value>')
    process.exitCode = 1
    return
  }
  const r = await updateSetting(key, value)
  console.log(r.message)
  if (!r.ok) process.exitCode = 1
}

const argv = process.argv.slice(2)
const cmd = argv[0]

try {
  if (cmd === 'hook') {
    await runHook(argv)
  } else if (cmd === 'list') {
    await runList()
  } else if (cmd === 'read') {
    await runRead(argv[1])
  } else if (cmd === 'rule' && argv[1] === 'add') {
    await runRuleAdd(argv.slice(2).join(' ').trim())
  } else if (cmd === 'trash') {
    await runTrash()
  } else if (cmd === 'restore') {
    await runRestore(argv[1])
  } else if (cmd === 'config') {
    await runConfig(argv[1], argv[2])
  } else if (cmd === 'side-run') {
    await runSideJob(argv[1])
  } else {
    console.error('用法：memory-self-evolution <hook|list|read|rule add|trash|restore|config> [参数]')
    process.exitCode = 1
  }
} catch (e) {
  if (cmd === 'hook') {
    // hook 失败必须静默降级，否则会阻断用户发送 prompt。
    console.error(`[memory] hook 执行失败，本轮不注入记忆: ${e.stack || e.message}`)
    process.stdout.write('{}')
  } else {
    console.error(`[memory] 执行失败: ${e.stack || e.message}`)
    process.exitCode = 1
  }
}
