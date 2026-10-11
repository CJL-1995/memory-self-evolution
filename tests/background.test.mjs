import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { EMBED_VERSION, MODEL_ID } from '../lib/embedding.js'
import { loadBackgroundMean, parseBackgroundMean } from '../lib/core/background.mjs'

const read = async relative => JSON.parse(await fsp.readFile(new URL(relative, import.meta.url), 'utf8'))

test('仓库里的背景均值与当前模型、编码版本和句子清单一致', async () => {
  const data = await read('../lib/background-mean.json')
  const sentences = await read('../tools/background-sentences.json')
  assert.equal(data.ev, EMBED_VERSION)
  assert.equal(data.model, MODEL_ID)
  assert.equal(data.count, sentences.length)
  assert.equal(data.mean.length, 768)
  assert.ok(data.mean.every(Number.isFinite))
  assert.equal(new Set(sentences).size, sentences.length)
  assert.deepEqual(loadBackgroundMean(), data.mean)
})

test('背景均值的编码版本不一致或内容损坏时报错，不静默使用', () => {
  const ok = JSON.stringify({ ev: EMBED_VERSION, mean: [0.1, -0.2] })
  assert.deepEqual(parseBackgroundMean(ok), [0.1, -0.2])
  assert.throws(() => parseBackgroundMean(JSON.stringify({ ev: EMBED_VERSION + 1, mean: [0.1] })), /不一致.*build-background/)
  assert.throws(() => parseBackgroundMean(JSON.stringify({ ev: EMBED_VERSION, mean: [] })), /格式无效/)
  assert.throws(() => parseBackgroundMean(JSON.stringify({ ev: EMBED_VERSION, mean: [0.1, null] })), /格式无效/)
  assert.throws(() => parseBackgroundMean('{oops'), /解析失败/)
})
