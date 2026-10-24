import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import vm from 'node:vm'

const repo = fileURLToPath(new URL('../../', import.meta.url))

export async function createMemoryHarness(t, options = {}) {
  const home = options.home || await fsp.mkdtemp(path.join(repo, 'tests', '.memory-test-'))
  if (!options.home) t.after(() => fsp.rm(home, { recursive: true, force: true }))
  const root = path.join(home, '.memory-self-evolution')
  await fsp.mkdir(root, { recursive: true })
  const errors = []
  const state = { hits: [], recallError: null, writeError: false, failRenameTo: '', failRead: '', reads: new Map(), embeddedTexts: [], vectorRefreshes: 0, droppedVectors: [], spawns: [], spawnExitCode: 0, fetch: null }
  const clock = { now: options.now ? new Date(options.now).getTime() : null }
  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now ?? Date.now()])) }
    static now() { return clock.now ?? Date.now() }
  }
  // 默认是一台配好旁路接口的机器。要测没配齐的情况，把 settings.sideApiBase 清空。
  const settings = { enabled: true, confirm: true, recallTopK: 3, recallMinScore: 0.22, recallMinScoreProject: 0.29, recallMinMargin: -1, decayDays: 30, sideApiBase: 'https://side.invalid/v1', sideApiModel: 'judge-model' }
  await fsp.writeFile(path.join(root, 'side-secret.json'), JSON.stringify({ apiKey: 'test-key' }))
  const stdin = new EventEmitter()
  stdin.setEncoding = () => {}
  const output = []
  const context = vm.createContext({
    console: { error: (...args) => errors.push(args.join(' ')), log: (...args) => output.push(args.join(' ')) },
    process: { pid: process.pid, execPath: process.execPath, kill: process.kill.bind(process), env: {}, argv: ['node', 'memory.mjs', ...(options.argv || [])], stdin, stdout: { write: value => output.push(value) } },
    Date: TestDate, URL, AbortSignal, setTimeout, clearTimeout,
    // 默认禁止网络。需要模拟旁路接口的用例把假的实现放到 state.fetch 上。
    fetch: (...args) => {
      if (!state.fetch) throw new Error('测试禁止网络请求')
      return state.fetch(...args)
    },
  })
  const cache = new Map()
  function synthetic(identifier, values) {
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value)
    }, { context, identifier })
  }
  async function getModule(identifier) {
    if (cache.has(identifier)) return cache.get(identifier)
    let mod
    if (identifier === 'node:os') {
      const os = await import('node:os')
      mod = synthetic(identifier, { ...os, default: { ...os.default, homedir: () => home }, homedir: () => home })
    } else if (identifier === 'node:fs/promises') {
      const safeFs = {
        ...fsp,
        readFile: async (file, ...args) => {
          state.reads.set(String(file), (state.reads.get(String(file)) || 0) + 1)
          if (path.basename(file) === state.failRead) throw Object.assign(new Error('模拟读取失败'), { code: 'EACCES' })
          return fsp.readFile(file, ...args)
        },
        rename: async (from, to) => {
          if ((state.writeError && /\/(rule|project)\.jsonl$/.test(to)) || path.basename(to) === state.failRenameTo) throw new Error('模拟记忆写入失败')
          return fsp.rename(from, to)
        },
      }
      mod = synthetic(identifier, { ...safeFs, default: safeFs })
    } else if (identifier === 'node:child_process') {
      mod = synthetic(identifier, {
        spawn: (...args) => {
          state.spawns.push(args)
          return {
            unref() {},
            // 打开文件的命令要等它退出才知道成没成，这里按 state.spawnExitCode 模拟退出。
            on(event, cb) {
              if (event === 'exit') setTimeout(() => cb(state.spawnExitCode), 0)
            },
          }
        },
      })
    } else if (identifier.startsWith('node:')) {
      mod = synthetic(identifier, await import(identifier))
    } else if (identifier === path.join(repo, 'lib/core/settings.mjs')) {
      mod = synthetic(identifier, { loadSettings: async () => settings, describeSettings: async () => [], updateSetting: async () => ({}) })
    } else if (identifier === path.join(repo, 'lib/core/recall.mjs') && !options.realRecall) {
      mod = synthetic(identifier, {
        loadIndex: async () => new Map(),
        ensureVectors: async (_, index) => index,
        refreshVector: async () => { state.vectorRefreshes++ },
        dropVectors: async (ids) => { state.droppedVectors.push(...ids); return ids.length },
        recall: async (_, pool) => {
          if (state.recallError) throw state.recallError
          return state.hits.map(id => ({ memory: pool.find(mem => mem.id === id), score: 0.9 })).filter(hit => hit.memory)
        },
      })
    } else if (identifier === path.join(repo, 'lib/embedding.js')) {
      mod = synthetic(identifier, {
        EMBED_VERSION: 4, docText: mem => mem.text,
        embed: async texts => {
          state.embeddedTexts.push(...texts)
          return texts.map(text => [text === '不相关' ? 0.1 : 1])
        },
        centroid: () => [0], centerTo: value => value, cosine: (_, value) => value[0],
      })
    } else {
      assert.ok(identifier.startsWith(repo), `禁止加载仓库外模块：${identifier}`)
      mod = new vm.SourceTextModule(await fsp.readFile(identifier, 'utf8'), {
        context, identifier,
        initializeImportMeta: meta => { meta.url = pathToFileURL(identifier).href },
      })
    }
    cache.set(identifier, mod)
    return mod
  }
  async function load(relative) {
    const mod = await getModule(path.join(repo, relative))
    if (mod.status === 'unlinked') {
      await mod.link((specifier, referencing) => getModule(specifier.startsWith('node:') ? specifier : path.resolve(path.dirname(referencing.identifier), specifier)))
    }
    if (mod.status === 'linked') await mod.evaluate()
    return mod.namespace
  }
  async function seed(group, records) {
    await fsp.writeFile(path.join(root, `${group}.jsonl`), records.map(record => JSON.stringify(record)).join('\n') + '\n')
  }
  async function records(group = 'rule') {
    return (await fsp.readFile(path.join(root, `${group}.jsonl`), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  return { home, root, errors, output, state, settings, clock, stdin, load, seed, records }
}

export function memory(id, extra = {}) {
  const now = new Date().toISOString()
  return { id, text: `规则 ${id}`, category: 'rule', confidence: 0.5, lastSeen: now, firstSeen: now, createdAt: now, deprecated: false, ...extra }
}
