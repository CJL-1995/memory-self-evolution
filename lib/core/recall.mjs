// 语义召回：向量索引的读写与中心化打分。平台无关，供各宿主共用。

import fsp from 'node:fs/promises'
import { EMBED_VERSION, centerTo, centroid, cosine, docText, embed } from '../embedding.js'
import { RECALL_KEEP_RATIO, ROOT, paths } from './config.mjs'
import { loadSettings } from './settings.mjs'
import { isMemoryActive } from './store.mjs'

// 索引里存的是原始向量，中心化在检索时按当前语料实时计算——
// 这样新增记忆改变语料均值时不需要重写整个索引。
export async function loadIndex() {
  const index = new Map()
  let content = null
  try {
    content = await fsp.readFile(paths.embeddings, 'utf-8')
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[memory] 读取向量索引失败: ${e.message}`)
    return index
  }
  let stale = 0
  for (const line of content.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const rec = JSON.parse(t)
      if (!rec || !rec.id || !Array.isArray(rec.v)) continue
      // 换模型或改编码后维度可能碰巧相同（nomic 与 bge-base-zh 都是 768 维），
      // 混用不会报错只会让相似度静默失真，必须靠版本号拦住。
      if (rec.ev !== EMBED_VERSION) {
        stale++
        continue
      }
      index.set(rec.id, rec.v)
    } catch (e) {
      console.error(`[memory] 跳过向量索引中无法解析的行: ${e.message}`)
    }
  }
  if (stale > 0) console.error(`[memory] 丢弃 ${stale} 条旧版本向量，将按当前编码重建`)
  return index
}

// 原子写：先写临时文件再 rename，避免多个短命进程并发写坏索引。
async function saveIndex(index) {
  const tmp = `${paths.embeddings}.tmp.${process.pid}`
  const body = Array.from(index, ([id, v]) => JSON.stringify({ id, v, ev: EMBED_VERSION })).join('\n')
  try {
    await fsp.mkdir(ROOT, { recursive: true })
    await fsp.writeFile(tmp, body, 'utf-8')
    await fsp.rename(tmp, paths.embeddings)
  } catch (e) {
    console.error(`[memory] 写入向量索引失败，下次调用会重建: ${e.message}`)
    await fsp.rm(tmp, { force: true }).catch(() => {})
  }
}

// 补齐缺失向量并落盘。首次运行或新增记忆后触发，命中缓存时不产生任何写入。
export async function ensureVectors(memories, index) {
  const missing = memories.filter((m) => !index.has(m.id))
  if (missing.length === 0) return index
  const vecs = await embed(missing.map(docText))
  missing.forEach((m, i) => {
    if (vecs[i]) index.set(m.id, vecs[i])
  })
  await saveIndex(index)
  return index
}

// 正文变了必须丢掉旧向量再编码。索引按 id 去重，不删的话 ensureVectors 会跳过，检索继续用旧语义。
export async function refreshVector(memory) {
  const index = await loadIndex()
  index.delete(memory.id)
  await saveIndex(index)
  await ensureVectors([memory], index)
}

// 门控本身：输入是按分数降序的 [{ memory, score }]，不读配置、不碰索引。
// recall() 和 tools/verify-gate.mjs 的阈值扫描共用这一个函数，扫描出来的数字才等于线上行为。
export function applyGate(ranked, { topK, minScore, minMargin }) {
  const top = ranked[0]
  if (!top) return []
  const scoreGateOn = minScore >= 0
  const marginGateOn = minMargin >= 0
  if (scoreGateOn && top.score < minScore) return []
  if (marginGateOn && top.score - (ranked[1] ? ranked[1].score : 0) < minMargin) return []

  // 门控全关时不再收窄，否则纯 Top-K 拿不到 K 条。
  if (!scoreGateOn && !marginGateOn) return ranked.slice(0, topK)
  const relative = top.score * RECALL_KEEP_RATIO
  const floor = scoreGateOn ? Math.max(minScore, relative) : relative
  return ranked.filter((x) => x.score >= floor).slice(0, topK)
}

// 按 query 召回记忆，返回 [{ memory, score }] 降序。
// score 为中心化后的余弦，无关内容落在 0 附近。
//
// 门控：top1 需达到绝对下限，可选再要求对第 2 名的领先幅度；不满足则视为
// 本轮没有明确相关项返回空。两项阈值都可在 config.json 里设为 -1 单独关闭。
// 通过后保留线取 max(绝对下限, top1 × RECALL_KEEP_RATIO)，再截到 topK。
// 绝对下限作用在每一条上：弱命中时比例线会落到下限之下，单用比例线会把尾巴带进来；
// 强命中时比例线更高，单用绝对下限会把重叠区的边缘条目带进来。
// 传 gate:false 可整体跳过门控拿原始排序，判重与调参用。
export async function recall(queryTexts, memories, options = {}) {
  const settings = await loadSettings()
  const topK = options.topK ?? settings.recallTopK
  const minScore = options.minScore ?? settings.recallMinScore
  const minMargin = options.minMargin ?? settings.recallMinMargin
  const gate = options.gate !== false
  const queries = (Array.isArray(queryTexts) ? queryTexts : [queryTexts]).filter((t) => String(t || '').trim())
  const active = memories.filter(isMemoryActive)
  if (queries.length === 0 || active.length === 0) return []

  const index = await ensureVectors(active, await loadIndex())
  const pool = active.filter((m) => index.has(m.id))
  if (pool.length === 0) return []

  const mu = centroid(pool.map((m) => index.get(m.id)))
  const qVecs = (await embed(queries)).map((q) => centerTo(q, mu))

  const scored = pool.map((m) => {
    const cv = centerTo(index.get(m.id), mu)
    let best = -Infinity
    for (const q of qVecs) {
      const s = cosine(q, cv)
      if (s > best) best = s
    }
    return { memory: m, score: best }
  })

  const ranked = scored.sort((a, b) => b.score - a.score)
  if (!gate) return ranked.slice(0, topK)
  return applyGate(ranked, { topK, minScore, minMargin })
}
