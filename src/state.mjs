// 持久状态：校历发布视图、会议室暂留、已发通知的承诺与通知日志。
// 状态写入采用临时文件 + rename，避免半截 JSON。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export const STATE_VERSION = 1

export function emptyState() {
  return {
    version: STATE_VERSION,
    calendars: {},
    holds: {},
    openRequests: {},
    commitments: {},
    completed: {},
    notifications: [],
    updatedAt: null
  }
}

export class StateStore {
  constructor(path) {
    this.path = path
  }

  async load() {
    try {
      const raw = await readFile(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed.version !== STATE_VERSION) {
        throw new Error('状态版本不兼容: ' + parsed.version + '（当前 ' + STATE_VERSION + '）')
      }
      return { ...emptyState(), ...parsed }
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState()
      throw error
    }
  }

  async save(state) {
    state.updatedAt = new Date().toISOString()
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = this.path + '.tmp-' + process.pid
    await writeFile(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8')
    await rename(temporary, this.path)
    return state
  }
}

export function ensureCalendar(state, school) {
  if (!state.calendars[school]) {
    state.calendars[school] = {
      school,
      syncKey: null,
      scope: null,
      etag: null,
      published: {},
      lastSyncAt: null,
      lastFullAt: null,
      lastDeltaAt: null,
      syncHistory: []
    }
  }
  return state.calendars[school]
}

export function ensureCommitment(state, session) {
  if (!state.commitments[session]) {
    state.commitments[session] = {
      session,
      state: 'draft',
      notifiedAt: null,
      source: null,
      segments: {},
      evidence: {},
      amendment: null,
      release: null,
      rescheduleNeeded: false,
      history: []
    }
  }
  return state.commitments[session]
}

export function logNotification(state, entry) {
  state.notifications.push(entry)
  return entry
}
