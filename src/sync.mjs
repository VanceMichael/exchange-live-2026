// 一次性同步：固定资料版领取全部业务流，合并两校校历，回读房间开通实据，然后落盘。
// 资料版在同步开始时固定，避免取到一半被 /control 切版导致两校资料错配。

import { RecordSource } from './recordSource.mjs'
import { ProviderClient, SyncExpired } from './provider.mjs'
import { PARSERS } from './records.mjs'
import { eventStartDay, eventInterval, inScope } from './calendar.mjs'
import { ensureCalendar, ensureCommitment } from './state.mjs'

export class SyncError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'SyncError'
    this.detail = detail
  }
}

const STREAMS = ['calendar', 'tz', 'rooms', 'sessions', 'roster', 'signed']

export async function syncRecords({ config, state, edition }) {
  const source = new RecordSource(config.sourceBase, { timeout: config.timeout })
  const catalog = await source.catalog()
  if (!catalog || !Array.isArray(catalog.streams)) throw new SyncError('来源目录不可用')
  const pinned = edition || catalog.edition
  if (!catalog.streams.includes('sessions')) throw new SyncError('来源缺少 sessions 流')
  const previous = state.records || {}
  const records = {}
  const updates = []
  for (const name of STREAMS) {
    if (!catalog.streams.includes(name)) {
      records[name] = previous[name] || { edition: pinned, etag: null, rows: [], pages: 0, fetchedAt: null }
      continue
    }
    const prior = previous[name]
    const reuseEtag = prior && prior.edition === pinned && prior.pages === 1 ? prior.etag : undefined
    const result = await source.stream(name, { edition: pinned, etag: reuseEtag })
    if (result.notModified && prior) {
      records[name] = { ...prior, fetchedAt: new Date().toISOString(), notModified: true }
      updates.push({ stream: name, notModified: true, rows: prior.rows.length })
      continue
    }
    if (result.edition && result.edition !== pinned) {
      throw new SyncError('资料版在同步过程中发生变化：' + pinned + ' -> ' + result.edition + '（' + name + '）')
    }
    records[name] = {
      edition: result.edition || pinned,
      etag: result.etag || null,
      rows: result.rows,
      pages: result.pages,
      fetchedAt: new Date().toISOString()
    }
    updates.push({ stream: name, rows: result.rows.length, edition: result.edition, pages: result.pages })
  }
  state.edition = pinned
  state.records = records
  return { edition: pinned, updates }
}

// 完整响应：X-Scope 声明的当地半开日期内，响应即权威；范围外的旧发布记录原样保留。
// 取消件只影响对应 UID，保留为 CANCELLED 墓碑，供视图明确区分「已取消」与「从未公布」，
// 但任何择配都不会把它当作开放。
function mergeFull(calendar, fetched, timeZone) {
  const scope = fetched.scope
  if (!scope) throw new SyncError('完整校历缺少 X-Scope: ' + fetched.school)
  const incoming = new Map()
  for (const event of fetched.events) {
    const interval = eventInterval(event)
    interval.localDay = eventStartDay(event, timeZone)
    if (!inScope(interval.localDay, scope)) continue
    incoming.set(event.uid, interval)
  }
  for (const [uid, interval] of incoming) {
    if (interval.status === 'CANCELLED') {
      calendar.published[uid] = publicEntry(interval, scope)
      calendar.published[uid].status = 'CANCELLED'
    } else {
      calendar.published[uid] = publicEntry(interval, scope)
    }
  }
  // 声明范围内缺席的记录才表示该校撤回了公布；范围外的一律保留。
  // 墓碑在同一范围内仍缺席时也清掉，避免无限累积。
  for (const uid of Object.keys(calendar.published)) {
    const entry = calendar.published[uid]
    if (!inScope(entry.localDay, scope)) continue
    if (incoming.has(uid)) continue
    delete calendar.published[uid]
  }
  calendar.scope = { ...scope }
  calendar.syncKey = fetched.syncKey || calendar.syncKey
  calendar.etag = fetched.etag || null
}

// 增量响应：只应用出现的事件。取消只移除该 UID 的可用时窗，并留下 CANCELLED 墓碑；
// 其余记录（含另一天的全量历史占用、C0 已完成课堂）保持不动。
function mergeDelta(calendar, fetched, timeZone) {
  for (const event of fetched.events) {
    const interval = eventInterval(event)
    interval.localDay = eventStartDay(event, timeZone)
    if (interval.status === 'CANCELLED') {
      // 禁止时段不因课堂取消逻辑误删；只有该校发布了对该 UID 的取消才生效。
      calendar.published[event.uid] = publicEntry(interval, null)
      calendar.published[event.uid].status = 'CANCELLED'
    } else {
      calendar.published[event.uid] = publicEntry(interval, null)
    }
  }
  calendar.syncKey = fetched.syncKey || calendar.syncKey
  calendar.etag = fetched.etag || calendar.etag
}

function publicEntry(interval, scope) {
  return {
    uid: interval.uid,
    start: interval.start,
    end: interval.end,
    status: interval.status,
    blocked: interval.blocked,
    timeZone: interval.timeZone,
    localDay: interval.localDay,
    scope: scope ? { from: scope.from, until: scope.until } : null
  }
}

// 校历同步：有增量凭据时走增量；410（以及演练档里没有该增量路由的 404）时重取完整新范围。
// 合并规则保证范围外的旧记录不被悄悄删除。
export async function syncCalendars({ config, state, schools, full = false }) {
  const client = new ProviderClient(config.providerBase, { timeout: config.timeout })
  const results = []
  for (const school of schools) {
    const calendar = ensureCalendar(state, school)
    const timeZone = config.schools[school].timeZone
    let mode = full || !calendar.syncKey || !calendar.lastSyncAt ? 'full' : 'delta'
    let fetched
    let recovered = false
    try {
      fetched = await client.calendars(school, mode === 'delta' ? { since: calendar.syncKey } : {})
    } catch (error) {
      const expired = error instanceof SyncExpired || (error.status === 404 && mode === 'delta')
      if (!expired) {
        if (error.status === 404) {
          // 该站本轮没有提供校历路由：保留既有发布，不臆断成删除。
          results.push({ school, mode, unavailable: true, syncKey: calendar.syncKey, scope: calendar.scope })
          continue
        }
        throw error
      }
      mode = 'full'
      recovered = true
      try {
        fetched = await client.calendars(school, {})
      } catch (fullError) {
        if (fullError.status !== 404) throw fullError
        results.push({ school, mode: 'full', unavailable: true, syncKey: calendar.syncKey, scope: calendar.scope })
        continue
      }
    }
    if (fetched.status === 304) {
      results.push({ school, mode, notModified: true, syncKey: calendar.syncKey, scope: calendar.scope })
      continue
    }
    if (mode === 'full') mergeFull(calendar, fetched, timeZone)
    else mergeDelta(calendar, fetched, timeZone)
    calendar.lastSyncAt = new Date().toISOString()
    if (mode === 'full') calendar.lastFullAt = calendar.lastSyncAt
    else calendar.lastDeltaAt = calendar.lastSyncAt
    calendar.syncHistory = [...(calendar.syncHistory || []), {
      at: calendar.lastSyncAt,
      mode,
      recovered,
      syncKey: calendar.syncKey,
      scope: calendar.scope,
      events: fetched.events.length,
      published: Object.keys(calendar.published).length
    }].slice(-20)
    results.push({
      school,
      mode,
      recovered,
      syncKey: calendar.syncKey,
      scope: fetched.scope,
      events: fetched.events.length,
      published: Object.keys(calendar.published).length
    })
  }
  return results
}

export async function refreshOffers({ config, state }) {
  const client = new ProviderClient(config.providerBase, { timeout: config.timeout })
  const offers = await client.offers()
  state.offers = offers
  state.offersFetchedAt = new Date().toISOString()
  return offers
}

export function loadRecords(state) {
  const stored = state.records || {}
  const records = {}
  for (const [name, parser] of Object.entries(PARSERS)) {
    const entry = stored[name]
    records[name] = entry ? parser(entry.rows) : []
  }
  return records
}

export function initCommitment(state, session, source) {
  const commitment = ensureCommitment(state, session)
  if (!commitment.source) commitment.source = source
  return commitment
}
