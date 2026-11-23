// 外部演练接口客户端：校历（含 410 过期）、房间开通状态、暂留/开通/更正。
// 任何写操作都只把「收到」当作已送达，实际状态以 offers 回读为准。

import { getJson, getText, postJson } from './http.mjs'
import { parseIcs, parseScope } from './ical.mjs'

export class SyncExpired extends Error {
  constructor(school) {
    super('校历增量凭据已过期: ' + school)
    this.name = 'SyncExpired'
    this.school = school
  }
}

export class ProviderClient {
  constructor(base, options = {}) {
    this.base = String(base).replace(/\/+$/, '')
    this.timeout = options.timeout
  }

  async calendars(school, { since, etag } = {}) {
    const target = new URL(this.base + '/school/calendars')
    target.searchParams.set('school', school)
    if (since) target.searchParams.set('since', since)
    const headers = {}
    if (etag && !since) headers['If-None-Match'] = etag
    let response
    try {
      response = await getText(target.toString(), { timeout: this.timeout, headers })
    } catch (error) {
      if (error.status === 410) throw new SyncExpired(school)
      throw error
    }
    return {
      school,
      status: response.status,
      body: response.body,
      notModified: response.status === 304,
      syncKey: response.headers.get('x-sync-key') || since || null,
      scope: parseScope(response.headers.get('x-scope')),
      etag: response.headers.get('etag') || etag || null,
      events: response.status === 304 ? [] : parseIcs(response.body)
    }
  }

  async offers() {
    const { data } = await getJson(this.base + '/calling/offers', { timeout: this.timeout })
    if (!Array.isArray(data)) throw new Error('房间状态响应不是数组')
    return data.map(row => ({
      session: String(row.session),
      by: String(row.by),
      state: String(row.state),
      receipt: row.receipt ? String(row.receipt) : null
    }))
  }

  async hold(session, by) {
    const { status, data } = await postJson(this.base + '/calling/hold', { session, by }, { timeout: this.timeout })
    return { status, ...data }
  }

  async open(session, holds, by) {
    const payload = by === undefined ? { session, holds } : { session, holds, by }
    const { status, data } = await postJson(this.base + '/calling/open', payload, { timeout: this.timeout })
    return { status, ...data }
  }

  async amend(session, by, receipt) {
    const { status, data } = await postJson(this.base + '/calling/amend', { session, by, receipt }, { timeout: this.timeout })
    return { status, ...data }
  }
}
