// 安装侧的宿主清单。setup 和 uninstall 按这个顺序逐个处理。
// 接入新的客户端：在这个目录加一个文件，导出 { id, name, register, removeHooks, removeMcp, removeSkill }，再在这里登记一行。
// 安装时有要问用户的事，再导出 questions(home, ctx)，返回 [{ key, title, options }]，答案会放进 ctx[key]。

import cursor from './cursor.mjs'
import { codebuddy, workbuddy } from './codebuddy.mjs'
import claude from './claude.mjs'

export const INSTALL_HOSTS = [cursor, codebuddy, workbuddy, claude]

// --only <id>：只处理某一端，其余几端的配置文件不读也不写。
export function selectHosts(only) {
  if (!only) return INSTALL_HOSTS
  const picked = INSTALL_HOSTS.filter((host) => host.id === only)
  if (picked.length === 0) throw new Error(`--only 后面要跟 ${INSTALL_HOSTS.map((host) => host.id).join('、')} 之一，收到「${only}」`)
  return picked
}
