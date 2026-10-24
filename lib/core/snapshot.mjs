// 把 rule / project 渲染成一份给人核对的 HTML，双击或 memory_list open=true 即可在浏览器里看。
// 每次新增、合并、强化后整份覆盖，避免和 jsonl 对不上。写失败只记日志，不挡住记忆落盘。
// 页面不引用任何外部资源、也不带脚本，离线打开不会向外发请求。

import fsp from 'node:fs/promises'
import { ROOT, paths } from './config.mjs'
import { fmtConfidence, readAllGroups } from './store.mjs'

const TITLES = {
  rule: '规则与偏好',
  project: '项目事实',
}

// 正文里的网址到空白、引号、尖括号或中文标点为止，避免把句末的「。」也算进链接。
const URL_RE = /https?:\/\/[^\s<>"'，。；：、！？）】」』]+/g

const STYLE = `
:root { color-scheme: light dark; --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --line: #e7e5e4; --card: #ffffff; --link: #1d4ed8; --code: #f5f5f4; --warn: #b45309; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1917; --fg: #e7e5e4; --muted: #a8a29e; --line: #44403c; --card: #292524; --link: #93c5fd; --code: #3a3532; --warn: #fbbf24; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.7 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
main { max-width: 880px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 24px; margin: 0 0 4px; }
h2 { font-size: 18px; margin: 32px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.stamp { color: var(--muted); margin: 0; font-size: 13px; }
ol { margin: 0; padding: 0; list-style: none; }
li { position: relative; margin: 0 0 10px; padding: 12px 14px 10px 50px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; }
.num { position: absolute; left: 14px; top: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
li.deprecated .text { color: var(--muted); text-decoration: line-through; }
.text { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.meta { margin: 6px 0 0; color: var(--muted); font-size: 13px; }
.meta code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; user-select: all; }
.flag { color: var(--warn); }
.empty { color: var(--muted); }
a { color: var(--link); overflow-wrap: anywhere; }
`.trim()

function stamp() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }).replace('T', ' ')
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// 转义正文，并把其中的 http(s) 网址变成可点的链接。
function renderText(text) {
  const raw = String(text ?? '')
  let html = ''
  let last = 0
  for (const match of raw.matchAll(URL_RE)) {
    const url = escapeHtml(match[0])
    html += escapeHtml(raw.slice(last, match.index))
    html += `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`
    last = match.index + match[0].length
  }
  return html + escapeHtml(raw.slice(last))
}

function section(group, mems) {
  const title = TITLES[group] || group
  const lines = [`<h2>${escapeHtml(title)}（${mems.length}）</h2>`]
  if (mems.length === 0) {
    lines.push('<p class="empty">（空）</p>')
    return lines
  }
  lines.push('<ol>')
  mems.forEach((mem, index) => {
    const meta = [
      `置信度 ${escapeHtml(fmtConfidence(mem.confidence))}`,
      `id <code>${escapeHtml(mem.id)}</code>`,
      ...(mem.deprecated ? ['<span class="flag">已废弃</span>'] : []),
    ].join('，')
    lines.push(`<li${mem.deprecated ? ' class="deprecated"' : ''}>`)
    lines.push(`<span class="num">${index + 1}.</span>`)
    lines.push(`<p class="text">${renderText(mem.text)}</p>`)
    lines.push(`<p class="meta">${meta}</p>`)
    lines.push('</li>')
  })
  lines.push('</ol>')
  return lines
}

export function renderSnapshot(groups) {
  const rule = groups.rule || []
  const project = groups.project || []
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>记忆快照</title>',
    `<style>\n${STYLE}\n</style>`,
    '</head>',
    '<body>',
    '<main>',
    '<h1>记忆快照</h1>',
    `<p class="stamp">更新于 ${stamp()}（北京时间）。本文件由写入自动覆盖，请不要手改。</p>`,
    ...section('rule', rule),
    ...section('project', project),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

export async function syncSnapshot() {
  try {
    const groups = await readAllGroups()
    const body = renderSnapshot(groups)
    const tmp = `${paths.snapshot}.tmp.${process.pid}`
    await fsp.mkdir(ROOT, { recursive: true })
    await fsp.writeFile(tmp, body, 'utf-8')
    await fsp.rename(tmp, paths.snapshot)
  } catch (e) {
    console.error(`[memory] 同步记忆快照失败: ${e.message}`)
    return
  }
  // 早期版本的快照是 memories.md，已不再更新；留着会被当成最新的记忆来看。
  await fsp.rm(paths.legacySnapshot, { force: true }).catch((e) => {
    console.error(`[memory] 删除旧的 Markdown 快照失败 file=${paths.legacySnapshot}: ${e.message}`)
  })
}
