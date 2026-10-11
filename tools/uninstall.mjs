#!/usr/bin/env node
// 卸载本机注册，不删除插件仓库，也不删除已经生成的记忆。
//
// 1. 删除向量模型缓存（bge-base-zh-v1.5 的权重，不是记忆向量索引）
// 2. 从 Cursor、codebuddy、WorkBuddy 去掉本插件的 hook
// 3. 从这三端的 mcp.json 去掉本插件。仓库和 node_modules 里的插件代码保留
// 4. 保留 ~/.memory-self-evolution/ 和其中的记忆。删掉配置、旁路密钥和旁路任务
//
// 用法：node tools/uninstall.mjs
// 判定「是不是本插件的 hook」必须和 tools/setup.mjs 的 isOurHook 保持一致。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = os.homedir()
const dataDir = path.join(home, '.memory-self-evolution')
const modelDir = path.join(repoRoot, 'node_modules/@huggingface/transformers/.cache/Xenova/bge-base-zh-v1.5')

const CLIENTS = [
  { name: 'Cursor', dir: '.cursor', agent: 'cursor', hooksFile: 'hooks.json' },
  { name: 'codebuddy', dir: '.codebuddy', agent: 'codebuddy', hooksFile: 'settings.json' },
  { name: 'WorkBuddy', dir: '.workbuddy', agent: 'workbuddy', hooksFile: 'settings.json' },
]

function isOurHook(command, agent) {
  const text = String(command || '')
  return text.includes('memory.mjs') && text.includes(`hook --agent ${agent}`)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    console.error(`读取 ${file} 失败，已跳过该文件。原因：${error.message}`)
    return undefined
  }
}

function writeJson(file, data) {
  const tmp = `${file}.tmp.${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`)
  fs.renameSync(tmp, file)
}

function removeModel() {
  if (!fs.existsSync(modelDir)) {
    console.log(`向量模型：未找到 ${modelDir}，已跳过`)
    return
  }
  fs.rmSync(modelDir, { recursive: true, force: true })
  console.log(`向量模型：已删除 ${modelDir}`)
}

function removeHooksFromList(list, agent) {
  if (!Array.isArray(list)) return 0
  let removed = 0
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i]
    if (item && isOurHook(item.command, agent)) {
      list.splice(i, 1)
      removed++
      continue
    }
    if (!item || !Array.isArray(item.hooks)) continue
    const before = item.hooks.length
    item.hooks = item.hooks.filter((hook) => !isOurHook(hook && hook.command, agent))
    removed += before - item.hooks.length
    if (item.hooks.length === 0) list.splice(i, 1)
  }
  return removed
}

function removeHooks(client) {
  const file = path.join(home, client.dir, client.hooksFile)
  if (!fs.existsSync(path.join(home, client.dir))) return '客户端目录不存在，已跳过'
  const data = readJson(file)
  if (data == null) return 'hook 文件不存在，已跳过'
  if (data === undefined) return 'hook 文件无法读取，已跳过'
  if (!data.hooks || typeof data.hooks !== 'object') return '没有 hooks 字段，已跳过'
  let removed = 0
  for (const list of Object.values(data.hooks)) {
    removed += removeHooksFromList(list, client.agent)
  }
  if (removed === 0) return '未注册本插件 hook，已跳过'
  writeJson(file, data)
  return `已删除 ${removed} 条 hook`
}

function removeMcp(client) {
  const file = path.join(home, client.dir, 'mcp.json')
  if (!fs.existsSync(path.join(home, client.dir))) return '客户端目录不存在，已跳过'
  const data = readJson(file)
  if (data == null) return 'mcp.json 不存在，已跳过'
  if (data === undefined) return 'mcp.json 无法读取，已跳过'
  if (!data.mcpServers || typeof data.mcpServers !== 'object') return '没有 mcpServers，已跳过'
  const names = ['memory-self-evolution', 'dsh-memory'].filter((name) => Object.hasOwn(data.mcpServers, name))
  if (names.length === 0) return '未注册本插件 MCP，已跳过'
  for (const name of names) delete data.mcpServers[name]
  writeJson(file, data)
  return `已删除 ${names.join(', ')}`
}

function removeConfig() {
  fs.mkdirSync(dataDir, { recursive: true })
  const targets = [
    path.join(dataDir, 'config.json'),
    path.join(dataDir, 'side-secret.json'),
    path.join(dataDir, 'session-secret'),
    path.join(dataDir, 'side'),
  ]
  for (const target of targets) {
    if (!fs.existsSync(target)) {
      console.log(`配置：未找到 ${target}，已跳过`)
      continue
    }
    fs.rmSync(target, { recursive: true, force: true })
    console.log(`配置：已删除 ${target}`)
  }
  console.log(`记忆目录保留：${dataDir}`)
  console.log('保留 rule.jsonl、project.jsonl、memories.md、embeddings.jsonl、project-memory')
}

removeModel()
for (const client of CLIENTS) {
  console.log(`${client.name} hook：${removeHooks(client)}`)
  console.log(`${client.name} MCP：${removeMcp(client)}`)
}
removeConfig()
console.log('插件仓库未删除。重启 Cursor、codebuddy、WorkBuddy 后，MCP 才会从客户端消失。')
