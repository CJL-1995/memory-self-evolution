// 用户要求整理记忆时的统一入口：删除、合并、改写。MCP 的 memory_update 调用这里。
// 写入都在写入层持锁完成；这里负责校验参数、作废失效的待确认提案，以及拼出交给用户的结果。

import { fileURLToPath } from 'node:url'
import { TRASH_RETENTION_DAYS } from './config.mjs'
import { fmtConfidence } from './store.mjs'
import { combineMemories, deleteMemories, replaceMemoryText } from './writer.mjs'
import { retireProposalsFor } from './sidepath.mjs'

const memoryBin = fileURLToPath(new URL('../../bin/memory.mjs', import.meta.url))
const GROUP_NAMES = { rule: '规则与偏好', project: '项目事实' }

export const UPDATE_ACTIONS = ['delete', 'merge', 'replace']

function restoreHint(id, how = '恢复') {
  return `在回收站里保留 ${TRASH_RETENTION_DAYS} 天，需要时运行 node "${memoryBin}" restore ${id} ${how}。`
}

async function retiredNote(ids, subject = '它') {
  const count = await retireProposalsFor(ids)
  return count > 0 ? `另有 ${count} 条指向${subject}的待确认提案已作废。` : ''
}

function requireText(text, action) {
  if (text === undefined || text === null || !String(text).trim()) {
    throw new Error(action === 'merge' ? '合并缺少 text：合并后的正文由用户给出' : '改写缺少 text')
  }
  return String(text)
}

// 删除的目标：id 和 ids 合在一起，按空白拆开再去重。模型有时会把用户空格分隔的一串 id 原样放进一个字符串。
function deleteTargets(id, ids) {
  const list = Array.isArray(ids) ? ids : [ids]
  return [...new Set([id, ...list].flatMap((value) => String(value ?? '').split(/\s+/)).filter(Boolean))]
}

async function deleteAndReport(targets) {
  const { removed, missing } = await deleteMemories(targets)
  const groupOf = (mem) => GROUP_NAMES[mem.category] || mem.category
  if (targets.length === 1) {
    const [mem] = removed
    return `已删除${groupOf(mem)}里的一条记忆：「${mem.text}」（id ${mem.id}）。${restoreHint(mem.id)}${await retiredNote([mem.id])}`
  }
  const lines = removed.map((mem) => `- ${groupOf(mem)}：「${mem.text}」（id ${mem.id}）`)
  const skipped = missing.length > 0 ? `以下 id 不存在，已跳过：${missing.join('、')}。` : ''
  return [
    `已删除 ${removed.length} 条记忆：`,
    ...lines,
    `${restoreHint('<id>', '逐条恢复')}${skipped}${await retiredNote(removed.map((m) => m.id), '这些记忆')}`,
  ].join('\n')
}

export async function updateMemory({ action, id, ids, id2, text } = {}) {
  const act = String(action || '').trim()
  if (!UPDATE_ACTIONS.includes(act)) throw new Error(`action 只能是 ${UPDATE_ACTIONS.join('、')}，收到「${act}」`)

  if (act === 'delete') {
    const targets = deleteTargets(id, ids)
    if (targets.length === 0) throw new Error('缺少 id')
    return deleteAndReport(targets)
  }

  const target = String(id || '').trim()
  if (!target) throw new Error('缺少 id')

  if (act === 'merge') {
    const other = String(id2 || '').trim()
    if (!other) throw new Error('合并缺少 id2：要并掉的那条记忆')
    const { mem, before } = await combineMemories(target, other, requireText(text, act))
    return `已合并两条记忆。保留 ${mem.id}，正文改为「${mem.text}」，置信度 ${fmtConfidence(mem.confidence)}。并掉的 ${other}「${before.dropText}」${restoreHint(other)}${await retiredNote([mem.id, other])}`
  }

  const { mem, previous } = await replaceMemoryText(target, requireText(text, act))
  return `已改写记忆 ${mem.id}：原来是「${previous}」，现在是「${mem.text}」，置信度 ${fmtConfidence(mem.confidence)} 不变。${await retiredNote([mem.id])}`
}
