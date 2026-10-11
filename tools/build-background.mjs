#!/usr/bin/env node
// 生成 lib/background-mean.json：把 tools/background-sentences.json 里的通用陈述句逐条编码后取均值。
// 换 embedding 模型或改编码方式（EMBED_VERSION 变化）后必须重跑，否则加载时会报版本不一致。
//
// 句子要和记忆同体裁：一句话的规则或项目事实，内容通用、不指向任何人的真实记忆。
// 实测体裁不对（比如换成问句）时相关召回会明显下降；换掉其中一半句子，相关召回基本不变，
// 但无关输入的放行数会波动，所以改动句子后要用 tools/verify-gate.mjs 重新看一遍阈值。
//
// 用法：node tools/build-background.mjs

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EMBED_VERSION, MODEL_ID, centroid, embed } from '../lib/embedding.js'

const SENTENCES = fileURLToPath(new URL('./background-sentences.json', import.meta.url))
const OUTPUT = fileURLToPath(new URL('../lib/background-mean.json', import.meta.url))

const sentences = JSON.parse(fs.readFileSync(SENTENCES, 'utf8'))
if (!Array.isArray(sentences) || sentences.length === 0 || !sentences.every((s) => typeof s === 'string' && s.trim())) {
  console.error(`${SENTENCES} 必须是非空的字符串数组`)
  process.exit(1)
}

// 逐条编码，和 hook 里编码单条输入的方式一致；批量编码会让向量有细微偏差。
const vectors = []
for (const sentence of sentences) vectors.push((await embed([sentence]))[0])
const mean = centroid(vectors).map((x) => Number(x.toFixed(6)))

fs.writeFileSync(OUTPUT, `${JSON.stringify({ model: MODEL_ID, ev: EMBED_VERSION, count: sentences.length, mean })}\n`)
console.log(`已生成 ${OUTPUT}：${sentences.length} 句，${mean.length} 维，EMBED_VERSION=${EMBED_VERSION}`)
