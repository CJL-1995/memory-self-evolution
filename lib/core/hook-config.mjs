// 判定一条 hook 命令是不是本插件给某一端注册的。安装、卸载和清理旧 hook 都用这一个。
export function isPluginHook(command, agent) {
  const text = String(command || '')
  return text.includes('memory.mjs') && text.includes(`hook --agent ${agent}`)
}

export function removePluginHookEvent(hooks, event, agent) {
  if (!hooks || typeof hooks !== 'object' || !Array.isArray(hooks[event])) return 0
  let removed = 0
  const kept = []
  for (const item of hooks[event]) {
    if (item && isPluginHook(item.command, agent)) {
      removed++
      continue
    }
    if (!item || !Array.isArray(item.hooks)) {
      kept.push(item)
      continue
    }
    const childHooks = item.hooks.filter((hook) => {
      const matched = isPluginHook(hook && hook.command, agent)
      if (matched) removed++
      return !matched
    })
    if (childHooks.length > 0) kept.push({ ...item, hooks: childHooks })
  }
  if (kept.length > 0) hooks[event] = kept
  else delete hooks[event]
  return removed
}
