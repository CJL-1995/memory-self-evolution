// 记忆写入层：所有正式记忆变更共用跨进程写锁，读改写使用临时文件加 rename。

import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { CONFIDENCE_MAX, DECAY_STEP, DEPRECATED_AT, GROUPS, INITIAL_CONFIDENCE, MEMORY_TEXT_MAX, MEMORY_TEXT_MIN, RECALL_STEP, REINFORCE_STEP, ROOT, TRASH_RETENTION_DAYS, paths } from './config.mjs'
import { isMemoryActive, normalizeGroup, readGroup, sortMemories } from './store.mjs'
import { loadSettings } from './settings.mjs'
import { dropVectors, ensureVectors, loadIndex, refreshVector } from './recall.mjs'
import { syncSnapshot } from './snapshot.mjs'

const WRITE_LOCK = path.join(ROOT, '.memory-write.lock')
const LOCK_WAIT_MS = 5000
// 召回加分等锁的上限。这一步排在 prompt hook 输出召回内容之前，而加分少一次没有实质损失
// （当天下一次命中还会再试），不值得让用户的输入等：等满 5 秒会超过 Cursor 给 hook 的超时，召回内容反而丢了。
const REWARD_LOCK_WAIT_MS = 300
// 锁目录存在超过这个时间就当作残留回收，不管占锁的进程号是否还活着。
// 正常持锁只有约 10 毫秒。只看进程号的话，占锁时进程被杀、之后进程号又被别的进程用上（比如重启）会一直卡住。
const LOCK_STALE_MS = 15000

async function releaseLock(owner) {
  try {
    await fsp.unlink(path.join(WRITE_LOCK, owner))
    await fsp.rmdir(WRITE_LOCK)
  } catch (e) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) {
      console.error(`[memory] 释放写锁失败 path=${WRITE_LOCK} owner=${owner}: ${e.message}`)
    }
  }
}

// 回收残留的写锁：占锁超过 LOCK_STALE_MS，或者占锁的进程已经退出。
async function recoverStaleLock() {
  try {
    const owners = await fsp.readdir(WRITE_LOCK)
    if (owners.length !== 1) return
    const age = Date.now() - (await fsp.stat(WRITE_LOCK)).mtimeMs
    if (age >= LOCK_STALE_MS) {
      console.error(`[memory] 回收超过 ${LOCK_STALE_MS / 1000} 秒未释放的记忆写锁 owner=${owners[0]} 已占 ${Math.round(age / 1000)} 秒`)
      await releaseLock(owners[0])
      return
    }
    const match = /^owner-(\d+)-/.exec(owners[0])
    if (!match || Number(match[1]) <= 0) return
    try {
      process.kill(Number(match[1]), 0)
    } catch (e) {
      if (e.code !== 'ESRCH') {
        console.error(`[memory] 无法确认写锁持有者状态 owner=${owners[0]}: ${e.message}`)
        return
      }
      console.error(`[memory] 回收已退出进程的记忆写锁 owner=${owners[0]}`)
      await releaseLock(owners[0])
    }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[memory] 检查记忆写锁失败 path=${WRITE_LOCK}: ${e.message}`)
  }
}

// waitMs 是等锁的上限，等不到时抛出 code 为 ELOCKED 的错误，由调用方决定怎么处理和记录。
async function withMemoryWriteLock(action, { waitMs = LOCK_WAIT_MS } = {}) {
  await fsp.mkdir(ROOT, { recursive: true })
  const owner = `owner-${process.pid}-${randomUUID()}`
  const prepared = await fsp.mkdtemp(path.join(ROOT, '.memory-write-'))
  let acquired = false
  try {
    await fsp.writeFile(path.join(prepared, owner), '', { mode: 0o600 })
    const deadline = Date.now() + waitMs
    while (!acquired) {
      try {
        await fsp.rename(prepared, WRITE_LOCK)
        acquired = true
      } catch (e) {
        if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e
        if (Date.now() >= deadline) {
          throw Object.assign(new Error(`等待记忆写锁超时 path=${WRITE_LOCK}，请检查持有者进程`), { code: 'ELOCKED' })
        }
        await recoverStaleLock()
        await delay(20)
      }
    }
    // 准备目录可能在等锁期间放了一阵，把时间刷成拿到锁的这一刻，过期判断才是从持锁开始算。
    const acquiredAt = new Date()
    await fsp.utimes(WRITE_LOCK, acquiredAt, acquiredAt).catch((e) => {
      console.error(`[memory] 刷新写锁时间失败 path=${WRITE_LOCK}: ${e.message}`)
    })
    return await action()
  } catch (e) {
    if (e.code !== 'ELOCKED') console.error(`[memory] 记忆写事务失败 owner=${owner}: ${e.message}`)
    throw e
  } finally {
    if (acquired) await releaseLock(owner)
    else await fsp.rm(prepared, { recursive: true, force: true }).catch((e) => {
      console.error(`[memory] 清理待获取写锁失败 path=${prepared}: ${e.message}`)
    })
  }
}

function round(value) {
  return Math.round(value * 1e10) / 1e10
}

// 这一档今天是否还没加满。召回路径用它在拿锁之前跳过不需要写盘的命中。
export function boostDue(mem, step, now = new Date()) {
  return !(mem.boostDay === localDateKey(now) && (Number(mem.boostToday) || 0) >= step)
}

// 同一条记忆在一个本地日内的加分合计不超过当天发生过的最大一档：
// 只被召回是 RECALL_STEP，当天有过强化或合并则补到 REINFORCE_STEP。
// 用户重述一条已有记忆时，这句话自己会先把它召回并加分，随后判重得出的强化只补差额。
// 返回本次实际加分；这一档今天已经加满时返回 null，记录保持不变。
// 到上限后不再增长，但仍刷新 lastSeen，否则还在被使用的记忆会被当成闲置扣分。
function boostConfidence(mem, step, now = new Date()) {
  if (!boostDue(mem, step, now)) return null
  const day = localDateKey(now)
  const gainedToday = mem.boostDay === day ? Number(mem.boostToday) || 0 : 0
  const value = Number(mem.confidence)
  const base = Number.isFinite(value) ? Math.max(0, value) : INITIAL_CONFIDENCE
  const next = Math.min(CONFIDENCE_MAX, round(base + step - gainedToday))
  mem.confidence = next
  mem.boostDay = day
  mem.boostToday = step
  mem.lastSeen = now.toISOString()
  return Math.max(0, round(next - base))
}

// 把本次实际加分挂在返回的记录上给调用方展示。不可枚举，不会被写进记忆文件。
function withGain(mem, gained) {
  return Object.defineProperty(mem, 'gained', { value: gained, configurable: true })
}

// 分组的字面信号，用于交叉校验模型给出的 category。
// 规范/命令语气指向 rule，指称/陈述语气指向 project。
const RULE_MARKERS = [
  /不要|别再|不准|禁止|不许/,
  /必须|一律|始终|统一|务必/,
  /以后|今后|后续|下次|每次/,
  /应该|应当|建议|优先|需要/,
  /不超过|不大于|超过.{0,6}(应|需|要)/,
]
const PROJECT_MARKERS = [
  /链接为|文档为|地址为|参考该文档|见该文档/,
  /核心类|入口方法|接口|字段|参数名|开关为/,
  /PRD|iwiki|doc\.weixin|https?:\/\//,
  /返回|读取逻辑|去重机制|实现逻辑/,
]

// 由正文推断分组。返回 { group, confident }：
// confident=false 表示信号缺失，调用方应要求人工确认而非直接采信。
//
// 实测准确率 22/24（tools 里的历史评测）。两点设计依据：
// 1. 信号冲突时 project 优先——出现文档链接是「待查阅事实」的强证据，
//    只看规范语气会把「…后续可参考该文档」这类事实误判成规则（纠正前仅 16/24）。
// 2. 两种信号都缺失时偏向 rule——风险不对称：
//    漏判规则会让它静默失效且无从察觉；多判规则只是每轮多注入几百字符，
//    而 rule 每次会话都会出现在上下文里，标错了用户一眼就能看见。
export function inferGroup(text) {
  const t = String(text || '')
  const ruleHit = RULE_MARKERS.some((re) => re.test(t))
  const projectHit = PROJECT_MARKERS.some((re) => re.test(t))
  if (projectHit) return { group: 'project', confident: true }
  if (ruleHit) return { group: 'rule', confident: true }
  return { group: 'rule', confident: false }
}

async function writeAtomic(file, body) {
  const tmp = `${file}.tmp.${process.pid}`
  try {
    await fsp.mkdir(ROOT, { recursive: true })
    await fsp.writeFile(tmp, body, 'utf-8')
    await fsp.rename(tmp, file)
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch((cleanupError) => {
      console.error(`[memory] 清理写入临时文件失败 path=${tmp}: ${cleanupError.message}`)
    })
    throw new Error(`写入 ${file} 失败：${e.message}`)
  }
}

// 正文长度不合要求时返回原因，合格返回空串。按字符数算，一个汉字算一个字。
export function memoryTextProblem(text) {
  const length = Array.from(String(text || '').trim()).length
  if (length < MEMORY_TEXT_MIN) return `记忆正文不足 ${MEMORY_TEXT_MIN} 个字（实际 ${length} 个字）`
  if (length > MEMORY_TEXT_MAX) return `记忆正文超过 ${MEMORY_TEXT_MAX} 个字（实际 ${length} 个字）`
  return ''
}

function newId() {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// 新建记忆并落盘。category 必填，不设默认值——
// 它决定「每轮无条件注入」还是「按需召回」，静默默认会让项目事实污染每一轮上下文。
export async function persistMemory({ text, category, evidence = '' }) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('记忆内容为空')
  const problem = memoryTextProblem(clean)
  if (problem) throw new Error(problem)
  const raw = String(category || '').trim().toLowerCase()
  if (!GROUPS.includes(raw)) {
    throw new Error(`category 必须是 ${GROUPS.join(' 或 ')}，收到「${category}」`)
  }
  const group = normalizeGroup(raw)

  const created = new Date()
  const now = created.toISOString()
  const mem = {
    id: newId(),
    text: clean,
    confidence: INITIAL_CONFIDENCE,
    category: group,
    evidence: String(evidence || ''),
    firstSeen: now,
    lastSeen: now,
    deprecated: false,
    createdAt: now,
    // 新建当天视为已强化：创建它的那场对话几乎必然会再次召回它，
    // 不这样算的话新记忆当天就变成 0.55，「零召回最短 60 天遗忘」就数不准了。
    boostDay: localDateKey(created),
    boostToday: REINFORCE_STEP,
  }

  await withMemoryWriteLock(async () => {
    await fsp.appendFile(paths.group(group), `${JSON.stringify(mem)}\n`, 'utf-8')
    await syncSnapshot()
  })

  // 立刻建向量，避免下一轮召回时这条记忆缺席。失败不影响落盘结果。
  try {
    await ensureVectors([mem], await loadIndex())
  } catch (e) {
    console.error(`[memory] 新记忆向量生成失败，将在下次召回时补建: ${e.message}`)
  }
  return mem
}

export async function findMemoryById(id) {
  for (const group of GROUPS) {
    const mems = await readGroup(group)
    const idx = mems.findIndex((m) => m.id === id)
    if (idx >= 0) return { group, mems, idx }
  }
  return null
}

// 强化已有记忆：置信度 +0.1，受每日一次和上限约束；加分后高于 DEPRECATED_AT 才恢复有效状态。
// 返回的记录带 gained，即本次实际加分；category 取记忆实际所在的分组。今天已经加满时不写盘。
export async function reinforceMemory(id) {
  return withMemoryWriteLock(async () => {
    const found = await findMemoryById(id)
    if (!found) throw new Error(`未找到记忆 ${id}`)
    const mem = found.mems[found.idx]
    const gained = boostConfidence(mem, REINFORCE_STEP)
    if (gained === null) return withGain({ ...mem, category: found.group }, 0)
    mem.deprecated = mem.confidence <= DEPRECATED_AT
    const sorted = sortMemories(found.mems)
    await writeAtomic(paths.group(found.group), `${sorted.map((m) => JSON.stringify(m)).join('\n')}\n`)
    await syncSnapshot()
    return withGain({ ...mem, category: found.group }, gained)
  })
}

// 合并进已有记忆：用新正文替换该条，丢掉旧向量并重新编码，再做一次强化。
// 今天已经加满时正文照常替换，只是不再加分。
export async function mergeMemory(id, text) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('合并正文为空')
  const problem = memoryTextProblem(clean)
  if (problem) throw new Error(problem)
  const mem = await withMemoryWriteLock(async () => {
    const found = await findMemoryById(id)
    if (!found) throw new Error(`未找到记忆 ${id}`)
    const updated = found.mems[found.idx]
    updated.text = clean
    const gained = boostConfidence(updated, REINFORCE_STEP) ?? 0
    updated.deprecated = updated.confidence <= DEPRECATED_AT
    const sorted = sortMemories(found.mems)
    await writeAtomic(paths.group(found.group), `${sorted.map((m) => JSON.stringify(m)).join('\n')}\n`)
    await syncSnapshot()
    return withGain({ ...updated, category: found.group }, gained)
  })
  try {
    await refreshVector(mem)
  } catch (e) {
    console.error(`[memory] 合并后重建向量失败 id=${mem.id} text=${clean.slice(0, 80)}: ${e.message}`)
  }
  return mem
}

// 实际注入的召回记忆按 id 去重后 +0.05，同一条记忆每个本地日只加一次，不奖励判重候选或会话初始化。
// 返回本次确实更新过的记录；今天已经加过分的不在其中。
// 写锁被占着时只等 REWARD_LOCK_WAIT_MS，等不到就放弃这次加分并返回空，不让召回内容跟着等。
export async function rewardRecalledMemories(ids) {
  const pending = new Set(ids.filter(Boolean))
  if (pending.size === 0) return []
  const reward = async () => {
    const updated = []
    const now = new Date()
    for (const group of GROUPS) {
      const mems = await readGroup(group)
      let dirty = false
      for (const mem of mems) {
        if (!pending.has(mem.id) || !isMemoryActive(mem)) continue
        pending.delete(mem.id)
        if (boostConfidence(mem, RECALL_STEP, now) === null) continue
        updated.push(mem)
        dirty = true
      }
      if (dirty) {
        await writeAtomic(paths.group(group), `${sortMemories(mems).map((m) => JSON.stringify(m)).join('\n')}\n`)
      }
    }
    if (updated.length > 0) await syncSnapshot()
    return updated
  }
  try {
    return await withMemoryWriteLock(reward, { waitMs: REWARD_LOCK_WAIT_MS })
  } catch (e) {
    if (e.code !== 'ELOCKED') throw e
    console.error(`[memory] 写锁被占用，放弃本次召回加分 ids=${[...pending].join(',')}`)
    return []
  }
}

function localDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

async function lastDecayDate() {
  try {
    const state = JSON.parse(await fsp.readFile(paths.decayState, 'utf8'))
    return typeof state?.lastRunDate === 'string' ? state.lastRunDate : ''
  } catch (e) {
    if (e.code === 'ENOENT') return ''
    console.error(`[memory] 读取每日衰减状态失败 path=${paths.decayState}: ${e.message}`)
    if (e instanceof SyntaxError) return ''
    throw e
  }
}

// 仅在当天首次会话开始时检查；闲置满 decayDays 天实际扣一次0.05并重置时间，不追补历史周期。
// 扣分后不高于 DEPRECATED_AT 即废弃。超过上限的值（上限引入前的历史数据，或旧进程写入的）在这里压回上限。
export async function decayMemoriesOncePerDay({ afterDailyScan } = {}) {
  if (await lastDecayDate() === localDateKey(new Date())) return 0
  const { decayDays } = await loadSettings()
  return withMemoryWriteLock(async () => {
    const now = new Date()
    const day = localDateKey(now)
    if (await lastDecayDate() === day) return 0
    const timestamp = now.toISOString()
    let changed = 0
    for (const group of GROUPS) {
      const mems = await readGroup(group, { strict: true })
      let dirty = false
      for (const mem of mems) {
        if (mem.deprecated) continue
        let confidence = Number(mem.confidence)
        if (!Number.isFinite(confidence)) {
          console.error(`[memory] 每日衰减跳过非法置信度 group=${group} id=${mem.id} confidence=${mem.confidence}`)
          continue
        }
        const lastSeen = Date.parse(mem.lastSeen || mem.createdAt || '')
        let updated = false
        if (confidence > CONFIDENCE_MAX) {
          confidence = CONFIDENCE_MAX
          mem.confidence = confidence
          updated = true
        }
        if (!Number.isFinite(lastSeen)) {
          console.error(`[memory] 每日衰减跳过非法时间戳 group=${group} id=${mem.id} lastSeen=${mem.lastSeen} createdAt=${mem.createdAt}`)
        } else if (now.getTime() - lastSeen >= decayDays * 86400000) {
          mem.confidence = Math.max(0, round(confidence - DECAY_STEP))
          mem.lastSeen = timestamp
          updated = true
        }
        if (Number(mem.confidence) <= DEPRECATED_AT) {
          mem.deprecated = true
          updated = true
        }
        if (updated) {
          dirty = true
          changed++
        }
      }
      if (dirty) {
        await writeAtomic(paths.group(group), `${sortMemories(mems).map((mem) => JSON.stringify(mem)).join('\n')}\n`)
      }
    }
    if (changed > 0) await syncSnapshot()
    await purgeExpiredTrash(now)
    if (typeof afterDailyScan === 'function') await afterDailyScan({ now, day, timestamp })
    await writeAtomic(paths.decayState, `${JSON.stringify({ lastRunDate: day, lastRunAt: timestamp })}\n`)
    return changed
  })
}

// —— 用户主动整理记忆：删除、合并、改写，以及回收站 ——
// 这几个操作只在用户明确要求时由 memory_update 调用，和自动沉淀互不相干：不加分，也不刷新衰减时间。
// 删除和被合并掉的记忆先进回收站，保留 TRASH_RETENTION_DAYS 天，期间可以用命令行恢复。

async function saveGroup(group, mems) {
  await writeAtomic(paths.group(group), `${sortMemories(mems).map((m) => JSON.stringify(m)).join('\n')}\n`)
}

async function readTrash() {
  let content = ''
  try {
    content = await fsp.readFile(paths.trash, 'utf-8')
  } catch (e) {
    if (e.code === 'ENOENT') return []
    throw new Error(`读取回收站失败 path=${paths.trash}: ${e.message}`)
  }
  const items = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    try {
      items.push(JSON.parse(line))
    } catch (e) {
      console.error(`[memory] 回收站里有一行无法解析，已跳过 path=${paths.trash}: ${e.message}`)
    }
  }
  return items
}

async function writeTrash(items) {
  await writeAtomic(paths.trash, items.length > 0 ? `${items.map((item) => JSON.stringify(item)).join('\n')}\n` : '')
}

function cleanText(text) {
  const clean = String(text || '').trim()
  const problem = memoryTextProblem(clean)
  if (problem) throw new Error(problem)
  return clean
}

// 向量不在写锁里维护（和其它写入一样），失败只记日志：下次召回会按正文补齐缺的向量，多余的不影响打分。
async function dropVectorsQuietly(ids) {
  try {
    await dropVectors(ids)
  } catch (e) {
    console.error(`[memory] 删除向量失败 ids=${ids.join(',')}: ${e.message}`)
  }
}

async function refreshVectorQuietly(mem) {
  try {
    await refreshVector(mem)
  } catch (e) {
    console.error(`[memory] 重算向量失败 id=${mem.id} text=${String(mem.text).slice(0, 80)}: ${e.message}`)
  }
}

// 删除一条或多条记忆，一起放进回收站。不存在的 id 跳过，其余照常删除；一条都没找到时报错，不改动任何文件。
// 返回 { removed, missing }：removed 是被删的记录，按传入顺序排列；missing 是跳过的 id。
export async function deleteMemories(ids, { now = new Date() } = {}) {
  const wanted = [...new Set((ids || []).map((id) => String(id || '').trim()).filter(Boolean))]
  if (wanted.length === 0) throw new Error('缺少 id')
  const result = await withMemoryWriteLock(async () => {
    const groups = {}
    for (const group of GROUPS) groups[group] = await readGroup(group)
    const removed = []
    const missing = []
    for (const id of wanted) {
      const group = GROUPS.find((g) => groups[g].some((m) => m.id === id))
      if (!group) {
        missing.push(id)
        continue
      }
      const [mem] = groups[group].splice(groups[group].findIndex((m) => m.id === id), 1)
      removed.push({ ...mem, category: group })
    }
    if (removed.length === 0) throw new Error(`未找到记忆 ${missing.join('、')}`)
    // 先进回收站再改分组文件：中途失败时这些记忆最多在两处各有一份，不会凭空消失。
    const trash = await readTrash()
    for (const mem of removed) trash.push({ ...mem, deletedAt: now.toISOString(), deletedReason: 'delete' })
    await writeTrash(trash)
    for (const group of new Set(removed.map((m) => m.category))) await saveGroup(group, groups[group])
    await syncSnapshot()
    return { removed, missing }
  })
  await dropVectorsQuietly(result.removed.map((m) => m.id))
  return result
}

// 合并两条记忆：keepId 保留，正文换成 text；dropId 并掉进回收站。
// 置信度取两条中较高的，最近使用时间取较晚的，首次出现时间取较早的；分组沿用 keepId 的。
export async function combineMemories(keepId, dropId, text, { now = new Date() } = {}) {
  const clean = cleanText(text)
  if (!keepId || !dropId) throw new Error('合并需要两条记忆的 id')
  if (keepId === dropId) throw new Error('合并的两条记忆不能是同一条')
  const result = await withMemoryWriteLock(async () => {
    const keepFound = await findMemoryById(keepId)
    if (!keepFound) throw new Error(`未找到记忆 ${keepId}`)
    const dropFound = await findMemoryById(dropId)
    if (!dropFound) throw new Error(`未找到记忆 ${dropId}`)
    const keep = keepFound.mems[keepFound.idx]
    const drop = dropFound.mems[dropFound.idx]
    const before = { keepText: keep.text, dropText: drop.text, keepConfidence: keep.confidence, dropConfidence: drop.confidence }
    const confidences = [Number(keep.confidence), Number(drop.confidence)].filter(Number.isFinite)
    keep.text = clean
    if (confidences.length > 0) keep.confidence = Math.max(...confidences)
    const later = [keep.lastSeen, drop.lastSeen].filter(Boolean).sort().pop()
    if (later) keep.lastSeen = later
    const earlier = [keep.firstSeen, drop.firstSeen].filter(Boolean).sort()[0]
    if (earlier) keep.firstSeen = earlier
    keep.deprecated = Number(keep.confidence) <= DEPRECATED_AT
    const trash = await readTrash()
    trash.push({ ...drop, category: dropFound.group, deletedAt: now.toISOString(), deletedReason: 'merge', mergedInto: keepId })
    await writeTrash(trash)
    // 两条在同一组时，findMemoryById 读出的是两份独立的数组，以保留那份为准，从里面去掉被并掉的。
    const keepMems = keepFound.mems.filter((m) => m.id !== dropId)
    await saveGroup(keepFound.group, keepMems)
    if (dropFound.group !== keepFound.group) {
      dropFound.mems.splice(dropFound.idx, 1)
      await saveGroup(dropFound.group, dropFound.mems)
    }
    await syncSnapshot()
    return { mem: { ...keep, category: keepFound.group }, before }
  })
  await refreshVectorQuietly(result.mem)
  await dropVectorsQuietly([dropId])
  return result
}

// 改写一条记忆的正文。置信度不变：这是纠错，不是又用到了一次。
export async function replaceMemoryText(id, text) {
  const clean = cleanText(text)
  const result = await withMemoryWriteLock(async () => {
    const found = await findMemoryById(id)
    if (!found) throw new Error(`未找到记忆 ${id}`)
    const mem = found.mems[found.idx]
    const previous = mem.text
    mem.text = clean
    await saveGroup(found.group, found.mems)
    await syncSnapshot()
    return { mem: { ...mem, category: found.group }, previous }
  })
  await refreshVectorQuietly(result.mem)
  return result
}

// 回收站里的条目，最近删掉的在前。
export async function listTrash() {
  return (await readTrash()).sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')))
}

// 从回收站恢复一条，放回它原来的分组，重新建向量。
export async function restoreMemory(id) {
  const mem = await withMemoryWriteLock(async () => {
    const trash = await readTrash()
    const idx = trash.findIndex((item) => item.id === id)
    if (idx < 0) throw new Error(`回收站里没有记忆 ${id}`)
    if (await findMemoryById(id)) throw new Error(`记忆 ${id} 已经在库里，不用恢复`)
    const [item] = trash.splice(idx, 1)
    const { deletedAt, deletedReason, mergedInto, ...restored } = item
    const group = normalizeGroup(restored.category)
    restored.category = group
    const mems = await readGroup(group)
    mems.push(restored)
    await saveGroup(group, mems)
    await writeTrash(trash)
    await syncSnapshot()
    return restored
  })
  try {
    await ensureVectors([mem], await loadIndex())
  } catch (e) {
    console.error(`[memory] 恢复后建向量失败，将在下次召回时补建 id=${mem.id}: ${e.message}`)
  }
  return mem
}

// 清掉回收站里超过保留期的条目。只在每日维护里调用，调用时已经持有写锁。
async function purgeExpiredTrash(now) {
  let trash
  try {
    trash = await readTrash()
  } catch (e) {
    console.error(`[memory] 每日维护读取回收站失败，本次不清理: ${e.message}`)
    return 0
  }
  const cutoff = now.getTime() - TRASH_RETENTION_DAYS * 86400000
  const kept = trash.filter((item) => {
    const at = Date.parse(item.deletedAt || '')
    return !Number.isFinite(at) || at >= cutoff
  })
  const purged = trash.length - kept.length
  if (purged > 0) {
    await writeTrash(kept)
    console.error(`[memory] 回收站清掉 ${purged} 条超过 ${TRASH_RETENTION_DAYS} 天的记忆`)
  }
  return purged
}

