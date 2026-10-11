#!/usr/bin/env node
// 按当前模型重建 ~/.memory-self-evolution/embeddings.jsonl。
// 换 embedding 模型后插件本来会在下次 analyzeSession 自动重建，
// 但那之前有一轮会降级成「最近 N 条」兜底；离线预建可以免掉这一轮。
// 用法：node tools/rebuild-index.mjs

import fs from 'node:fs'
import path from 'node:path'
import { docText, embed, EMBED_VERSION } from '../lib/embedding.js'
import { paths } from '../lib/core/config.mjs'
import { readAllMemories } from '../lib/core/store.mjs'

const INDEX_FILE = paths.embeddings

// 含已废弃条目：它们不注入但仍可被 memory_read 查阅，向量缺失会导致召回时反复重建
const memories = await readAllMemories({ includeDeprecated: true })

if (memories.length === 0) {
  console.error('未找到任何记忆，终止重建以免清空索引')
  process.exit(1)
}

if (fs.existsSync(INDEX_FILE)) {
  const backup = `${INDEX_FILE}.bak.${Date.now()}`
  fs.copyFileSync(INDEX_FILE, backup)
  console.log(`已备份旧索引 -> ${path.basename(backup)}`)
}

// 索引存原始向量，减背景均值在检索时做（与 recall.mjs 一致）
// 编码文本统一走 docText，与所有写索引的调用方保持一致
const vecs = await embed(memories.map(docText))
const lines = memories.map((m, i) => JSON.stringify({ id: m.id, v: vecs[i], ev: EMBED_VERSION }))
fs.writeFileSync(INDEX_FILE, lines.join('\n'), 'utf-8')

console.log(`已重建 ${lines.length} 条向量，EMBED_VERSION=${EMBED_VERSION}，维度 ${vecs[0].length}`)
