import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'memory-settings-'))
process.env.HOME = home
const root = path.join(home, '.memory-self-evolution')
const configFile = path.join(root, 'config.json')
test.after(() => fsp.rm(home, { recursive: true, force: true }))

let generation = 0
async function freshSettings(config) {
  await fsp.rm(root, { recursive: true, force: true })
  if (config !== undefined) {
    await fsp.mkdir(root, { recursive: true })
    await fsp.writeFile(configFile, JSON.stringify(config))
  }
  return import(`../lib/core/settings.mjs?generation=${++generation}`)
}

test('decayDays缺省为30，可在config.json中改为正整数', async () => {
  assert.equal((await (await freshSettings()).loadSettings()).decayDays, 30)
  assert.equal((await (await freshSettings({ decayDays: 7 })).loadSettings()).decayDays, 7)
})

test('config.json中的非法decayDays回退为30', async () => {
  for (const decayDays of [0, -1, 1.5, '7']) {
    assert.equal((await (await freshSettings({ decayDays })).loadSettings()).decayDays, 30)
  }
})

test('召回配置的默认值：每类上限3，rule下限0.22，project下限0.29', async () => {
  const settings = await (await freshSettings()).loadSettings()
  assert.equal(settings.recallTopK, 3)
  assert.equal(settings.recallMinScore, 0.22)
  assert.equal(settings.recallMinScoreProject, 0.29)
})

test('showRecall默认关闭，可用updateSetting打开，非布尔值被拒绝', async () => {
  assert.equal((await (await freshSettings()).loadSettings()).showRecall, false)
  assert.equal((await (await freshSettings({ showRecall: 'yes' })).loadSettings()).showRecall, false)
  const settings = await freshSettings()
  assert.equal((await settings.updateSetting('showRecall', 'on')).ok, true)
  assert.equal(JSON.parse(await fsp.readFile(configFile, 'utf8')).showRecall, true)
  assert.equal((await settings.updateSetting('showRecall', 'maybe')).ok, false)
})

test('recallTopK可在config.json中改为正整数，改完重新加载即生效，非法值回退为3', async () => {
  assert.equal((await (await freshSettings({ recallTopK: 5, recallMinScoreProject: 0.33 })).loadSettings()).recallTopK, 5)
  assert.equal((await (await freshSettings({ recallTopK: 5, recallMinScoreProject: 0.33 })).loadSettings()).recallMinScoreProject, 0.33)
  for (const recallTopK of [0, -1, 2.5, '5']) {
    assert.equal((await (await freshSettings({ recallTopK })).loadSettings()).recallTopK, 3)
  }
  const settings = await freshSettings()
  assert.equal((await settings.updateSetting('recallTopK', '4')).ok, true)
  assert.equal((await settings.updateSetting('recallTopK', '0')).ok, false)
  assert.equal(JSON.parse(await fsp.readFile(configFile, 'utf8')).recallTopK, 4)
  assert.equal((await settings.updateSetting('recallMinScoreProject', '0.31')).ok, true)
  assert.equal((await settings.loadSettings()).recallMinScoreProject, 0.31)
})

test('通过updateSetting修改decayDays，非法值被拒绝且不写入', async () => {
  const settings = await freshSettings()
  assert.equal((await settings.updateSetting('decayDays', '14')).ok, true)
  assert.equal(JSON.parse(await fsp.readFile(configFile, 'utf8')).decayDays, 14)
  for (const value of ['0', '-3', '1.5', 'abc']) {
    assert.equal((await settings.updateSetting('decayDays', value)).ok, false)
  }
  assert.equal(JSON.parse(await fsp.readFile(configFile, 'utf8')).decayDays, 14)
  assert.equal((await settings.loadSettings()).decayDays, 14)
})

test('sideJudge不再是配置项，旧配置里的false原样保留，改其它配置时不丢', async () => {
  const fresh = await freshSettings({ sideJudge: true, confirm: false })
  assert.equal('sideJudge' in await fresh.loadSettings(), false)
  assert.equal((await fresh.describeSettings()).some(item => item.key === 'sideJudge'), false)
  assert.equal((await fresh.updateSetting('sideJudge', 'false')).ok, false)

  const legacy = await freshSettings({ sideJudge: false, confirm: false })
  assert.equal((await legacy.loadSettings()).sideJudge, false)
  assert.equal((await legacy.describeSettings()).some(item => item.key === 'sideJudge'), false)
  assert.equal((await legacy.updateSetting('sideJudge', 'true')).ok, false)
  assert.equal((await legacy.updateSetting('confirm', 'true')).ok, true)
  const saved = JSON.parse(await fsp.readFile(configFile, 'utf8'))
  assert.equal(saved.sideJudge, false)
  assert.equal(saved.confirm, true)
})
