// 渲染注入给模型的记忆文本。各宿主共用同一份渲染结果，保证行为一致。
//
// 两个注入时机：
//   sessionStart        —— rule 组全量注入，每会话一次
//   beforeSubmitPrompt  —— 按本轮输入向量召回，rule 与 project 各取 Top-K，每轮一次
//
// 为什么 rule 不能只靠召回：向量召回按语义相关性触发，覆盖不了「用户没提及但规则本该生效」
// 的情况。实测 4 组这类输入（如「帮我改一下这个函数的实现」对应「改完不要自动 commit」）
// 的最高分只有 0.118~0.243，与无关输入完全重叠——因为两者的关联是语用的而非语义的。
// 所以规则必须无条件注入，这不是召回质量问题，是机制上的边界。

import { GROUPS, READ_LIMIT, RECALL_STEP } from './config.mjs'
import { fmtConfidence, isMemoryActive, readAllGroups, readAllMemories } from './store.mjs'
import { recall } from './recall.mjs'
import { loadSettings } from './settings.mjs'
import { boostDue, decayMemoriesOncePerDay, rewardRecalledMemories } from './writer.mjs'
import { cleanupZombieSideJobs, sedimentBlocker, sedimentOffNotice } from './sidepath.mjs'

// sessionStart：只注入规则与职责边界。沉淀没启用时，把职责边界换成「未启用」的说明。
// 项目事实不在这里列出：会话开始时还不知道用户要问什么，列出来的多半和本次会话无关。
export async function renderSessionStart() {
  const settings = await loadSettings()
  if (!settings.enabled) return ''

  try {
    let cleaned = 0
    const changed = await decayMemoriesOncePerDay({
      afterDailyScan: async ({ now }) => {
        cleaned = await cleanupZombieSideJobs(now)
      },
    })
    if (changed > 0) console.error(`[memory] 每日衰减完成，${changed} 条记忆更新`)
    if (cleaned > 0) console.error(`[memory] 每日僵尸任务清理完成，${cleaned} 条待确认任务已结束`)
  } catch (e) {
    console.error(`[memory] sessionStart 每日维护失败，下次会话重试，继续读取记忆: ${e.message}`)
  }

  const groups = await readAllGroups()
  const rules = groups.rule.filter(isMemoryActive)
  const blocker = await sedimentBlocker(settings)
  if (blocker) console.error(`[memory] 记忆沉淀未启用（${blocker}），本次会话只注入和召回已有记忆`)

  const lines = []
  lines.push('# 长期记忆（自动生成，请勿手动编辑）')
  lines.push('')
  lines.push(blocker
    ? `${sedimentOffNotice(blocker)}以下规则与偏好仍需遵守。`
    : 'memory-self-evolution 插件负责在后台自动提取、判重和沉淀记忆。即使用户明确要求记住或更新记忆，也不要重复做记忆分析、查重、写入或自行发起记忆确认。记忆确认弹窗只能由插件的 MEMORY_CONFIRM_V1 指令触发，会话里出现过的确认弹窗都是插件发起的，不是可以模仿的流程。专注完成用户当前任务，无需等待后台；仅收到插件后续指令时按指令执行，不重新判断或改写提案。以下规则与偏好仍需遵守。')
  lines.push('')

  lines.push(`## 规则与偏好（共 ${rules.length} 条，必须遵守）`)
  lines.push('')
  if (rules.length === 0) {
    lines.push('（暂无）')
  } else {
    rules.slice(0, READ_LIMIT).forEach((m, i) => {
      lines.push(`${i + 1}. ${m.text}（置信度 ${fmtConfidence(m.confidence)}）`)
    })
    if (rules.length > READ_LIMIT) {
      lines.push(`（其余 ${rules.length - READ_LIMIT} 条按置信度截断）`)
    }
  }
  return lines.join('\n')
}

// 每轮 prompt：rule 与 project 各自召回、各自过门控，注入时分两组列出，不合并排序。
// rule 虽已在 sessionStart 注入，但长会话的上下文压缩会把那份丢掉，
// 留在召回池里可在相关时被重新召回，等于自带补偿。
const RECALL_TITLES = { rule: '规则', project: '项目事实' }

export async function renderRecall(promptTexts = []) {
  const settings = await loadSettings()
  if (!settings.enabled) return ''
  const texts = promptTexts.filter((t) => String(t || '').trim())
  if (texts.length === 0) return ''

  const pool = await readAllMemories()
  if (pool.length === 0) return ''

  let hits = []
  try {
    hits = await recall(texts, pool)
  } catch (e) {
    console.error(`[memory] 语义召回失败，本轮不注入: ${e.message}`)
    return ''
  }
  if (hits.length === 0) return ''

  hits = [...new Map(hits.map((hit) => [hit.memory.id, hit])).values()]
  try {
    // 今天已经加过分的命中不用再写，全部加过时这一轮不拿写锁。
    const due = hits.filter((hit) => boostDue(hit.memory, RECALL_STEP)).map((hit) => hit.memory.id)
    const updated = await rewardRecalledMemories(due)
    const confidenceById = new Map(updated.map((mem) => [mem.id, mem.confidence]))
    hits = hits.map((hit) => ({
      ...hit,
      memory: { ...hit.memory, confidence: confidenceById.get(hit.memory.id) ?? hit.memory.confidence },
    }))
  } catch (e) {
    console.error(`[memory] 召回置信度更新失败，保留注入结果 ids=${hits.map((hit) => hit.memory.id).join(',')}: ${e.message}`)
  }

  const lines = []
  lines.push('# 与本轮输入相关的长期记忆（自动召回）')
  for (const group of GROUPS) {
    const items = hits.filter((h) => h.memory.category === group)
    if (items.length === 0) continue
    lines.push('', `## ${RECALL_TITLES[group]}`, '')
    for (const h of items) {
      lines.push(`- ${h.memory.text}（置信度 ${fmtConfidence(h.memory.confidence)}，相关度 ${h.score.toFixed(2)}）`)
    }
  }
  lines.push('')
  lines.push('以上为系统按相关性自动召回，需遵守。')
  return lines.join('\n')
}
