// 本地轻量 embedding 模型：把文本映射成语义向量，用于记忆的语义召回（替代 Jaccard 粗筛）。
// 注意：transformers 用动态 import 懒加载——未安装/下载失败时只影响本模块，不会拖垮整个插件。

// 中文记忆检索实测（24 条真实记忆 / 19 条 query；评测脚本和数据依赖个人记忆，没有入库）：
// bge-base-zh MRR 0.965，nomic-embed-text-v1.5 仅 0.572，且体积、冷启动、内存三项均更优。
const MODEL_ID = 'Xenova/bge-base-zh-v1.5'

// 向量存储格式版本。换模型或改编码方式后必须递增，
// 否则 embeddings.jsonl 里的旧向量会与新向量混用，召回质量比不换更差。
//   2 = bge-base-zh，仅编码记忆正文
//   3 = bge-base-zh，编码「标签：正文」
//   4 = bge-base-zh，仅编码正文（标签概念已移除）
export const EMBED_VERSION = 4

// 入库侧的编码文本。必须与 EMBED_VERSION 同步变更，且所有写索引的地方都走这里，
// 否则不同调用方会用不同编码写进同一份索引，导致相似度静默失真。
//
// 只编码正文，不拼任何前缀。理由是判重必须对称：
// 判重是在比较两条记忆，而新记忆在分组确定前没有前缀可拼。若一侧带前缀另一侧不带，
// 多出的前缀 token 在候选侧没有对应物，会系统性稀释相似度。
// 实测（7 条改写版 + 5 条真新记忆；评测脚本和数据没有入库）：
//   候选原文 vs「标签：正文」 命中 6/7，真重复最低分 0.325 < 真新最高分 0.408，两类倒挂
//   两侧都用纯正文          命中 7/7，真重复最低分 0.439 > 真新最高分 0.336，存在干净阈值
// 代价是正文必须自包含——正文只写「tab 的接入文档链接为…」而不说主题的记忆召不回来，
// 但那是记忆本身写得不好，拼前缀只是掩盖问题。
export function docText(memory) {
  return String(memory.text || '')
}

let extractor = null
let loadingPromise = null

// 安装脚本在注册 hook 之前调用，把模型权重下载到本地缓存。
// 运行时召回仍走这里：缓存已在时不会重复下载。
export async function downloadModel() {
  await ensureModel()
}

async function ensureModel() {
  if (extractor) return extractor
  if (loadingPromise) return loadingPromise
  loadingPromise = (async () => {
    const { pipeline } = await import('@huggingface/transformers')
    const p = await pipeline('feature-extraction', MODEL_ID, { dtype: 'q8' })
    extractor = p
    return p
  })()
  try {
    return await loadingPromise
  } finally {
    loadingPromise = null
  }
}

// L2 归一化：归一化后两向量的点积即余弦相似度。
function norm(v) {
  let s = 0
  for (const x of v) s += x * x
  const l = Math.sqrt(s) || 1
  const out = new Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] / l
  return out
}

// 批量文本 -> 向量数组（number[][]）。懒加载模型，失败时抛错由调用方降级。
export async function embed(texts) {
  const model = await ensureModel()
  const list = Array.isArray(texts) ? texts : [texts]
  const out = await model(list, { pooling: 'mean', normalize: true })
  let vecs
  if (out && typeof out.tolist === 'function') {
    const arr = out.tolist()
    vecs = Array.isArray(arr[0]) ? arr : [arr]
  } else if (Array.isArray(out)) {
    vecs = out.map((t) => (t && t.data ? Array.from(t.data) : Array.from(t)))
  } else if (out && out.data) {
    vecs = [Array.from(out.data)]
  } else {
    throw new Error('embedding: unexpected output shape')
  }
  return vecs.map(norm)
}

// 语料均值向量，用于中心化；语料为空时返回 null 表示不做中心化。
export function centroid(vecs) {
  if (!vecs || vecs.length === 0) return null
  const d = vecs[0].length
  const c = new Array(d).fill(0)
  for (const v of vecs) {
    for (let i = 0; i < d; i++) c[i] += v[i]
  }
  for (let i = 0; i < d; i++) c[i] /= vecs.length
  return c
}

// 减去语料均值再归一化，消除 BERT 类模型的支配方向。
// 实测无关文本的余弦从 0.51 回落到 -0.07，同/跨主题间距从 0.03 拉到 0.18，
// 排序质量不变但分数尺度变得可用（此前只能靠 top-k 排序，无法用绝对阈值）。
export function centerTo(v, mu) {
  if (!mu) return v
  const out = new Array(v.length)
  for (let i = 0; i < v.length; i++) out[i] = v[i] - mu[i]
  return norm(out)
}

// 余弦相似度（入参需已归一化，否则结果不准确）。
export function cosine(a, b) {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}
