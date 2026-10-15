#!/usr/bin/env node
// 给当前用户注册 Cursor、codebuddy、WorkBuddy 与 Claude Code 的 hook、MCP 和整理记忆用的 skill。
// 已有其他 hook / MCP 会保留。本插件已注册时只更新 node 与仓库路径，不重复追加。
//
// 不带参数：交互安装。问是否弹确认，再问旁路接口的 baseUrl、apiKey、apiModel。
// 注册 hook 之前会下载向量模型 bge-base-zh-v1.5。缓存已在则直接复用。下载失败则中止安装。
// 直接回车默认弹出确认。接口三项输入 skip 则跳过，安装后自行配置；配齐之前不会沉淀新记忆。
// sidepath：不提问，只重新注册。旧版本留下的阻塞模式配置同时改为旁路。
// 阻塞模式已移除，blocking 参数会报错退出。
// --only <客户端>：只注册这一端，不问确认方式和接口，也不碰其它客户端的配置文件。
// 用法：npm install && npm run setup

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { downloadModel } from '../lib/embedding.js'
import { INSTALL_HOSTS, selectHosts } from './hosts/index.mjs'
import { readJson, writeJson } from './hosts/shared.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeBin = process.execPath
const hookScript = path.join(repoRoot, 'bin', 'memory.mjs')
const mcpScript = path.join(repoRoot, 'bin', 'memory-mcp.mjs')
const skillSource = path.join(repoRoot, 'skills', 'memory-self-evolution-manage', 'SKILL.md')

function migrateDataDir(home) {
  const oldDir = path.join(home, '.dsh-memory')
  const newDir = path.join(home, '.memory-self-evolution')
  if (!fs.existsSync(oldDir) || fs.existsSync(newDir)) return
  fs.renameSync(oldDir, newDir)
  console.log(`已把 ${oldDir} 迁到 ${newDir}`)
}

function configFile(home) {
  return path.join(home, '.memory-self-evolution', 'config.json')
}

// 旧版本的阻塞模式在配置里留下 sideJudge=false。这个键还在时 hook 不会启动旁路。
function hasLegacyBlocking(home) {
  return readJson(configFile(home), {}).sideJudge === false
}

// sideJudge 不再是配置项。删掉它即表示这台机器改走旁路。
function clearLegacyMode(home) {
  const file = configFile(home)
  const data = readJson(file, {})
  if (!('sideJudge' in data)) return
  delete data.sideJudge
  writeJson(file, data)
}

function missingSideApi(home) {
  const config = readJson(configFile(home), {})
  const secret = readJson(path.join(home, '.memory-self-evolution', 'side-secret.json'), {})
  const missing = []
  if (!config.sideApiBase) missing.push('config.json 的 sideApiBase')
  if (!config.sideApiModel) missing.push('config.json 的 sideApiModel')
  if (!String(secret.apiKey || '').trim()) missing.push('side-secret.json 的 apiKey')
  return missing
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const lineQueue = []
let lineWaiter = null
rl.on('line', (line) => {
  const text = String(line || '').trim()
  if (!lineWaiter) {
    lineQueue.push(text)
    return
  }
  const resolve = lineWaiter
  lineWaiter = null
  resolve(text)
})

function ask(question) {
  process.stdout.write(question)
  if (lineQueue.length > 0) {
    process.stdout.write('\n')
    return Promise.resolve(lineQueue.shift())
  }
  return new Promise((resolve) => {
    lineWaiter = resolve
  })
}

async function askChoice(title, options) {
  console.log(title)
  for (const opt of options) console.log(`  ${opt.menu}`)
  while (true) {
    const answer = (await ask('请选择：')).toLowerCase()
    if (!answer) return options[0].value
    const hit = options.find((opt) => opt.aliases.includes(answer))
    if (hit) return hit.value
    console.log('输入序号。直接回车使用第一项。')
  }
}

function isSkip(text) {
  return text.toLowerCase() === 'skip'
}

async function askRequired(label) {
  while (true) {
    const answer = await ask(`${label}（输入 skip 跳过三项）：`)
    if (isSkip(answer)) return null
    if (answer) return answer
    console.log(`${label} 必填，没有缺省值。`)
  }
}

async function askSideApi() {
  console.log('')
  console.log('旁路判别需要 baseUrl、apiKey、apiModel，三项都必填，没有缺省值。')
  console.log('输入 skip 跳过。配齐之前不会沉淀新记忆。安装完成后自行写入：')
  console.log('  ~/.memory-self-evolution/config.json 的 sideApiBase、sideApiModel')
  console.log('  ~/.memory-self-evolution/side-secret.json 的 apiKey')
  const baseUrl = await askRequired('baseUrl')
  if (!baseUrl) return null
  const apiKey = await askRequired('apiKey')
  if (!apiKey) return null
  const apiModel = await askRequired('apiModel')
  if (!apiModel) return null
  return { baseUrl, apiKey, apiModel }
}

function writeSideSecret(home, apiKey) {
  const file = path.join(home, '.memory-self-evolution', 'side-secret.json')
  const data = readJson(file, {})
  data.apiKey = apiKey
  writeJson(file, data)
  fs.chmodSync(file, 0o600)
}

function applyChoices(home, choices) {
  const file = configFile(home)
  const data = readJson(file, {})
  delete data.sideJudge
  data.confirm = choices.confirm
  if (choices.api) {
    data.sideApiBase = choices.api.baseUrl
    data.sideApiModel = choices.api.apiModel
    writeSideSecret(home, choices.api.apiKey)
  }
  writeJson(file, data)
}

async function askInstallChoices() {
  const confirm = await askChoice('写盘方式：', [
    { value: true, menu: '1) 弹出确认（直接回车）', aliases: ['1', '弹窗', '弹出', '确认', 'confirm'] },
    { value: false, menu: '2) 自动追加', aliases: ['2', '自动', '自动追加', 'auto'] },
  ])
  const api = await askSideApi()
  return { confirm, api }
}

async function ensureVectorModel() {
  console.log('正在准备向量模型 bge-base-zh-v1.5（约 98MB，已有缓存则直接复用）…')
  try {
    await downloadModel()
  } catch (error) {
    console.error(`向量模型下载失败，安装中止，hook 与 MCP 未继续注册。原因：${error.message}`)
    process.exit(1)
  }
  console.log('向量模型已就绪')
}

function registerAll(home, hosts, ctx) {
  for (const host of hosts) console.log(`${host.name}：${host.register(home, ctx)}`)
  console.log('记忆数据在 ~/.memory-self-evolution/，不会随仓库分发。重启客户端后 MCP 才会加载。')
}

const args = process.argv.slice(2)
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? String(args[onlyIdx + 1] || '') : ''
if (onlyIdx >= 0) args.splice(onlyIdx, 2)
const modeArg = args[0]
const USAGE = `用法：node tools/setup.mjs [sidepath] [--only <${INSTALL_HOSTS.map((host) => host.id).join('|')}>]`
let hosts
try {
  if (onlyIdx >= 0 && !only) throw new Error('--only 后面要跟客户端的名字')
  hosts = selectHosts(only)
} catch (error) {
  console.error(error.message)
  console.error(USAGE)
  process.exit(1)
}
if (modeArg === 'blocking') {
  console.error('阻塞模式已移除。现在只有旁路式：后台调用配置的模型接口判断要不要记，写盘前弹不弹确认仍由 confirm 决定。')
  console.error('运行 npm run setup 重新安装，或 node tools/setup.mjs sidepath 不提问、只重新注册。')
  process.exit(1)
}
if (modeArg && modeArg !== 'sidepath') {
  console.error(USAGE)
  console.error('不带参数进入交互安装：选择弹窗或自动追加，再填旁路接口的 baseUrl、apiKey、apiModel。')
  console.error('sidepath 不提问，只重新注册；旧版本留下的阻塞模式配置同时改为旁路。')
  console.error('--only 只注册这一端，不碰其它客户端的配置文件。')
  process.exit(1)
}

const home = os.homedir()
migrateDataDir(home)
console.log(`node ${nodeBin}`)
console.log(`仓库 ${repoRoot}`)

const legacyBlocking = hasLegacyBlocking(home)
if (legacyBlocking) {
  console.log('检测到旧版本的阻塞模式配置。阻塞模式已移除，现在只有旁路式：用户原话会发给配置的模型接口，由它判断要不要记。')
}

// MEMORY_CLAUDE_BIN：claude 命令不在 PATH、也不在桌面端的默认位置时，用它指明路径。
const ctx = { nodeBin, hookScript, mcpScript, skillSource, claudeBin: process.env.MEMORY_CLAUDE_BIN || '' }

if (modeArg) {
  clearLegacyMode(home)
  if (legacyBlocking) console.log('已改为旁路式。')
} else if (process.stdin.isTTY) {
  // 只注册某一端时不动全局配置，确认方式和接口沿用已有的。
  if (!only) {
    const choices = await askInstallChoices()
    applyChoices(home, choices)
    console.log(`写盘：${choices.confirm ? '弹出确认' : '自动追加'}`)
    if (choices.api) {
      console.log(`旁路 baseUrl：${choices.api.baseUrl}`)
      console.log(`旁路 apiModel：${choices.api.apiModel}`)
      console.log('apiKey 已写入 ~/.memory-self-evolution/side-secret.json')
    }
  }
  // 个别客户端安装时有自己要问的事。
  for (const host of hosts) {
    for (const question of host.questions ? host.questions(home, ctx) : []) {
      console.log('')
      ctx[question.key] = await askChoice(question.title, question.options)
    }
  }
} else {
  console.error('当前没有终端，跳过安装提问。仍会下载向量模型并注册 hook 和 MCP。要选择确认方式、填写旁路接口，请在终端重新运行 npm run setup。')
  if (legacyBlocking) console.error('旧的阻塞模式配置没有改动，旁路不会启动。在终端运行 npm run setup 或 node tools/setup.mjs sidepath 后才启用。')
}

rl.close()
await ensureVectorModel()
registerAll(home, hosts, ctx)
console.log('重启后主模型能看到 memory_list、memory_read、memory_config、整理记忆用的 memory_update，以及处理插件确认弹窗的 memory_resolve。')
const missing = missingSideApi(home)
if (missing.length > 0) {
  console.log(`旁路接口还缺：${missing.join('、')}（都在 ~/.memory-self-evolution/ 下）。配齐之前不会沉淀新记忆，已有记忆照常注入和召回；会话开始时会把这一点告诉主模型。`)
}
