// 固定的背景均值：一批通用陈述句的向量均值，打分时从 query 和记忆两侧同时减掉它。
//
// 为什么要减：这个模型给出的向量有一大块公共成分，互不相关的两条记忆原始余弦也有 0.5 左右，
// 分数都挤在高位，无关输入能拿到 0.6，没有可用的绝对阈值。减掉均值就是去掉这块公共成分。
// 为什么是固定的：以前减的是当前记忆池的均值，它随池子变——只有 1 条记忆时均值就是它自己，
// 减完是零向量，永远召不回；池子越大，同一个阈值放行的无关输入越多。固定的均值没有这两个问题。
//
// 由 tools/build-background.mjs 从 tools/background-sentences.json 生成，换模型或改编码后要重新生成。

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { EMBED_VERSION } from '../embedding.js'

const FILE = fileURLToPath(new URL('../background-mean.json', import.meta.url))

let cached = null

export function parseBackgroundMean(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new Error(`背景均值解析失败 path=${FILE}: ${e.message}`)
  }
  if (!Array.isArray(data?.mean) || data.mean.length === 0 || !data.mean.every(Number.isFinite)) {
    throw new Error(`背景均值格式无效 path=${FILE}`)
  }
  // 换模型或改编码后旧的背景均值不再适用，和向量索引一样靠版本号拦住，否则分数会静默失真。
  if (data.ev !== EMBED_VERSION) {
    throw new Error(`背景均值的编码版本 ${data.ev} 与当前 ${EMBED_VERSION} 不一致，请运行 npm run build-background 重新生成`)
  }
  return data.mean
}

export function loadBackgroundMean() {
  if (cached) return cached
  let text
  try {
    text = fs.readFileSync(FILE, 'utf8')
  } catch (e) {
    throw new Error(`读取背景均值失败 path=${FILE}: ${e.message}`)
  }
  cached = parseBackgroundMean(text)
  return cached
}
