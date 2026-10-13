// CodeBuddy 与 WorkBuddy：hook 在各自目录的 settings.json，每个事件下是一列 { matcher, hooks: [...] }。
// WorkBuddy 启动 CLI 时把 CODEBUDDY_CONFIG_DIR 指到 ~/.workbuddy，所以两套配置必须分开写。

import { fileHost, isPluginHook } from './shared.mjs'

function host(id, name, dir) {
  return fileHost({
    id,
    name,
    dir,
    hooksFile: 'settings.json',
    events: [
      { event: 'SessionStart', timeout: 10 },
      { event: 'UserPromptSubmit', timeout: 10 },
      { event: 'Stop', timeout: 20 },
    ],
    legacyEvent: 'PostToolUse',
    emptyHooksFile: () => ({ hooks: {} }),
    upsertHook(list, command, timeout) {
      for (const group of list) {
        const hooks = Array.isArray(group && group.hooks) ? group.hooks : []
        const found = hooks.find((item) => isPluginHook(item && item.command, id))
        if (!found) continue
        found.type = 'command'
        found.command = command
        found.timeout = timeout
        return 'updated'
      }
      list.push({
        matcher: '',
        hooks: [{ type: 'command', command, timeout }],
      })
      return 'added'
    },
  })
}

export const codebuddy = host('codebuddy', 'codebuddy', '.codebuddy')
export const workbuddy = host('workbuddy', 'WorkBuddy', '.workbuddy')
