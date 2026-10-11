#!/usr/bin/env node
// 按当前模型重建 ~/.memory-self-evolution/embeddings.jsonl。
// 换模型或改编码（递增 EMBED_VERSION）后，旧向量在加载时被丢弃，下一次召回会当场补建全部向量。
// 那一次发生在每轮输入的 hook 里，要现算全部记忆的向量，记忆越多越慢；离线预建可以免掉。
// 手动改过记忆正文后也要跑：索引按 id 缓存，正文变了不会自己重新编码。
// 用法：node tools/rebuild-index.mjs

import fs from 'node:fs'
import path from 'node:path'
import { docText, embed, EMBED_VERSION } from '../lib/embedding.js'
import { paths } from '../lib/core/config.mjs'
import { readAllMemories } from '../lib/core/store.mjs'

const INDEX_FILE = paths.embeddings

// 含已废弃条目：召回不用它们的向量，但废弃记忆被强化或合并后可以恢复，预先建好省得恢复后那一轮现算
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
