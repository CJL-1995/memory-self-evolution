#!/usr/bin/env node
// 卸载本机注册，不删除插件仓库，也不删除已经生成的记忆。
//
// 1. 删除向量模型缓存（bge-base-zh-v1.5 的权重，不是记忆向量索引）
// 2. 从 Cursor、codebuddy、WorkBuddy、Claude Code 去掉本插件的 hook
// 3. 从这几端去掉本插件的 MCP 和整理记忆用的 skill。仓库和 node_modules 里的插件代码保留
// 4. 保留 ~/.memory-self-evolution/ 和其中的记忆。删掉配置、旁路密钥和旁路任务
//
// 用法：node tools/uninstall.mjs [--only <客户端>]
// --only 只去掉这一端的 hook、MCP 和 skill。向量模型、配置和其它客户端都不动。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { INSTALL_HOSTS, selectHosts } from './hosts/index.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const home = os.homedir()
const dataDir = path.join(home, '.memory-self-evolution')
const modelDir = path.join(repoRoot, 'node_modules/@huggingface/transformers/.cache/Xenova/bge-base-zh-v1.5')

function removeModel() {
  if (!fs.existsSync(modelDir)) {
    console.log(`向量模型：未找到 ${modelDir}，已跳过`)
    return
  }
  fs.rmSync(modelDir, { recursive: true, force: true })
  console.log(`向量模型：已删除 ${modelDir}`)
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
  console.log('保留 rule.jsonl、project.jsonl、memories.html、embeddings.jsonl、project-memory')
}

const onlyIdx = process.argv.indexOf('--only')
const only = onlyIdx >= 0 ? String(process.argv[onlyIdx + 1] || '') : ''
let hosts
try {
  if (onlyIdx >= 0 && !only) throw new Error('--only 后面要跟客户端的名字')
  hosts = selectHosts(only)
} catch (error) {
  console.error(error.message)
  console.error(`用法：node tools/uninstall.mjs [--only <${INSTALL_HOSTS.map((host) => host.id).join('|')}>]`)
  process.exit(1)
}
const ctx = { claudeBin: process.env.MEMORY_CLAUDE_BIN || '' }

if (!only) removeModel()
for (const host of hosts) {
  console.log(`${host.name} hook：${host.removeHooks(home)}`)
  console.log(`${host.name} MCP：${host.removeMcp(home, ctx)}`)
  console.log(`${host.name} skill：${host.removeSkill(home)}`)
}
if (!only) removeConfig()
else console.log('向量模型、配置和其它客户端没有动。')
console.log(`插件仓库未删除。重启 ${hosts.map((host) => host.name).join('、')} 后，MCP 才会从客户端消失。`)
