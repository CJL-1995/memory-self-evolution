#!/usr/bin/env node
// 卸载本机注册，不删除插件仓库，也不删除已经生成的记忆。
//
// 1. 删除向量模型缓存（bge-base-zh-v1.5 的权重，不是记忆向量索引）
// 2. 从 Cursor、codebuddy、WorkBuddy 去掉本插件的 hook
// 3. 从这三端的 mcp.json 去掉本插件。仓库和 node_modules 里的插件代码保留
// 4. 保留 ~/.memory-self-evolution/ 和其中的记忆。删掉配置、旁路密钥和旁路任务
//
// 用法：node tools/uninstall.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { INSTALL_HOSTS } from './hosts/index.mjs'

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
  console.log('保留 rule.jsonl、project.jsonl、memories.md、embeddings.jsonl、project-memory')
}

removeModel()
for (const host of INSTALL_HOSTS) {
  console.log(`${host.name} hook：${host.removeHooks(home)}`)
  console.log(`${host.name} MCP：${host.removeMcp(home)}`)
}
removeConfig()
console.log(`插件仓库未删除。重启 ${INSTALL_HOSTS.map((host) => host.name).join('、')} 后，MCP 才会从客户端消失。`)
