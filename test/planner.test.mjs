import assert from 'node:assert/strict'
import test from 'node:test'
import { buildPlan, SEGMENTS, sourceCalendarWindow, roomState } from '../src/planner.mjs'
import { parseCalendar, parseRoster, parseRooms, parseSessions, parseSigned, parseTimeZones } from '../src/records.mjs'

const TIME_ZONES = { E: 'Asia/Shanghai', W: 'Australia/Melbourne' }

function baseRecords(overrides = {}) {
  return {
    calendar: parseCalendar([
      ['E', 'X', '20', '1140', '1200'],
      ['W', 'Y', '20', '1320', '1380'],
      ['E', 'Z', '20', '1160', '1230'],
      ['W', 'Q', '20', '1340', '1410']
    ]),
    tz: parseTimeZones([['E', '20', '480'], ['W', '20', '660']]),
    rooms: parseRooms([
      ['E', 'C1', '660', '720', 'open'],
      ['W', 'C1', '660', '720', 'open'],
      ['E', 'C2', '680', '750', 'open'],
      ['W', 'C2', '680', '750', 'open']
    ]),
    sessions: parseSessions([
      ['C1', 'E,W', 'X,Y', '670', '690', '690', '700', 'zh-en', 'en-zh'],
      ['C2', 'E,W', 'Z,Q', '685', '700', '700', '715', 'zh-en', 'en-zh']
    ]),
    roster: parseRoster([
      ['I', '660', '705', 'zh-en'],
      ['I2', '665', '685', 'zh-en'],
      ['J', '685', '735', 'en-zh']
    ]),
    signed: parseSigned([
      ['C1', 'I', 'lecture', 'f1', 'notified'],
      ['C1', 'J', 'questions', 'f2', 'notified']
    ]),
    ...overrides
  }
}

function baseState() {
  return {
    calendars: {
      E: {
        lastSyncAt: 'x',
        published: {
          'C1-E': { uid: 'C1-E', start: 660, end: 720, status: 'CONFIRMED', blocked: false },
          'C2-E': { uid: 'C2-E', start: 680, end: 750, status: 'CONFIRMED', blocked: false }
        }
      },
      W: {
        lastSyncAt: 'x',
        published: {
          'C1-W': { uid: 'C1-W', start: 660, end: 720, status: 'CONFIRMED', blocked: false },
          'C2-W': { uid: 'C2-W', start: 680, end: 750, status: 'CONFIRMED', blocked: false }
        }
      }
    },
    holds: {},
    commitments: {},
    notifications: []
  }
}

function run(options = {}) {
  return buildPlan({
    records: options.records || baseRecords(),
    state: options.state || baseState(),
    offers: options.offers || [],
    timeZones: TIME_ZONES,
    asOf: options.asOf ?? 600
  })
}

test('窗口：本地日历格、房间、校历与禁止时窗都要成立', () => {
  const records = baseRecords()
  // C1 的 W 侧槽 Y（当地 22:00–23:00，UTC 660–720）在 670–700 内成立。
  const session = records.sessions[0]
  const ok = sourceCalendarWindow(records, 'W', 'Y', 670)
  assert.deepEqual(ok.window, { start: 660, end: 720 })
  const room = roomState(records, 'E', 'C1', { start: 670, end: 700 })
  assert.equal(room.state, 'open')

  const plan = run()
  const c1 = plan.sessions.find(entry => entry.session === 'C1')
  assert.equal(c1.sides.every(side => side.ok), true)
  assert.equal(c1.completeRelay, true)
  // C1 已通知，两个环节由 I 与 J 分别接；C2 未被 C1 挤占后仍缺主讲（I2 只到 685，I 被占）。
  const c2 = plan.sessions.find(entry => entry.session === 'C2')
  assert.equal(c2.completeRelay, false)
  assert.deepEqual(c2.missingSegments, ['lecture'])
})

test('同一人不能同时接两个班；环节边界相接可以接续', () => {
  const records = baseRecords({
    signed: parseSigned([]),
    roster: parseRoster([['I', '660', '760', 'zh-en,en-zh']])
  })
  const plan = run({ records })
  // 只有一个口译员：C1 主讲 670–690 与 C1 问答 690–700 可接续，
  // 但 C2 两个环节都与人重叠，因此 C2 不能完整接力，且不会偷占已通知资源。
  const c1 = plan.sessions.find(entry => entry.session === 'C1')
  assert.equal(c1.completeRelay, true)
  assert.equal(c1.assignments.lecture.interpreter, 'I')
  assert.equal(c1.assignments.questions.interpreter, 'I')
  const c2 = plan.sessions.find(entry => entry.session === 'C2')
  assert.equal(c2.completeRelay, false)
})

test('未确认课程不占人：一个未落实的课不会长期挤占别班可用人员', () => {
  // 让 C1 缺少主讲（未通知），C2 的主讲与问答都可用 I。
  const records = baseRecords({
    signed: parseSigned([]),
    roster: parseRoster([
      ['I', '660', '760', 'zh-en,en-zh'],
      ['J', '660', '760', 'zh-en,en-zh']
    ])
  })
  const plan = run({ records })
  assert.ok(plan.ready.length >= 1)
  // 每个 ready 课堂都完整接力，且不存在同一人同时出现在重叠时段。
  const spans = []
  for (const entry of plan.ready) {
    for (const segment of SEGMENTS) {
      spans.push({ interpreter: entry.assignments[segment.key].interpreter, span: entry.times[segment.key] })
    }
  }
  for (const left of spans) {
    for (const right of spans) {
      if (left === right) continue
      if (left.interpreter !== right.interpreter) continue
      assert.ok(left.span.end <= right.span.start || right.span.end <= left.span.start)
    }
  }
})

test('只有完整接力才允许请两边确认', () => {
  const plan = run({ offers: [
    { session: 'C1', by: 'E', state: 'open', receipt: 'f1' },
    { session: 'C1', by: 'W', state: 'held' },
    { session: 'C2', by: 'E', state: 'held', receipt: 'h1' },
    { session: 'C2', by: 'W', state: 'held', receipt: 'h2' }
  ] })
  const c1 = plan.sessions.find(entry => entry.session === 'C1')
  const c2 = plan.sessions.find(entry => entry.session === 'C2')
  assert.equal(c1.eligibleToConfirm, true)
  assert.equal(c2.eligibleToConfirm, false)
})

test('已上完课堂保留原资源，不进入择配', () => {
  const records = baseRecords({
    signed: parseSigned([
      ['C1', 'I', 'lecture', 'f1', 'notified'],
      ['C1', 'J', 'questions', 'f2', 'notified'],
      ['C0', 'I', 'lecture', 'f0', 'completed']
    ])
  })
  const plan = run({ records })
  assert.ok(plan.completed.some(entry => entry.session === 'C0'))
  assert.ok(!plan.sessions.some(entry => entry.session === 'C0'))
  assert.ok(!plan.ready.some(entry => entry.session === 'C0'))
})

test('房间关闭：未开始环节释放，已通知课堂进入改约', () => {
  const state = baseState()
  state.commitments = {
    C1: { session: 'C1', state: 'notified', notifiedAt: '2026-11-20T09:00:00.000Z', segments: {} }
  }
  const plan = run({
    state,
    asOf: 650,
    offers: [
      { session: 'C1', by: 'E', state: 'open', receipt: 'f1' },
      { session: 'C1', by: 'W', state: 'closed' }
    ]
  })
  const c1 = plan.sessions.find(entry => entry.session === 'C1')
  assert.equal(c1.needsReschedule, true)
  assert.equal(c1.releases.length, 2)
  for (const release of c1.releases) {
    assert.equal(release.releasedAt, 650)
    assert.equal(release.releaseBy, release.start)
    assert.ok(release.releasedAt < release.start)
  }
  assert.equal(c1.assignments.lecture, undefined)
  assert.deepEqual(plan.reschedules.map(entry => entry.session), ['C1'])
})

test('房间关闭但课堂已开始：不释放已开始环节，改约', () => {
  const state = baseState()
  state.commitments = {
    C1: { session: 'C1', state: 'notified', notifiedAt: '2026-11-20T09:00:00.000Z', segments: {} }
  }
  // 主讲 670–690 已开始（asOf=685）；问答 690–700 尚未开始。
  const plan = run({
    state,
    asOf: 685,
    offers: [
      { session: 'C1', by: 'E', state: 'open', receipt: 'f1' },
      { session: 'C1', by: 'W', state: 'closed' }
    ]
  })
  const c1 = plan.sessions.find(entry => entry.session === 'C1')
  assert.deepEqual(c1.releases.map(release => release.segment), ['questions'])
  assert.deepEqual(c1.startedSegments, ['lecture'])
  assert.equal(c1.assignments.lecture.interpreter, 'I')
  assert.equal(c1.needsReschedule, true)
})

test('跨零点的禁止时窗影响另一地课程', () => {
  const state = baseState()
  // blocked-W 22:45–00:30（UTC 765–810）在墨尔本当地跨零点；它应否决与之重叠的任何课程。
  state.calendars.W.published['blocked-W'] = {
    uid: 'blocked-W', start: 765, end: 810, status: 'CONFIRMED', blocked: true, school: 'W'
  }
  const records = baseRecords({
    signed: parseSigned([]),
    sessions: parseSessions([['C3', 'E,W', 'X,Y', '760', '790', '790', '800', 'zh-en', 'en-zh']]),
    rooms: parseRooms([
      ['E', 'C3', '740', '820', 'open'],
      ['W', 'C3', '740', '820', 'open']
    ]),
    calendar: parseCalendar([
      ['E', 'X', '20', '1200', '1260'],
      ['W', 'Y', '20', '1200', '1260']
    ]),
    roster: parseRoster([['I', '700', '820', 'zh-en'], ['J', '700', '820', 'en-zh']])
  })
  const plan = run({ records, state })
  const c3 = plan.sessions.find(entry => entry.session === 'C3')
  assert.equal(c3.sides.every(side => side.ok), false)
  const reasons = c3.sides.flatMap(side => side.reasons).join('\n')
  assert.match(reasons, /禁止使用时段 blocked-W/)
  assert.equal(c3.status, 'blocked')
})

test('校历中 CANCELLED 的课堂窗口不会被当作开放', () => {
  const state = baseState()
  state.calendars.W.published['C1-W'] = {
    uid: 'C1-W', start: 660, end: 720, status: 'CANCELLED', blocked: false
  }
  const plan = run({ state })
  const c1 = plan.sessions.find(entry => entry.session === 'C1')
  const west = c1.sides.find(side => side.school === 'W')
  assert.equal(west.calendar, 'cancelled')
  assert.equal(west.ok, false)
  assert.equal(c1.needsReschedule, false)
  assert.equal(c1.waitingWindow, true)
})

test('已发出的确认持续占住原承诺的人员', () => {
  // 来源 signed 流里没有 C1 的签署，但工具已发过确认；确认记录必须继续占用 I/J。
  const records = baseRecords({ signed: parseSigned([]) })
  const state = baseState()
  state.commitments = {
    C1: {
      session: 'C1',
      state: 'notified',
      notifiedAt: '2026-11-20T09:00:00.000Z',
      segments: {
        lecture: { interpreter: 'I', credential: null, state: 'notified' },
        questions: { interpreter: 'J', credential: null, state: 'notified' }
      }
    }
  }
  const plan = run({ records, state })
  const c1 = plan.sessions.find(entry => entry.session === 'C1')
  assert.equal(c1.committed, true)
  assert.equal(c1.assignments.lecture.interpreter, 'I')
  assert.equal(c1.assignments.questions.interpreter, 'J')
  assert.equal(c1.completeRelay, true)
  // 因此 C2 的主讲没有可用人选：I 被承诺占用、I2 可用时段不够、J 语种不对。
  const c2 = plan.sessions.find(entry => entry.session === 'C2')
  assert.equal(c2.completeRelay, false)
  assert.deepEqual(c2.missingSegments, ['lecture'])
})
