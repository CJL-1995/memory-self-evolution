// CodeBuddy 与 WorkBuddy：hook 在各自目录的 settings.json，每个事件下是一列 { matcher, hooks: [...] }。
// WorkBuddy 启动 CLI 时把 CODEBUDDY_CONFIG_DIR 指到 ~/.workbuddy，所以两套配置必须分开写。

import { fileHost, upsertGroupedHook } from './shared.mjs'

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
    upsertHook: (list, command, timeout) => upsertGroupedHook(list, command, timeout, id),
  })
}

export const codebuddy = host('codebuddy', 'codebuddy', '.codebuddy')
export const workbuddy = host('workbuddy', 'WorkBuddy', '.workbuddy')
