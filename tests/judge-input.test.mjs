import test from 'node:test'
import assert from 'node:assert/strict'
import { JUDGE_INPUT_MAX, prepareJudgeInput, redactSecrets, stripPastedBlocks } from '../lib/core/judge-input.mjs'

test('围栏代码块整段去掉，没闭合的去到末尾，用户的话保留', () => {
  const closed = stripPastedBlocks('以后接口都这样写：\n\`\`\`ts\nexport function f() {}\n\`\`\`\n记住这个约定')
  assert.equal(closed.text, '以后接口都这样写：\n记住这个约定')
  assert.equal(closed.stripped, true)
  assert.equal(stripPastedBlocks('看这段报错\n~~~\nline one\nline two').text, '看这段报错')
  const plain = stripPastedBlocks('以后回答我都用中文')
  assert.equal(plain.text, '以后回答我都用中文')
  assert.equal(plain.stripped, false)
})

test('连续三行以上像代码或日志的行被去掉，少于三行的和含中文的行不动', () => {
  const stack = [
    '这个崩溃以后遇到都先查空指针',
    'TypeError: Cannot read properties of null',
    '    at render (app.js:10:5)',
    '    at update (app.js:22:3)',
    '    at main (index.js:3:1)',
  ].join('\n')
  assert.equal(stripPastedBlocks(stack).text, '这个崩溃以后遇到都先查空指针\nTypeError: Cannot read properties of null')

  const logs = ['2026-10-11 10:00:01 INFO start', '2026-10-11 10:00:02 WARN slow', '', '2026-10-11 10:00:03 ERROR failed', '上面这种日志以后直接忽略'].join('\n')
  assert.equal(stripPastedBlocks(logs).text, '上面这种日志以后直接忽略')

  const twoLines = '变量这样命名：\nconst userName = 1;\nconst userAge = 2;'
  assert.equal(stripPastedBlocks(twoLines).text, twoLines)
  // 一行代码加空行不算一片；带中文注释的代码行不删。
  assert.equal(stripPastedBlocks('const a = 1;\n\n\n以后都用 const').text, 'const a = 1;\n\n以后都用 const')
  const commented = '  // 这里要加日志\n  // 这里也要\n  // 还有这里'
  assert.equal(stripPastedBlocks(commented).text, commented.trim())
})

test('形如密钥的字符串被抹掉，普通词语不受影响', () => {
  const cases = [
    ['key 是 sk-abcdefghijklmnopqrstuvwx 记一下', 'key 是 [已隐去] 记一下'],
    ['GitHub token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'GitHub token [已隐去]'],
    ['AKIAIOSFODNN7EXAMPLE 是访问密钥', '[已隐去] 是访问密钥'],
    ['Authorization: Bearer abcdefghijklmnop.qrstuvwx', 'Authorization: [已隐去]'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefg', 'jwt [已隐去]'],
    ['password: hunter2', 'password: [已隐去]'],
    ['用户名 tester，密码 125809', '用户名 tester，密码 [已隐去]'],
    ['api_key=A1b2C3d4', 'api_key=[已隐去]'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----', '[已隐去]'],
  ]
  for (const [input, expected] of cases) assert.equal(redactSecrets(input).text, expected, input)
  assert.equal(redactSecrets('密码 125809，token 是 abc123def').count, 2)
  for (const untouched of ['token 过期了怎么办', '密码错误怎么办', 'token count 超了', 'secret manager 怎么配', '以后回答我都用中文']) {
    const result = redactSecrets(untouched)
    assert.equal(result.text, untouched)
    assert.equal(result.count, 0)
  }
})

test('预处理后不足 6 个字或超过上限的输入不送判', () => {
  assert.equal(prepareJudgeInput('好的').skip, 'too-short')
  assert.equal(prepareJudgeInput('看下\n\`\`\`\ncode\n\`\`\`').skip, 'too-short')
  assert.equal(prepareJudgeInput('字'.repeat(JUDGE_INPUT_MAX)).skip, '')
  assert.equal(prepareJudgeInput('字'.repeat(JUDGE_INPUT_MAX + 1)).skip, 'too-long')
  // 代码很长但用户的话很短：去掉代码后照常送判。
  const mixed = prepareJudgeInput('以后都按下面这个模板写接口\n\`\`\`\n' + 'x = 1\n'.repeat(500) + '\`\`\`')
  assert.equal(mixed.skip, '')
  assert.equal(mixed.text, '以后都按下面这个模板写接口')
  assert.equal(mixed.stripped, true)
  const secret = prepareJudgeInput('记住数据库密码是 Passw0rd123')
  assert.equal(secret.text, '记住数据库密码是 [已隐去]')
  assert.equal(secret.redacted, 1)
})
