// 排班与窗口判定。这个模块不发声、不写状态，只根据「当前资料 + 已发布校历 + 已回读的房间状态」
// 算出一份解释结果，供命令行、通知与教师视图共用。
//
// 规则要点：
// - 两个环节（主讲、问答）各自独立指派，可由不同人接；同一人不能在同一时段被两个班占用。
// - 只有完整接力（两个环节都落实）才允许请两边确认。
// - 有效通知（notified 等）的课程先占住资源；未确认课程不得挤占它们。
// - 已上完（completed）的课程永远保留原资源，不进入重新择配。
// - 房间确实关闭后才释放未开始的口译段，并列入改约名单。
// - 仍有共同窗口的独立课堂继续推进；未落实的课不会长期占着别人能用的人。

import { overlaps } from './time.mjs'

export const SEGMENTS = [
  { key: 'lecture', label: '主讲' },
  { key: 'questions', label: '问答' }
]

export const ACTIVE_SIGNED = new Set(['notified', 'confirmed', 'accepted', 'live', 'sent'])
export const COMPLETED_SIGNED = new Set(['completed', 'done'])
export const INACTIVE_SIGNED = new Set(['cancelled', 'canceled', 'superseded', 'released', 'withdrawn'])
function latestSignedRows(rows) {
  const latest = new Map()
  for (const row of rows) latest.set(row.session + '\u0000' + row.segment, row)
  return [...latest.values()]
}

// 业务日历格（学校、日历格、当地日、开闭本地分钟）-> UTC 分钟区间。
// calendar 流的时间列是当地分钟（自该当地日零点），rooms/sessions 是自 2026-11-20T00:00Z 的 UTC 分钟。
function offsetFor(records, school, minute) {
  const rows = records.tz.filter(row => row.school === school)
  for (const row of rows) {
    const day = 20 + Math.floor((minute + row.offset) / 1440)
    if (String(day) === row.day) return row.offset
  }
  return null
}

export function sourceCalendarWindow(records, school, slot, minute) {
  const offset = offsetFor(records, school, minute)
  if (offset === null) return { window: null, reason: '缺少该日时区偏移' }
  const day = String(20 + Math.floor((minute + offset) / 1440))
  const row = records.calendar.find(item => item.school === school && item.slot === slot && item.day === day)
  if (!row) return { window: null, reason: '本地日 ' + day + ' 没有日历格 ' + slot }
  return { window: { start: row.open - offset, end: row.close - offset }, offset, day }
}

function covering(window, span) {
  return Boolean(window) && window.start <= span.start && window.end >= span.end
}

export function roomState(records, school, room, span) {
  // rooms 流的开闭列是 UTC 分钟；转成 {start,end} 后才能和课程时段比较。
  const rows = records.rooms
    .filter(row => row.school === school && row.room === room)
    .map(row => ({ start: row.open, end: row.close, state: row.state, raw: row.raw }))
  const closed = rows.filter(row => row.state !== 'open' && overlaps(row, span))
  if (closed.length) return { state: 'closed', rows }
  const open = rows.filter(row => row.state === 'open' && covering(row, span))
  if (open.length) return { state: 'open', rows: open }
  const overlapping = rows.filter(row => row.state === 'open' && overlaps(row, span))
  return { state: overlapping.length ? 'partial' : 'none', rows: overlapping }
}

// 校历里已发布的课堂时窗。同步会保留 CANCELLED 墓碑，这里再拦一次，
// 保证任何调用方都不会把取消件继续当作开放。
export function publishedWindow(state, school, uid, span) {
  const calendar = state.calendars?.[school]
  if (!calendar || !calendar.lastSyncAt) return { state: 'unknown', window: null }
  const entry = calendar.published?.[uid]
  if (!entry) return { state: 'missing', window: null }
  if (entry.status === 'CANCELLED' || INACTIVE_SIGNED.has(String(entry.status).toLowerCase())) {
    return { state: 'cancelled', window: null, entry }
  }
  const window = { start: entry.start, end: entry.end }
  return { state: covering(window, span) ? 'open' : 'outside', window, entry }
}

export function blockedAt(state, span) {
  // 禁止时窗按真实 UTC 时刻生效，不按本地日截断：跨零点的 blocked-W 会延续到真实的
  // 结束时刻，因此也会压在另一校当地的课程时段上。禁止时窗由某一校公布，但连线要求
  // 两边同时可用，所以任一方公布的禁止时窗都足以否决整节课。
  const hits = []
  for (const [owner, calendar] of Object.entries(state.calendars || {})) {
    for (const entry of Object.values(calendar.published || {})) {
      if (!entry.blocked) continue
      if (INACTIVE_SIGNED.has(String(entry.status).toLowerCase())) continue
      if (overlaps(entry, span)) hits.push({ ...entry, school: owner })
    }
  }
  return hits
}

// 一侧（学校）的窗口解释：业务日历格 + 房间 + 该校校历时窗 + 禁止时段。
export function sideWindow(records, state, session, school, span) {
  const slot = session.slotsBySchool[school]
  const slotResult = sourceCalendarWindow(records, school, slot, span.start)
  const room = roomState(records, school, session.session, span)
  const ics = publishedWindow(state, school, session.session + '-' + school, span)
  const blocked = blockedAt(state, span)
  const reasons = []
  if (!slotResult.window) reasons.push('窗口：' + slotResult.reason)
  else if (!covering(slotResult.window, span)) reasons.push('窗口：本地日历格未覆盖整节课')
  if (room.state === 'closed') reasons.push('房间：该校房间在课程时段关闭')
  else if (room.state === 'partial') reasons.push('房间：开放时段没有覆盖整节课')
  else if (room.state === 'none') reasons.push('房间：没有该课堂的开放记录')
  if (ics.state === 'unknown') reasons.push('窗口：该校校历尚未同步')
  else if (ics.state === 'cancelled') reasons.push('房间：该校校历已取消该课堂')
  else if (ics.state === 'missing') reasons.push('房间：该校校历未公布该课堂')
  else if (ics.state === 'outside') reasons.push('窗口：该校校历未覆盖整节课')
  if (blocked.length) reasons.push('房间：落在禁止使用时段 ' + blocked.map(entry => entry.uid).join('、'))
  return {
    school,
    slot,
    slotWindow: slotResult.window,
    slotDay: slotResult.day || null,
    room: room.state,
    roomWindows: room.rows.map(row => ({ start: row.start, end: row.end, state: row.state })),
    calendar: ics.state,
    calendarWindow: ics.window,
    blocked: blocked.map(entry => ({ uid: entry.uid, start: entry.start, end: entry.end, timeZone: entry.timeZone, school: entry.school })),
    ok: reasons.length === 0,
    reasons
  }
}

// 房间关闭实据：以 offers 回读为准；来源 rooms 只作补充。
// 校历里的 CANCELLED 只移除该校公布的可用时窗，不等于「房间确实关闭」，
// 因此单列为 windowRemoved，用于改约判断而不用于更正放行。
function closureEvidence(session, school, offers, side) {
  const rows = offers.filter(row => row.session === session.session && row.by === school)
  const closed = rows.find(row => row.state === 'closed')
  if (closed) return { closed: true, source: 'offers', state: closed.state }
  if (side.room === 'closed') return { closed: true, source: 'rooms', state: 'closed' }
  if (side.calendar === 'cancelled') return { closed: false, windowRemoved: true, source: 'calendar', state: 'cancelled' }
  return { closed: false }
}

function interpreterIndex(records) {
  const interpreters = new Map()
  for (const row of records.roster) {
    let entry = interpreters.get(row.interpreter)
    if (!entry) {
      entry = { interpreter: row.interpreter, directions: new Set(), windows: [] }
      interpreters.set(row.interpreter, entry)
    }
    row.directions.forEach(direction => entry.directions.add(direction))
    entry.windows.push(row.available)
  }
  return interpreters
}

// 为某环节找候选人；已占用的时段会被剔除，返回的拒绝理由按原因分类。
function segmentCandidates(entry, segment, interpreters, occupied) {
  const span = entry.times[segment.key]
  const language = entry.languages[segment.key]
  const candidates = []
  const reasons = { language: [], availability: [], clash: [] }
  for (const person of interpreters.values()) {
    if (!person.directions.has(language)) {
      reasons.language.push(person.interpreter + ' 不接 ' + language)
      continue
    }
    if (!person.windows.some(window => covering(window, span))) {
      reasons.availability.push(person.interpreter + ' 可用时段未覆盖该环节')
      continue
    }
    const clash = occupied.find(item => item.interpreter === person.interpreter && overlaps(item.span, span))
    if (clash) {
      reasons.clash.push(person.interpreter + ' 已在 ' + clash.session + ' 的' + clash.label)
      continue
    }
    candidates.push(person.interpreter)
  }
  return { candidates, reasons }
}

function localClock(span, timeZone) {
  const format = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
  const parts = (minute) => {
    const value = {}
    for (const part of format.formatToParts(new Date(Date.UTC(2026, 10, 20) + minute * 60000))) {
      if (part.type !== 'literal') value[part.type] = part.value
    }
    return value
  }
  const start = parts(span.start)
  const end = parts(span.end)
  const pad = value => String(value).padStart(2, '0')
  const day = `${start.year}-${start.month}-${start.day}`
  return {
    start,
    end,
    day,
    startText: `${pad(start.hour)}:${pad(start.minute)}`,
    endText: `${pad(end.hour)}:${pad(end.minute)}`,
    endDay: `${end.year}-${end.month}-${end.day}`
  }
}

function sideEvidence(entry, school) {
  const rows = entry.roomEvidence?.[school] || []
  return {
    school,
    states: rows.map(row => row.state),
    open: rows.some(row => row.state === 'open'),
    held: rows.some(row => row.state === 'held'),
    live: rows.some(row => row.state === 'live'),
    closed: rows.some(row => row.state === 'closed'),
    receipt: rows.map(row => row.receipt).filter(Boolean),
    calendar: entry.sides.find(side => side.school === school)?.calendar || 'unknown'
  }
}

// options: { records, state, offers, timeZones, asOf }
export function buildPlan({ records, state, offers = [], timeZones, asOf }) {
  const signedRows = latestSignedRows(records.signed)
  const interpreters = interpreterIndex(records)
  const sessions = [...records.sessions].sort((a, b) =>
    a.lecture.start - b.lecture.start || a.session.localeCompare(b.session))
  const byId = new Map(sessions.map(session => [session.session, session]))

  // 已上完的课堂：只保留原资源，不参与择配。即使不在当前 sessions 流里，也按校历 UID
  // 找回所属学校与原始时段，保证永远能查到。
  // 校历同步时会把已上完课堂的原资源快照进 state.completed，因此即使后续全量响应
  // 范围缩小、sessions 流里不再出现该课堂，也仍能查到原资源。
  const completedRows = signedRows.filter(row => COMPLETED_SIGNED.has(row.state))
  const storedCompleted = state.completed || {}
  const completedIdsAll = new Set([...completedRows.map(row => row.session), ...Object.keys(storedCompleted)])
  const completed = []
  for (const sessionId of completedIdsAll) {
    const rows = signedRows.filter(row => row.session === sessionId && COMPLETED_SIGNED.has(row.state))
    const snapshot = storedCompleted[sessionId]
    const session = byId.get(sessionId)
    const schools = session?.schools || snapshot?.schools ||
      Object.keys(state.calendars || {}).filter(school => state.calendars[school]?.published?.[sessionId + '-' + school])
    const windows = {}
    for (const school of schools) {
      const entry = state.calendars?.[school]?.published?.[sessionId + '-' + school]
      if (entry) windows[school] = { start: entry.start, end: entry.end, localDay: entry.localDay }
      else if (snapshot?.windows?.[school]) windows[school] = snapshot.windows[school]
    }
    const originals = rows.length
      ? rows.map(row => ({ segment: row.segment, interpreter: row.interpreter, credential: row.credential, state: row.state }))
      : (snapshot?.originals || [])
    if (originals.length === 0) continue
    for (const original of originals) {
      completed.push({
        session: sessionId,
        schools,
        windows,
        original,
        note: '已上完的课堂保留原资源，不进入重新择配'
      })
    }
  }
  const completedOrder = [...new Map(completed.map(entry => [entry.session, entry])).values()]
    .map(entry => ({
      ...entry,
      originals: completed.filter(item => item.session === entry.session).map(item => item.original)
    }))
  const completedIds = new Set(completed.map(entry => entry.session))

  const results = []
  const commitments = []
  const occupied = []
  const releases = []

  // 第一轮：有有效通知的课程先定位并占用资源。
  for (const session of sessions) {
    if (completedIds.has(session.session)) continue
    const rows = signedRows.filter(row => row.session === session.session && ACTIVE_SIGNED.has(row.state))
    const stored = state.commitments?.[session.session]
    const notified = rows.length > 0
    if (!notified && !(stored && stored.notifiedAt)) continue

    const span = { start: session.lecture.start, end: session.questions.end }
    const sides = session.schools.map(school => ({ school, ...sideWindow(records, state, session, school, span) }))
    const closures = sides.map(side => ({ school: side.school, ...closureEvidence(session, side.school, offers, side) }))
    const closedSides = closures.filter(closure => closure.closed)
    const windowRemoved = closures.filter(closure => closure.windowRemoved)
    const windowOk = sides.every(side => side.ok)

    // 本地已释放的环节优先于上游旧通知：释放是工具对原承诺的撤回，
    // 上游 signed 流里残留的旧记录不能让它复活。
    const releasedBefore = new Set((stored?.releases || []).map(item => item.segment))
    const assignments = {}
    for (const segment of SEGMENTS) {
      const sourceRow = rows.find(row => row.segment === segment.key)
      const storedRow = stored?.segments?.[segment.key]
      if (releasedBefore.has(segment.key)) continue
      if (sourceRow) {
        assignments[segment.key] = {
          interpreter: sourceRow.interpreter,
          credential: sourceRow.credential,
          origin: 'signed',
          state: sourceRow.state
        }
      } else if (storedRow) {
        assignments[segment.key] = {
          interpreter: storedRow.interpreter,
          credential: storedRow.credential || null,
          origin: 'tool',
          state: storedRow.state || 'notified'
        }
      }
    }

    const sessionReleases = []
    if (closedSides.length) {
      for (const segment of SEGMENTS) {
        const chosen = assignments[segment.key]
        if (!chosen) continue
        const segmentSpan = session[segment.key]
        // 只有确实关闭之后、且环节尚未开始，才释放该口译段；已开始的环节不再释放，
        // 交给人处理（可能已在进行的口译不能被工具悄悄撤掉）。
        if (asOf < segmentSpan.start) {
          sessionReleases.push({
            session: session.session,
            segment: segment.key,
            label: segment.label,
            interpreter: chosen.interpreter,
            credential: chosen.credential,
            start: segmentSpan.start,
            releaseBy: segmentSpan.start,
            localStart: localClock(segmentSpan, timeZones[session.schools[0]]).startText,
            releasedAt: asOf,
            reason: closedSides.map(entry => entry.school + ' 方房间已关闭（' + entry.source + '）').join('；')
          })
          delete assignments[segment.key]
        }
      }
      releases.push(...sessionReleases)
    }

    // 校历取消只移除一校的可用时窗：等共同窗口，不据此直接改约；
    // 真正房间关闭（offers/rooms 实据）才要求联络员改约。
    const reschedule = closedSides.length > 0
    const blockedNow = sides.flatMap(side => side.blocked)
    const waitingWindow = !reschedule && (windowRemoved.length > 0 || blockedNow.length > 0)

    // 关闭实据出现后，要区分两件事：
    // 1) 哪个时刻必须释放未开始的环节 —— 释放发生在工具已知关闭的那一刻（asOf），
    //    最迟不得晚于该环节开始（releaseBy）。已开始的环节不释放。
    // 2) 哪些已通知家长的课堂必须由联络员改约 —— 已经发出确认（notifiedAt 或有效签署）
    //    的课堂才进入改约队列；尚未通知的只标记为房间不通，不能擅自改约。
    const releasedSegments = new Set(sessionReleases.map(item => item.segment))
    const started = SEGMENTS.filter(segment => {
      const held = assignments[segment.key] || sessionReleases.some(item => item.segment === segment.key)
      return held && asOf >= session[segment.key].start
    }).map(segment => segment.key)
    const closed = closedSides.length > 0
    const notifiedToParents = Boolean(rows.length > 0 || stored?.notifiedAt)
    const mustReschedule = closed && (notifiedToParents || started.length > 0) && !waitingWindow
    const rescheduleAt = closed ? Math.min(
      ...SEGMENTS.map(segment => session[segment.key].start)
    ) : null

    const entry = {
      session: session.session,
      schools: session.schools,
      times: { lecture: session.lecture, questions: session.questions },
      local: Object.fromEntries(session.schools.map(school => [school, {
        lecture: localClock(session.lecture, timeZones[school]),
        questions: localClock(session.questions, timeZones[school])
      }])),
      slots: session.slotsBySchool,
      languages: session.languages,
      sides,
      closures,
      closed,
      windowRemoved: windowRemoved.map(item => item.school),
      assignments,
      committed: true,
      notifiedAt: stored?.notifiedAt || null,
      needsReschedule: mustReschedule,
      startedSegments: started,
      releasedSegments: [...releasedSegments],
      rescheduleAt,
      atRisk: !windowOk && !closed,
      waitingWindow,
      releases: sessionReleases,
      completeRelay: SEGMENTS.every(segment => assignments[segment.key]),
      missingSegments: SEGMENTS.filter(segment => !assignments[segment.key]).map(segment => segment.key),
      status: mustReschedule ? 'reschedule' : closed ? 'room-closed' : windowOk ? 'notified' : 'commitment-at-risk'
    }
    entry.issues = [...new Set(sides.flatMap(side => side.reasons))]
    entry.heldByCommitment = [...new Set(Object.values(assignments).map(chosen => chosen.interpreter))]
    for (const segment of SEGMENTS) {
      const chosen = assignments[segment.key]
      if (chosen) {
        occupied.push({
          interpreter: chosen.interpreter,
          span: session[segment.key],
          session: session.session,
          label: segment.label,
          segment: segment.key
        })
      }
    }

    commitments.push(entry)
    results.push(entry)
  }

  // 第二轮：没有有效通知的课程参与择配。
  const pending = []
  for (const session of sessions) {
    if (completedIds.has(session.session)) continue
    if (commitments.some(entry => entry.session === session.session)) continue
    const span = { start: session.lecture.start, end: session.questions.end }
    const sides = session.schools.map(school => ({ school, ...sideWindow(records, state, session, school, span) }))
    const closures = sides.map(side => ({ school: side.school, ...closureEvidence(session, side.school, offers, side) }))
    const entry = {
      session: session.session,
      schools: session.schools,
      times: { lecture: session.lecture, questions: session.questions },
      local: Object.fromEntries(session.schools.map(school => [school, {
        lecture: localClock(session.lecture, timeZones[school]),
        questions: localClock(session.questions, timeZones[school])
      }])),
      slots: session.slotsBySchool,
      languages: session.languages,
      sides,
      closures,
      closed: closures.some(closure => closure.closed),
      windowRemoved: closures.filter(closure => closure.windowRemoved).map(closure => closure.school),
      assignments: {},
      committed: false,
      notifiedAt: null,
      needsReschedule: false,
      atRisk: false,
      waitingWindow: closures.some(closure => closure.windowRemoved) ||
        sides.some(side => side.blocked.length > 0),
      releases: [],
      completeRelay: false,
      missingSegments: SEGMENTS.map(segment => segment.key),
      issues: []
    }
    pending.push(entry)
    results.push(entry)
  }

  const schedulable = pending.filter(entry =>
    entry.sides.every(side => side.ok) && entry.closures.every(closure => !closure.closed))
  const blocked = []
  for (const entry of pending) {
    if (!schedulable.includes(entry)) {
      // 没有关闭实据、只是窗口不足的叫 blocked；有房间关闭实据但尚未通知的叫 room-closed，
      // 后者不进入改约队列，只提示联络员这间房现在不通。
      entry.status = entry.closed ? 'room-closed' : 'blocked'
      entry.completeRelay = false
      entry.issues = [...new Set([...entry.sides.flatMap(side => side.reasons),
        ...entry.closures.filter(closure => closure.closed).map(closure => '房间：' + closure.school + ' 方已关闭')])]
      entry.missingSegments = SEGMENTS.map(segment => segment.key)
      blocked.push(entry)
    }
  }

  // 回溯指派：两个环节可落在不同人身上，优先让尽可能多的课堂完整接力。
  const slots = []
  for (const entry of schedulable) {
    entry.segmentCandidates = {}
    entry.segmentReasons = {}
    for (const segment of SEGMENTS) {
      const { candidates, reasons } = segmentCandidates(entry, segment, interpreters, occupied)
      entry.segmentCandidates[segment.key] = candidates
      entry.segmentReasons[segment.key] = reasons
      slots.push({ entry, segment, candidates })
    }
  }
  slots.sort((a, b) => a.candidates.length - b.candidates.length ||
    a.entry.times[a.segment.key].start - b.entry.times[b.segment.key].start ||
    a.entry.session.localeCompare(b.entry.session))

  const assigned = new Map()
  const best = { complete: -1, filled: -1 }
  let bestAssignment = null
  const evaluate = () => {
    let complete = 0
    let filled = 0
    for (const entry of schedulable) {
      const count = SEGMENTS.filter(segment => assigned.has(entry.session + '\u0000' + segment.key)).length
      filled += count
      if (count === SEGMENTS.length) complete += 1
    }
    if (complete > best.complete || (complete === best.complete && filled > best.filled)) {
      best.complete = complete
      best.filled = filled
      bestAssignment = new Map(assigned)
    }
  }
  const search = (index) => {
    if (index === slots.length) {
      evaluate()
      return
    }
    const slot = slots[index]
    const span = slot.entry.times[slot.segment.key]
    for (const interpreter of slot.candidates) {
      const clash = [...assigned.values()].some(item => item.interpreter === interpreter && overlaps(item.span, span))
      if (clash) continue
      assigned.set(slot.entry.session + '\u0000' + slot.segment.key, {
        interpreter,
        span,
        session: slot.entry.session,
        label: slot.segment.label,
        segment: slot.segment.key
      })
      search(index + 1)
      assigned.delete(slot.entry.session + '\u0000' + slot.segment.key)
    }
    search(index + 1)
  }
  search(0)
  if (bestAssignment) {
    for (const [key, value] of bestAssignment) {
      const [sessionId, segment] = key.split('\u0000')
      const entry = schedulable.find(item => item.session === sessionId)
      entry.assignments[segment] = {
        interpreter: value.interpreter,
        credential: null,
        origin: 'planned',
        state: 'planned'
      }
    }
  }

  const ready = []
  for (const entry of schedulable) {
    const missing = SEGMENTS.filter(segment => !entry.assignments[segment.key])
    entry.missingSegments = missing.map(segment => segment.key)
    if (missing.length === 0) {
      entry.status = 'ready'
      entry.completeRelay = true
      entry.issues = []
      ready.push(entry)
      for (const segment of SEGMENTS) {
        const chosen = entry.assignments[segment.key]
        occupied.push({
          interpreter: chosen.interpreter,
          span: entry.times[segment.key],
          session: entry.session,
          label: segment.label,
          segment: segment.key
        })
      }
    } else {
      entry.status = 'blocked'
      entry.completeRelay = false
      // 未完整接力的课堂只保留「建议」，不占住人员；这样别的课堂仍可用这些时段。
      entry.proposed = { ...entry.assignments }
      entry.assignments = {}
      const reasons = []
      for (const segment of missing) {
        const detail = entry.segmentReasons?.[segment.key] || {}
        for (const group of ['language', 'availability', 'clash']) {
          for (const reason of detail[group] || []) reasons.push(segment.label + '：' + reason)
        }
      }
      entry.issues = [...new Set(reasons)]
      if (entry.issues.length === 0) entry.issues.push('窗口：没有同时满足两个环节的可用人员')
      blocked.push(entry)
    }
  }

  // 房间开通实据与教师视图需要的解释，统一挂回每个课程。
  for (const entry of results) {
    entry.roomEvidence = Object.fromEntries(entry.schools.map(school => {
      const rows = offers.filter(row => row.session === entry.session && row.by === school)
      return [school, rows.map(row => ({ state: row.state, receipt: row.receipt }))]
    }))
    entry.evidence = Object.fromEntries(entry.schools.map(school => [school, sideEvidence(entry, school)]))
    entry.opening = {
      held: entry.schools.filter(school => entry.evidence[school].held),
      open: entry.schools.filter(school => entry.evidence[school].open),
      live: entry.schools.filter(school => entry.evidence[school].live),
      closed: entry.schools.filter(school => entry.evidence[school].closed),
      any: Object.values(entry.roomEvidence).some(rows => rows.length > 0)
    }
    entry.confirmedSides = {
      open: entry.opening.open,
      live: entry.opening.live,
      held: entry.opening.held
    }
    const roomReady = entry.schools.every(school => {
      const rows = entry.roomEvidence[school] || []
      const hold = state.holds?.[entry.session]?.[school]
      return rows.length > 0 || Boolean(hold)
    })
    entry.roomReady = roomReady
    entry.eligibleToConfirm = entry.completeRelay === true &&
      entry.needsReschedule === false &&
      entry.sides.every(side => side.ok) &&
      entry.opening.closed.length === 0 &&
      roomReady
    entry.notifications = (state.notifications || []).filter(note => note.session === entry.session)
  }

  return {
    asOf,
    asOfText: new Date(Date.UTC(2026, 10, 20) + asOf * 60000).toISOString(),
    generatedAt: new Date().toISOString(),
    sessions: results,
    commitments,
    ready,
    blocked,
    pending,
    completed: completedOrder,
    releases,
    reschedules: commitments.filter(entry => entry.needsReschedule),
    occupied
  }
}

