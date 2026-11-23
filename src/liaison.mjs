// 编排：把来源资料、校历、房间开通实据和持久承诺串成可重复执行的流程。
// 所有写操作都要能被重复执行（sync 后再跑一次不会丢状态），并保留「何时真正发出通知」的日志。

import { loadConfig } from './config.mjs'
import { StateStore, ensureCommitment, logNotification } from './state.mjs'
import { buildPlan, SEGMENTS } from './planner.mjs'
import { ProviderClient } from './provider.mjs'
import { syncRecords, syncCalendars, refreshOffers, loadRecords } from './sync.mjs'
import { toMinute } from './time.mjs'

export class OperationError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'OperationError'
    this.detail = detail
  }
}

export class Liaison {
  constructor(config, { store, notifier } = {}) {
    this.config = config
    this.store = store || new StateStore(config.statePath)
    this.provider = new ProviderClient(config.providerBase, { timeout: config.timeout })
    this.notifier = notifier || defaultNotifier
    this.state = null
  }

  async load() {
    if (!this.state) this.state = await this.store.load()
    return this.state
  }

  async save() {
    await this.store.save(this.state)
  }

  now() {
    return this.config.now ? new Date(this.config.now) : new Date()
  }

  asOf() {
    return toMinute(this.now().getTime())
  }

  timeZones() {
    return Object.fromEntries(Object.entries(this.config.schools).map(([school, value]) => [school, value.timeZone]))
  }

  // 一次完整同步：固定资料版取业务流 -> 校历增量/全量 -> 回读房间实据 -> 复核承诺。
  async sync({ full = false, edition, calendars = true, offers = true } = {}) {
    const state = await this.load()
    const recordResult = await syncRecords({ config: this.config, state, edition })
    if (calendars) {
      await syncCalendars({ config: this.config, state, schools: Object.keys(this.config.schools), full })
    }
    if (offers) await refreshOffers({ config: this.config, state })
    const planResult = this.plan()
    this.reconcile(planResult)
    await this.save()
    return {
      edition: recordResult.edition,
      records: recordResult.updates,
      calendars: state.calendars,
      offers: state.offers,
      plan: planResult
    }
  }

  plan({ offers } = {}) {
    const state = this.state
    const records = loadRecords(state)
    return buildPlan({
      records,
      state,
      offers: offers || state.offers || [],
      timeZones: this.timeZones(),
      asOf: this.asOf()
    })
  }

  // 把计划里的「关闭后必须做」的结论落到承诺状态：
  // - 未开始的环节释放，记录释放时刻与释放人；
  // - 已通知家长的课程进入改约队列，发通知前保持 pending；
  // - 已经上完的课堂不受影响。
  reconcile(planResult) {
    const state = this.state
    // 已上完的课堂：把原资源快照持久化。之后校历范围缩小或资料版变化时，
    // 这些课堂仍能查到原资源，并且永远不会回到择配名单。
    state.completed = state.completed || {}
    for (const entry of planResult.completed) {
      const existing = state.completed[entry.session]
      state.completed[entry.session] = {
        session: entry.session,
        schools: entry.schools,
        windows: { ...(existing?.windows || {}), ...entry.windows },
        originals: entry.originals || (existing?.originals || []),
        recordedAt: existing?.recordedAt || new Date().toISOString()
      }
    }
    for (const entry of planResult.commitments) {
      const commitment = ensureCommitment(state, entry.session)
      commitment.state = entry.status
      commitment.needsReschedule = entry.needsReschedule
      commitment.lastEvaluatedAt = new Date().toISOString()
      commitment.sides = Object.fromEntries(entry.sides.map(side => [side.school, {
        ok: side.ok,
        room: side.room,
        calendar: side.calendar,
        reasons: side.reasons
      }]))
      commitment.openings = entry.opening
      if (entry.notifiedAt && !commitment.notifiedAt) commitment.notifiedAt = entry.notifiedAt
      if (entry.releasedSegments?.length && !commitment.releasedAt) {
        // 释放发生的时刻只在第一次落状态时记下，后续同步不覆盖。
        commitment.releasedAt = this.now().toISOString()
      }
      if (entry.needsReschedule && !commitment.rescheduleQueuedAt) {
        commitment.rescheduleQueuedAt = this.now().toISOString()
        const pending = (state.notifications || []).some(note =>
          note.session === entry.session && note.kind === 'reschedule' && note.status === 'pending')
        if (!pending) {
          logNotification(state, {
            id: 'reschedule-' + entry.session + '-' + Date.now(),
            session: entry.session,
            kind: 'reschedule',
            status: 'pending',
            reason: entry.closures.filter(closure => closure.closed)
              .map(closure => closure.school + ' 方房间已关闭').join('；'),
            queuedAt: this.now().toISOString(),
            sentAt: null
          })
        }
      }
      for (const release of entry.releases) {
        // 一个环节只释放一次；后续同步里 asOf 变化不应重复记录。
        const duplicate = (commitment.releases || []).some(item =>
          item.segment === release.segment)
        if (!duplicate) {
          commitment.releases = [...(commitment.releases || []), {
            session: release.session,
            segment: release.segment,
            interpreter: release.interpreter,
            credential: release.credential,
            start: release.start,
            releaseBy: release.releaseBy,
            releasedAt: release.releasedAt,
            reason: release.reason
          }]
          logNotification(state, {
            id: 'release-' + entry.session + '-' + release.segment,
            session: entry.session,
            kind: 'release',
            status: 'recorded',
            reason: release.reason,
            releaseBy: release.releaseBy,
            queuedAt: this.now().toISOString(),
            sentAt: this.now().toISOString()
          })
        }
      }
    }
  }

  // 会议室：先两边各暂留，再分别接受。暂留凭据用于后续 open。
  // 已出现关闭实据的一侧不能再暂留；未关闭的一侧仍可继续，便于改约新时段后的接力。
  async hold(sessionId, schools) {
    const state = await this.load()
    const planResult = this.plan()
    const entry = findSession(planResult, sessionId)
    if (!entry) throw new OperationError('没有该课堂: ' + sessionId)
    const closedSides = new Set(entry.closures.filter(closure => closure.closed).map(closure => closure.school))
    const targets = schools && schools.length ? schools : entry.schools
    const holds = state.holds[sessionId] || (state.holds[sessionId] = {})
    const results = []
    for (const school of targets) {
      if (!entry.schools.includes(school)) throw new OperationError('该课堂不涉及学校 ' + school)
      if (closedSides.has(school)) {
        throw new OperationError('学校 ' + school + ' 的房间已确认关闭，不能再暂留；请先安排更正或改约')
      }
      const existing = holds[school]
      if (existing && existing.receipt) {
        results.push({ school, receipt: existing.receipt, reused: true })
        continue
      }
      const response = await this.provider.hold(sessionId, school)
      if (!response.receipt) {
        throw new OperationError('暂留未返回凭据', { school, response })
      }
      holds[school] = {
        receipt: String(response.receipt),
        by: school,
        at: this.now().toISOString(),
        status: 'received'
      }
      results.push({ school, receipt: holds[school].receipt, status: response.status })
    }
    await this.save()
    return { session: sessionId, holds: results }
  }

  // 两边都有暂留凭据后才请校方开通；202 只代表收到，实际开通仍以 offers 回读为准。
  async open(sessionId, schools) {
    const state = await this.load()
    const planResult = this.plan()
    const entry = findSession(planResult, sessionId)
    if (!entry) throw new OperationError('没有该课堂: ' + sessionId)
    const closedSides = new Set(entry.closures.filter(closure => closure.closed).map(closure => closure.school))
    const holds = state.holds[sessionId] || {}
    const targets = schools && schools.length ? schools : entry.schools
    for (const school of targets) {
      if (closedSides.has(school)) {
        throw new OperationError('学校 ' + school + ' 的房间已确认关闭，不能开通；请先安排更正或改约')
      }
      if (!holds[school]?.receipt) throw new OperationError('学校 ' + school + ' 尚未暂留，请先 hold')
    }
    const receipts = targets.map(school => holds[school].receipt)
    const response = await this.provider.open(sessionId, receipts)
    const receipt = response.receipt ? String(response.receipt) : null
    if (receipt) state.openRequests = { ...(state.openRequests || {}), [sessionId]: { receipt, at: this.now().toISOString() } }
    const offers = await refreshOffers({ config: this.config, state })
    await this.save()
    const after = offers.filter(row => row.session === sessionId)
    return {
      session: sessionId,
      status: response.status,
      receipt,
      note: '202 只表示收到，实际开通以下方回读为准',
      offers: after
    }
  }

  // 只有完整接力（两个环节都落实）且没有关闭/窗口问题才放行。
  async confirm(sessionId, { schools, kind = 'confirm' } = {}) {
    const state = await this.load()
    const planResult = this.plan()
    const entry = findSession(planResult, sessionId)
    if (!entry) throw new OperationError('没有该课堂: ' + sessionId)
    if (!entry.completeRelay) {
      throw new OperationError('接力不完整，不能请两边确认', {
        missing: entry.missingSegments,
        issues: entry.issues
      })
    }
    if (!entry.eligibleToConfirm) {
      throw new OperationError('窗口或房间仍有问题，不能请两边确认', { issues: entry.issues })
    }
    // 重新核一遍两个环节的人仍未被别处占用（计划里的占用可能因并发查看而过期）。
    const merged = [...planResult.occupied]
    for (const segment of SEGMENTS) {
      const chosen = entry.assignments[segment.key]
      const clash = merged.some(item => item.session !== sessionId && item.interpreter === chosen.interpreter &&
        item.span.start < entry.times[segment.key].end && item.span.end > entry.times[segment.key].start)
      if (clash) {
        throw new OperationError('口译员在确认前被其他课堂占用，接力不再成立', {
          segment: segment.key, interpreter: chosen.interpreter, clash: clash.session
        })
      }
    }
    for (const side of entry.sides) {
      // 房间是连线的必要条件：每一方至少已有暂留（held）或开通（open/live）实据，
      // 且不能有任一方被回读为 closed。
      const evidence = state.offers?.filter(row => row.session === sessionId && row.by === side.school) || []
      const held = state.holds?.[sessionId]?.[side.school]
      if (evidence.length === 0 && !held) {
        throw new OperationError('学校 ' + side.school + ' 还没有房间暂留或开通实据，不能请两边确认')
      }
      if (evidence.some(row => row.state === 'closed')) {
        throw new OperationError('学校 ' + side.school + ' 房间已关闭，不能请两边确认')
      }
    }
    const commitment = ensureCommitment(state, sessionId)
    commitment.segments = Object.fromEntries(SEGMENTS.map(segment => {
      const chosen = entry.assignments[segment.key]
      return [segment.key, chosen ? {
        interpreter: chosen.interpreter,
        credential: chosen.credential,
        state: chosen.origin === 'planned' ? 'notified' : chosen.state
      } : null]
    }))
    commitment.state = 'notified'
    commitment.notifiedAt = commitment.notifiedAt || this.now().toISOString()
    const targets = schools && schools.length ? schools : entry.schools
    commitment.confirmedSides = [...new Set([...(commitment.confirmedSides || []), ...targets])]
    const notification = await this.dispatch({
      session: sessionId,
      kind,
      status: 'sent',
      reason: '完整接力，请两边确认',
      segments: commitment.segments
    })
    // 通知送达后才占用资源；这里立刻保存，避免并发查看时看到未占用的空档。
    await this.save()
    return { session: sessionId, notifiedAt: commitment.notifiedAt, notification }
  }

  // 更正：只有在某地确实关闭对应房间之后才允许，且使用原通知号。
  // 更正针对原承诺（原通知号），不要求关闭发生在同一封通知发出的一侧；
  // 逐个原通知号尝试，把每个回执结果如实带回。
  async amend(sessionId, by) {
    const state = await this.load()
    const planResult = this.plan()
    const entry = findSession(planResult, sessionId)
    if (!entry) throw new OperationError('没有该课堂: ' + sessionId)
    const closed = entry.closures.filter(item => item.closed)
    if (closed.length === 0) {
      throw new OperationError('还没有任何一地出现房间关闭的实据，不能安排更正')
    }
    const commitments = state.commitments?.[sessionId]
    const receipts = []
    const add = value => {
      if (value && value !== '-' && !receipts.includes(value)) receipts.push(value)
    }
    for (const row of state.records?.signed?.rows || []) {
      if (row[0] === sessionId) add(row[3])
    }
    for (const row of state.offers || []) {
      if (row.session === sessionId && row.by === by) add(row.receipt)
    }
    if (commitments?.originalReceipt) add(commitments.originalReceipt)
    // open 请求的回执也是与原承诺同一批的资源凭据，可以在更正里一并带上。
    if (state.openRequests?.[sessionId]?.receipt) add(state.openRequests[sessionId].receipt)
    if (receipts.length === 0) throw new OperationError('找不到原通知号，无法更正')
    const results = []
    for (const receipt of receipts) {
      try {
        const response = await this.provider.amend(sessionId, by, receipt)
        results.push({ receipt, status: response.status, state: response.state, newReceipt: response.receipt || null })
      } catch (error) {
        results.push({ receipt, error: error.message, status: error.status ?? null })
      }
    }
    if (!results.some(result => !result.error)) {
      throw new OperationError('更正没有送达（原通知号均未被接受）', { results })
    }
    const offers = await refreshOffers({ config: this.config, state })
    const commitment = ensureCommitment(state, sessionId)
    if (!commitment.amendments) commitment.amendments = []
    commitment.amendments.push({ by, at: this.now().toISOString(), closed: closed.map(item => item.school), results })
    await this.save()
    return { session: sessionId, by, closedSides: closed.map(item => item.school), results, offers: offers.filter(row => row.session === sessionId) }
  }

  // 真正发出通知：每个待发通知只发一次，并记录送达时刻。
  async dispatch({ session, kind, status = 'sent', reason = null, segments = null }) {
    const state = await this.load()
    const sentAt = this.now().toISOString()
    const record = {
      id: kind + '-' + session + '-' + Date.now(),
      session,
      kind,
      status,
      reason,
      segments,
      queuedAt: sentAt,
      sentAt
    }
    const result = await this.notifier(record)
    if (result && result.receipt) record.receipt = result.receipt
    logNotification(state, record)
    return record
  }

  async notify(sessionId, { kind = 'reschedule', message } = {}) {
    const state = await this.load()
    const planResult = this.plan()
    const entry = findSession(planResult, sessionId)
    if (!entry) throw new OperationError('没有该课堂: ' + sessionId)
    if (kind === 'confirm') return this.confirm(sessionId, { kind: 'confirm' })
    if (kind !== 'reschedule') throw new OperationError('未知通知类型: ' + kind)
    if (!entry.needsReschedule) {
      throw new OperationError('该课堂没有需要改约的关闭实据')
    }
    const pending = (state.notifications || []).find(note =>
      note.session === sessionId && note.kind === kind && note.status === 'pending')
    const record = await this.dispatch({
      session: sessionId,
      kind,
      reason: message || pending?.reason || null
    })
    if (pending) pending.status = 'completed'
    const commitment = ensureCommitment(state, sessionId)
    commitment.rescheduleNotifiedAt = record.sentAt
    await this.save()
    return record
  }

  // 教师视图：按某校本地日列出两个环节、已有实据的一侧、仍待窗口或语种的环节，
  // 以及真正发出通知的时刻。
  teacherView({ school, day }) {
    const planResult = this.plan()
    if (!this.config.schools[school]) throw new OperationError('未知学校: ' + school)
    const timeZone = this.config.schools[school].timeZone
    const rows = []
    for (const entry of planResult.sessions) {
      if (!entry.schools.includes(school)) continue
      const lectureDay = entry.local[school].lecture.day
      const questionsDay = entry.local[school].questions.day
      if (day && lectureDay !== day && questionsDay !== day) continue
      rows.push(describeTeacherRow(entry, school, timeZone, this.state))
    }
    const completed = planResult.completed
      .filter(entry => entry.schools.includes(school))
      .map(entry => ({ ...entry, status: 'completed' }))
    rows.sort((a, b) => a.lecture.start - b.lecture.start || a.session.localeCompare(b.session))
    return {
      school,
      timeZone,
      day: day || null,
      sessions: rows,
      completed,
      releases: planResult.releases.filter(release => rows.some(row => row.session === release.session)),
      reschedules: rows.filter(row => row.needsReschedule)
    }
  }
}

function findSession(planResult, sessionId) {
  return planResult.sessions.find(entry => entry.session === sessionId)
}

function waitingFor(entry) {
  const waiting = []
  for (const side of entry.sides) {
    for (const reason of side.reasons) {
      if (reason.includes('禁止使用时段')) {
        const blocked = side.blocked.map(item => item.uid + (item.school !== side.school ? '（' + item.school + ' 公布）' : ''))
        waiting.push('窗口：禁止使用时段 ' + blocked.join('、') + '，待另一共同窗口')
      } else if (reason.includes('已取消')) {
        waiting.push(side.school + ' 方校历已移除该课堂窗口，待该校重新公布共同窗口')
      } else if (reason.includes('尚未同步') || reason.includes('未公布')) {
        waiting.push(side.school + ' 方校历尚未给出该课堂窗口')
      } else {
        waiting.push(side.school + ' 方' + reason)
      }
    }
  }
  for (const segment of SEGMENTS) {
    if (entry.assignments[segment.key]) continue
    if (entry.missingSegments && !entry.missingSegments.includes(segment.key)) continue
    const reasons = entry.segmentReasons?.[segment.key]
    if (reasons?.language?.length) waiting.push(segment.label + '：待合适语种（' + reasons.language.join('、') + '）')
    if (reasons?.availability?.length) waiting.push(segment.label + '：待共同可用时段（' + reasons.availability.join('、') + '）')
    if (reasons?.clash?.length) waiting.push(segment.label + '：人员被其他课堂占用（' + reasons.clash.join('、') + '）')
    if (!reasons && entry.committed) waiting.push(segment.label + '：原承诺已释放，待重新安排口译')
  }
  return [...new Set(waiting)]
}

function describeTeacherRow(entry, school, timeZone, state) {
  const segments = {}
  for (const segment of SEGMENTS) {
    const chosen = entry.assignments[segment.key]
    const span = entry.times[segment.key]
    const clock = entry.local[school][segment.key]
    segments[segment.key] = {
      start: span.start,
      end: span.end,
      localDay: clock.day,
      localStart: clock.startText,
      localEnd: clock.endText,
      interpreter: chosen?.interpreter || null,
      state: chosen?.state || 'pending',
      origin: chosen?.origin || null
    }
  }
  const evidence = {}
  for (const side of entry.schools) {
    const detail = entry.evidence?.[side] || { states: [] }
    evidence[side] = {
      states: detail.states,
      accepted: detail.live || detail.open,
      held: detail.held,
      closed: detail.closed,
      calendar: detail.calendar,
      receipt: detail.receipt
    }
  }
  const notifications = (state.notifications || [])
    .filter(note => note.session === entry.session)
    .map(note => ({
      kind: note.kind,
      status: note.status,
      queuedAt: note.queuedAt,
      sentAt: note.sentAt,
      releaseBy: note.releaseBy ?? null,
      reason: note.reason
    }))
  // 「真正改发通知」只统计发给两校/家长的通知，不含内部释放记录。
  const sent = notifications.filter(note =>
    note.sentAt && (note.kind === 'confirm' || note.kind === 'reschedule'))
  const lastNotification = sent.at(-1) || null
  return {
    session: entry.session,
    status: entry.status,
    schools: entry.schools,
    slot: entry.slots[school],
    lecture: segments.lecture,
    questions: segments.questions,
    evidence,
    connectedSides: entry.schools.filter(side => evidence[side].accepted),
    waiting: waitingFor(entry),
    needsReschedule: entry.needsReschedule,
    completeRelay: entry.completeRelay,
    notifiedAt: entry.notifiedAt || null,
    notificationSentAt: lastNotification?.sentAt || null,
    notifications
  }
}

export async function withLiaison(options, run) {
  const config = loadConfig(options.config)
  const liaison = new Liaison(config, options)
  await liaison.load()
  return run(liaison)
}

export const defaultNotifier = async record => ({ receipt: 'local-' + record.id })

