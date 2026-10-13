// 安装侧的宿主清单。setup 和 uninstall 按这个顺序逐个处理。
// 接入新的客户端：在这个目录加一个文件，导出 { id, name, register, removeHooks, removeMcp }，再在这里登记一行。

import cursor from './cursor.mjs'
import { codebuddy, workbuddy } from './codebuddy.mjs'

export const INSTALL_HOSTS = [cursor, codebuddy, workbuddy]
