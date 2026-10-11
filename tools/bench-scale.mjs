#!/usr/bin/env node
// 召回在记忆规模膨胀后的耗时构成。短命 CLI 进程每轮都要把索引从零加载一遍，
// 因此除了余弦计算，还必须量「读盘 + 解析」和「中心化」这两块。
// 用法：node tools/bench-scale.mjs

import { createReadStream } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const DIM = 768
const SIZES = [100, 1000, 10000, 50000]
// 读盘一列在 jsonl 下改为流式解析，否则 5 万条会直接抛 RangeError
const TMP = path.join(os.tmpdir(), 'memory-self-evolution-scale')

const ms = (t) => `${t.toFixed(1)}ms`
const now = () => performance.now()

function randomUnit(dim) {
  const v = new Float64Array(dim)
  let s = 0
  for (let i = 0; i < dim; i++) {
    v[i] = Math.random() * 2 - 1
    s += v[i] * v[i]
  }
  const n = Math.sqrt(s) || 1
  for (let i = 0; i < dim; i++) v[i] /= n
  return Array.from(v)
}

// 当前实现：jsonl，每行 { id, v: number[], ev }
// 分批落盘而非一次 join：整份 join 在约 3.5 万条时会超出 V8 字符串长度上限抛 RangeError。
async function writeJsonl(file, n) {
  const fh = await fsp.open(file, 'w')
  try {
    let batch = []
    for (let i = 0; i < n; i++) {
      batch.push(JSON.stringify({ id: `mem-${i}`, v: randomUnit(DIM), ev: 2 }))
      if (batch.length >= 500) {
        await fh.write(`${batch.join('\n')}\n`)
        batch = []
      }
    }
    if (batch.length) await fh.write(batch.join('\n'))
  } finally {
    await fh.close()
  }
}

// 备选实现：定长 float32 二进制 + 单独的 id 清单
async function writeBinary(file, n) {
  const buf = Buffer.allocUnsafe(n * DIM * 4)
  for (let i = 0; i < n; i++) {
    const v = randomUnit(DIM)
    for (let d = 0; d < DIM; d++) buf.writeFloatLE(v[d], (i * DIM + d) * 4)
  }
  await fsp.writeFile(file, buf)
}

// 流式逐行解析。不能用 readFile(file,'utf-8')：整份读成字符串在约 3.5 万条时
// 会超出 V8 字符串长度上限抛 RangeError，这是当前实现的硬上限。
async function loadJsonl(file) {
  const out = []
  const stream = createReadStream(file, { encoding: 'utf-8' })
  let tail = ''
  for await (const chunk of stream) {
    const parts = (tail + chunk).split('\n')
    tail = parts.pop()
    for (const line of parts) {
      if (!line) continue
      const rec = JSON.parse(line)
      if (rec.ev === 2) out.push(rec.v)
    }
  }
  if (tail.trim()) {
    const rec = JSON.parse(tail)
    if (rec.ev === 2) out.push(rec.v)
  }
  return out
}

async function loadBinary(file, n) {
  const buf = await fsp.readFile(file)
  // 一次性视图，不做逐元素拷贝
  return new Float32Array(buf.buffer, buf.byteOffset, n * DIM)
}

function centroidOf(vecs) {
  const c = new Float64Array(DIM)
  for (const v of vecs) for (let i = 0; i < DIM; i++) c[i] += v[i]
  for (let i = 0; i < DIM; i++) c[i] /= vecs.length
  return c
}

// 减均值 + 余弦：逐条减均值、归一化、点积。recall.mjs 现在减的是固定背景均值，不再每次算池均值
function scoreAll(vecs, mu, q) {
  let best = -Infinity
  for (const v of vecs) {
    let dot = 0
    let norm = 0
    for (let i = 0; i < DIM; i++) {
      const x = v[i] - mu[i]
      dot += q[i] * x
      norm += x * x
    }
    const s = dot / (Math.sqrt(norm) || 1)
    if (s > best) best = s
  }
  return best
}

await fsp.mkdir(TMP, { recursive: true })
console.log(`向量维度 ${DIM}，每组测 1 次查询（短命进程的真实形态：每轮都从零加载）\n`)
console.log('条数'.padStart(7), 'jsonl体积'.padStart(11), '读盘+解析'.padStart(11), '算均值'.padStart(9), '中心化+余弦'.padStart(12), '合计'.padStart(9), '│', '二进制读盘'.padStart(11), '二进制合计'.padStart(11))
console.log('-'.repeat(108))

for (const n of SIZES) {
  const jf = path.join(TMP, `idx-${n}.jsonl`)
  const bf = path.join(TMP, `idx-${n}.bin`)
  await writeJsonl(jf, n)
  await writeBinary(bf, n)
  const size = (await fsp.stat(jf)).size
  const q = randomUnit(DIM)

  let t = now()
  const vecs = await loadJsonl(jf)
  const loadMs = now() - t

  t = now()
  const mu = centroidOf(vecs)
  const muMs = now() - t

  t = now()
  scoreAll(vecs, mu, q)
  const scoreMs = now() - t

  t = now()
  const flat = await loadBinary(bf, n)
  const binLoadMs = now() - t

  // 二进制布局下把每条向量包成视图再走同样的打分逻辑
  t = now()
  const views = []
  for (let i = 0; i < n; i++) views.push(flat.subarray(i * DIM, (i + 1) * DIM))
  const mu2 = centroidOf(views)
  scoreAll(views, mu2, q)
  const binComputeMs = now() - t

  console.log(
    String(n).padStart(7),
    `${(size / 1024 / 1024).toFixed(1)}MB`.padStart(11),
    ms(loadMs).padStart(11),
    ms(muMs).padStart(9),
    ms(scoreMs).padStart(12),
    ms(loadMs + muMs + scoreMs).padStart(9),
    '│',
    ms(binLoadMs).padStart(11),
    ms(binLoadMs + binComputeMs).padStart(11)
  )
  await fsp.rm(jf, { force: true })
  await fsp.rm(bf, { force: true })
}

await fsp.rm(TMP, { recursive: true, force: true })
