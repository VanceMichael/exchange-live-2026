// 业务资料来源客户端：处理分页、资料版固定、ETag 与筛选条件。
// 继续标记只对同一资料版与筛选条件有效，因此所有后续页都原样跟随 Link。

import { getJson, getText, HttpError } from './http.mjs'

const STREAMS = ['calendar', 'tz', 'rooms', 'sessions', 'roster', 'signed']

export class RecordSource {
  constructor(base, options = {}) {
    this.base = String(base).replace(/\/+$/, '')
    this.timeout = options.timeout
  }

  url(path, params = {}) {
    const target = new URL(this.base + path)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== '') target.searchParams.set(key, String(value))
    }
    return target.toString()
  }

  async catalog() {
    const { data } = await getJson(this.url('/catalog'), { timeout: this.timeout })
    return data
  }

  // 领取一个数据流的所有页。edition 为空时使用来源当前资料版，但把响应头里的
  // 实际资料版带回，调用方可据此固定后续读取。
  async stream(name, options = {}) {
    if (!STREAMS.includes(name)) throw new Error('未知数据流: ' + name)
    const params = {
      edition: options.edition,
      key: options.key,
      from: options.from,
      until: options.until
    }
    let target = this.url('/records/' + name, params)
    const rows = []
    let etag = options.etag
    let edition = options.edition
    let notModified = false
    let pages = 0

    for (let page = 0; target; page += 1) {
      if (page > 1000) throw new HttpError('分页数量异常: ' + name, { url: target })
      const response = await getText(target, {
        timeout: this.timeout,
        headers: etag && page === 0 ? { 'If-None-Match': etag } : undefined
      })
      edition = response.headers.get('x-edition') || edition
      etag = response.headers.get('etag') || etag
      if (response.status === 304) {
        notModified = true
        break
      }
      pages += 1
      for (const line of response.body.split('\n')) {
        if (line.trim() !== '') rows.push(line.split('\t'))
      }
      const link = response.headers.get('link')
      target = link ? new URL(/^<([^>]+)>/.exec(link)[1], this.base).toString() : null
    }

    return { name, edition, etag, rows, notModified, pages }
  }
}
