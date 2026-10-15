// 用系统默认程序打开一个文件，用于让用户查看 memories.md。由 MCP 进程打开，各客户端行为一致。
// 返回 { ok, detail }，打不开时 detail 是原因，调用方把文件路径告诉用户。

import { spawn } from 'node:child_process'

const OPEN_TIMEOUT_MS = 5000

function opener(file) {
  if (process.platform === 'darwin') return ['open', [file]]
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '', file]]
  return ['xdg-open', [file]]
}

export function openWithDefaultApp(file) {
  const [command, args] = opener(file)
  return new Promise((resolve) => {
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!result.ok) console.error(`[memory] 打开文件失败 command=${command} file=${file}: ${result.detail}`)
      resolve(result)
    }
    // 打开文件的命令启动程序后就会退出；等太久说明卡住了，不让工具调用一直挂着。
    const timer = setTimeout(() => done({ ok: false, detail: `${command} 超过 ${OPEN_TIMEOUT_MS / 1000} 秒没有返回` }), OPEN_TIMEOUT_MS)
    let child
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true })
    } catch (e) {
      done({ ok: false, detail: e.message })
      return
    }
    child.on('error', (e) => done({ ok: false, detail: e.message }))
    child.on('exit', (code) => done(code === 0 ? { ok: true } : { ok: false, detail: `${command} 退出码 ${code}` }))
    child.unref()
  })
}
