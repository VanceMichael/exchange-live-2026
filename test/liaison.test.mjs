import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { provider } from '../source/provider.mjs'
import { createSource } from '../source/source.mjs'
import { Liaison } from '../src/liaison.mjs'
import { buildPlan } from '../src/planner.mjs'
import { loadRecords } from '../src/sync.mjs'
import { loadConfig } from '../src/config.mjs'

async function listen(t, server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  return 'http://127.0.0.1:' + server.address().port
}

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'liaison-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

async function setup(t, now = '2026-11-20T09:00:00Z') {
  const source = await listen(t, createSource())
  const external = await listen(t, provider())
  const directory = await workspace(t)
  const config = loadConfig({
    sourceBase: source,
    providerBase: external,
    statePath: join(directory, 'state.json'),
    now
  })
  const liaison = new Liaison(config)
  await liaison.load()
  return { source, external, directory, config, liaison }
}

function post(root, path) {
  return fetch(root + path, { method: 'POST' })
}

test('增量凭据过期：重取新公布范围，范围外旧记录不丢、取消件不当作开放', async t => {
  const { source, external, config, liaison } = await setup(t)
  await post(external, '/lab?stage=held')
  await liaison.sync({ full: true })

  // 完整范围 11-20/11-22 内 W 有 C0（11-21）与 C1/C2。
  assert.ok(liaison.state.calendars.W.published['C0-W'])
  assert.equal(liaison.state.calendars.W.scope.until, '2026-11-22')

  // 切到 local-change：增量凭据 410，全量范围缩到 11-20/11-21（只声明 11-20）。
  await post(external, '/lab?stage=local-change')
  liaison.config.now = '2026-11-20T10:50:00Z'
  liaison.state = null
  await liaison.load()
  await liaison.sync()

  const west = liaison.state.calendars.W
  assert.equal(west.syncKey, 'W2')
  assert.deepEqual(west.scope, { from: '2026-11-20', until: '2026-11-21' })
  // 范围外的 C0 不被全量响应悄悄删掉。
  assert.ok(west.published['C0-W'], '范围外旧记录必须保留')
  // 取消件保留为墓碑而不是开放记录。
  assert.equal(west.published['C1-W'].status, 'CANCELLED')
  // 禁止时窗跨零点保留真实结束时刻。
  assert.equal(west.published['blocked-W'].start, 765)
  assert.equal(west.published['blocked-W'].end, 810)
  const history = west.syncHistory.map(entry => entry.mode)
  assert.ok(history.includes('full'))
  assert.ok(west.syncHistory.some(entry => entry.recovered === true))
})

test('关闭实据后释放未开始口译段并列出改约；已上完课堂始终可查', async t => {
  const { external, liaison } = await setup(t)
  await post(external, '/lab?stage=held')
  await liaison.sync({ full: true })
  assert.equal(liaison.plan().sessions.find(entry => entry.session === 'C1').status, 'notified')

  await post(external, '/lab?stage=local-change')
  liaison.config.now = '2026-11-20T09:10:00Z'
  liaison.state = null
  await liaison.load()
  const result = await liaison.sync()

  const c1 = result.plan.sessions.find(entry => entry.session === 'C1')
  assert.equal(c1.needsReschedule, true)
  assert.equal(c1.releases.length, 2)
  for (const release of c1.releases) assert.ok(release.releasedAt < release.start)
  assert.deepEqual(result.plan.reschedules.map(entry => entry.session), ['C1'])
  // 已上完的 C0 保留原资源，且不在择配名单里。
  const completed = result.plan.completed.find(entry => entry.session === 'C0')
  assert.ok(completed)
  assert.equal(completed.original.interpreter, 'I')
  assert.ok(!result.plan.sessions.some(entry => entry.session === 'C0'))

  // 未开始环节释放后，C2 才能用回 I/J 并完整接力。
  const c2 = result.plan.sessions.find(entry => entry.session === 'C2')
  assert.equal(c2.completeRelay, true)
  assert.equal(c2.status, 'ready')
})

test('更正只在房间确实关闭后允许，并使用原通知号', async t => {
  const { external, liaison } = await setup(t)
  await post(external, '/lab?stage=held')
  await liaison.sync({ full: true })

  await assert.rejects(() => liaison.amend('C1', 'E'), /房间关闭/)

  await post(external, '/lab?stage=local-change')
  liaison.config.now = '2026-11-20T09:40:00Z'
  liaison.state = null
  await liaison.load()
  await liaison.sync({ offers: false })
  // 尚未回读 offers 时仍不能凭校历取消安排更正。
  await assert.rejects(() => liaison.amend('C1', 'E'), /房间关闭/)
  await liaison.sync()

  const amended = await liaison.amend('C1', 'E')
  assert.equal(amended.session, 'C1')
  assert.ok(amended.results.some(result => result.receipt === 'f1' && !result.error))
  assert.ok(liaison.state.commitments.C1.amendments.length === 1)
})

test('暂留两边、分别接受，202 只代表收到、以回读为准', async t => {
  const { external, liaison } = await setup(t)
  await post(external, '/lab?stage=local-change')
  await liaison.sync({ full: true })
  // stage local-change 的下一站是 second-room（第一次 hold 后）。
  const first = await liaison.hold('C2', ['E'])
  assert.equal(first.holds[0].receipt, 'E-C2-1')
  liaison.config.now = '2026-11-20T09:20:00Z'
  liaison.state = null
  await liaison.load()
  await liaison.sync()
  const second = await liaison.hold('C2', ['W'])
  assert.equal(second.holds[0].receipt, 'W-C2-1')

  // held-c2 档：open 返回 202，回读仍是 held，不能算已开通。
  const opened = await liaison.open('C2', ['E', 'W'])
  assert.equal(opened.status, 202)
  assert.ok(opened.offers.every(row => row.state === 'held'))
  assert.match(opened.note, /回读/)

  // 切到 accepted：回读两边 live，才算真正接通。
  await post(external, '/lab?stage=accepted')
  liaison.state = null
  await liaison.load()
  const result = await liaison.sync()
  const c2 = result.plan.sessions.find(entry => entry.session === 'C2')
  assert.deepEqual(c2.opening.live.sort(), ['E', 'W'])
  assert.deepEqual(c2.evidence.E.states, ['live'])
  assert.equal(c2.eligibleToConfirm, true)
})

test('完整接力才可确认；确认记录真正发出的时刻', async t => {
  const { external, liaison } = await setup(t)
  await post(external, '/lab?stage=held')
  await liaison.sync({ full: true })

  await assert.rejects(() => liaison.confirm('C2'), /接力不完整/)

  const confirmed = await liaison.confirm('C1')
  assert.equal(confirmed.notification.kind, 'confirm')
  assert.ok(confirmed.notification.sentAt)
  assert.deepEqual(Object.keys(confirmed.notification.segments).sort(), ['lecture', 'questions'])

  const view = liaison.teacherView({ school: 'E', day: '2026-11-20' })
  const row = view.sessions.find(entry => entry.session === 'C1')
  assert.equal(row.lecture.interpreter, 'I')
  assert.equal(row.questions.interpreter, 'J')
  assert.deepEqual(row.connectedSides, ['E'])
  assert.equal(row.notificationSentAt, confirmed.notification.sentAt)
  assert.equal(row.lecture.localStart, '19:10')
})

test('教师视图按各自本地日展示两个环节与待窗口/待语种', async t => {
  const { liaison } = await setup(t)
  await liaison.sync({ full: true })
  const east = liaison.teacherView({ school: 'E', day: '2026-11-20' })
  const west = liaison.teacherView({ school: 'W', day: '2026-11-20' })
  const eastC1 = east.sessions.find(entry => entry.session === 'C1')
  const westC1 = west.sessions.find(entry => entry.session === 'C1')
  assert.equal(eastC1.lecture.localStart, '19:10')
  assert.equal(westC1.lecture.localStart, '22:10')
  assert.equal(eastC1.lecture.localDay, '2026-11-20')
  // C2 缺主讲，要明确写出仍在等合适语种。
  const eastC2 = east.sessions.find(entry => entry.session === 'C2')
  assert.ok(eastC2.waiting.some(text => text.includes('待合适语种')))
})

test('换资料版后按固定版取数，不会混用两版', async t => {
  const { source, liaison } = await setup(t)
  await liaison.sync({ full: true, edition: 'r1', calendars: false, offers: false })
  assert.equal(liaison.state.records.rooms.rows.find(row => row[0] === 'W' && row[1] === 'C1')[4], 'open')

  await post(source, '/control?edition=r2')
  liaison.state = null
  await liaison.load()
  await liaison.sync({ full: true, edition: 'r2', calendars: false, offers: false })
  assert.equal(liaison.state.records.rooms.rows.find(row => row[0] === 'W' && row[1] === 'C1')[4], 'closed')
  assert.equal(liaison.state.edition, 'r2')
})

test('已释放的环节不会被上游旧通知复活，重复同步也不重复记录释放', async t => {
  const { external, liaison } = await setup(t)
  await post(external, '/lab?stage=held')
  await liaison.sync({ full: true })
  await liaison.confirm('C1')
  assert.ok(liaison.state.commitments.C1.segments.lecture)

  await post(external, '/lab?stage=local-change')
  liaison.config.now = '2026-11-20T09:10:00Z'
  liaison.state = null
  await liaison.load()
  const first = await liaison.sync()
  assert.equal(first.plan.sessions.find(entry => entry.session === 'C1').assignments.lecture, undefined)

  // 再同步一次：上游 signed 流仍有 f1/f2，但本地已释放，不能复活；释放只记一次。
  liaison.config.now = '2026-11-20T09:20:00Z'
  liaison.state = null
  await liaison.load()
  const second = await liaison.sync()
  const c1 = second.plan.sessions.find(entry => entry.session === 'C1')
  assert.deepEqual(c1.assignments, {})
  // 本轮没有新的可释放环节（已在上轮释放），释放结论仍保留在承诺里。
  assert.equal(c1.releases.length, 0)
  assert.equal(liaison.state.notifications.filter(note => note.kind === 'release').length, 2)
  assert.equal(liaison.state.commitments.C1.releases.length, 2)
})

test('房间关闭但尚未通知家长：只标记房间不通，不擅自改约', async t => {
  const { liaison } = await setup(t)
  await liaison.sync({ full: true })
  const c1 = liaison.plan().sessions.find(entry => entry.session === 'C1')
  assert.equal(c1.closed, false)

  // C2 从未有任何通知；直接造一个「C2 的 W 侧房间关闭」的回读，验证不会擅自改约。
  const plan = buildPlan({
    state: liaison.state,
    offers: [
      { session: 'C2', by: 'E', state: 'held', receipt: 'h1' },
      { session: 'C2', by: 'W', state: 'closed' }
    ],
    records: loadRecords(liaison.state),
    timeZones: { E: 'Asia/Shanghai', W: 'Australia/Melbourne' },
    asOf: 600
  })
  const c2 = plan.sessions.find(entry => entry.session === 'C2')
  assert.equal(c2.closed, true)
  assert.equal(c2.needsReschedule, false)
  assert.equal(c2.status, 'room-closed')
})

test('确认后才计入占用；未确认课程可被挤到另一个可行解', async t => {
  const { external, liaison } = await setup(t)
  await post(external, '/lab?stage=held')
  await liaison.sync({ full: true })
  // C1 的确认让 I/J 的时段被锁定，C2 只能另找或等待。
  await liaison.confirm('C1')
  const plan = liaison.plan()
  const c1 = plan.sessions.find(entry => entry.session === 'C1')
  const c2 = plan.sessions.find(entry => entry.session === 'C2')
  assert.equal(c1.assignments.lecture.interpreter, 'I')
  assert.equal(c1.assignments.questions.interpreter, 'J')
  assert.equal(c2.completeRelay, false)
})
