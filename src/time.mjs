// 时间与本地日历的基础换算。所有内部时刻统一为「自 2026-11-20T00:00Z 起的 UTC 分钟」，
// 与来源资料的时间列一致；本地日只用于解释校历覆盖范围和给联络员看的视图。

export const BASE_MS = Date.UTC(2026, 10, 20, 0, 0, 0, 0)

const formatters = new Map()

function formatter(timeZone) {
  let found = formatters.get(timeZone)
  if (!found) {
    found = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    formatters.set(timeZone, found)
  }
  return found
}

export function assertTimeZone(timeZone) {
  try {
    formatter(timeZone)
  } catch {
    throw new Error('无法识别的时区: ' + String(timeZone))
  }
  return timeZone
}

// 拆出某个 UTC 毫秒在给定时区里的墙上时间。
export function wallClock(ms, timeZone) {
  const parts = formatter(timeZone).formatToParts(new Date(ms))
  const value = {}
  for (const part of parts) {
    if (part.type !== 'literal') value[part.type] = part.value
  }
  return {
    year: Number(value.year),
    month: Number(value.month),
    day: Number(value.day),
    hour: Number(value.hour),
    minute: Number(value.minute),
    second: Number(value.second)
  }
}

function wallString(wall) {
  const pad = (n, width = 2) => String(n).padStart(width, '0')
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T` +
    `${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`
}

// 墙上时间 -> UTC 毫秒。取跳变前后两个候选偏移分别回算：
// - 恰好一个候选回算出目标墙上时间：就是它（覆盖正常日与夏令时回拨的重复时刻，取较早一次）；
// - 两个都不匹配：目标落在夏令时「跳变空档」，取较晚的候选（即跳变后的第一个有效时刻）。
export function fromWallClock(local, timeZone) {
  assertTimeZone(timeZone)
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(local)
  if (!match) throw new Error('无法识别的本地时刻: ' + String(local))
  const [, year, month, day, hour = '00', minute = '00', second = '00'] = match
  const desired = Date.UTC(Number(year), Number(month) - 1, Number(day),
    Number(hour), Number(minute), Number(second))

  const offsetAt = ms => {
    const seen = wallClock(ms, timeZone)
    const actual = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second)
    return actual - ms
  }

  const dayStart = Date.UTC(Number(year), Number(month) - 1, Number(day))
  const before = offsetAt(dayStart - 36 * 3600000)
  const after = offsetAt(dayStart + 36 * 3600000)
  const candidates = [...new Set([desired - before, desired - after])].sort((a, b) => a - b)
  for (const candidate of candidates) {
    const seen = wallClock(candidate, timeZone)
    const actual = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second)
    if (actual === desired) return candidate
  }
  return candidates[candidates.length - 1]
}

// iCalendar 的 DTSTART/DTEND 形式：20261120T190000（可选 Z 结尾）。
export function parseIcsDateTime(value, fallbackZone) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(String(value).trim())
  if (!match) throw new Error('无法识别的日历时刻: ' + String(value))
  const [, y, mo, d, h, mi, s, zulu] = match
  const local = `${y}-${mo}-${d}T${h}:${mi}:${s}`
  if (zulu) {
    return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  }
  if (!fallbackZone) throw new Error('日历时刻缺少时区: ' + String(value))
  return fromWallClock(local, fallbackZone)
}

export function toMinute(ms) {
  return Math.round((ms - BASE_MS) / 60000)
}

export function fromMinute(minute) {
  return BASE_MS + Number(minute) * 60000
}

// 内部分钟 -> 某地本地日（YYYY-MM-DD）与当天零点对应的内部分钟。
export function localDay(minute, timeZone) {
  const wall = wallClock(fromMinute(minute), timeZone)
  const pad = n => String(n).padStart(2, '0')
  const day = `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`
  return { day, start: toMinute(fromWallClock(day + 'T00:00:00', timeZone)) }
}

// 两个本地日之间（含两端）的日期列表，按日历推进而不是按 24 小时。
export function eachDay(from, until) {
  const days = []
  const start = new Date(from + 'T00:00:00Z')
  const end = new Date(until + 'T00:00:00Z')
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('无法识别的日期范围: ' + from + '/' + until)
  }
  for (let at = start.getTime(); at <= end.getTime(); at += 86400000) {
    days.push(new Date(at).toISOString().slice(0, 10))
  }
  return days
}

export function parseDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error('无法识别的日期: ' + String(day))
  return day
}

export function shiftDay(day, amount) {
  const at = new Date(day + 'T00:00:00Z')
  at.setUTCDate(at.getUTCDate() + amount)
  return at.toISOString().slice(0, 10)
}

export function displayMinute(minute, timeZone) {
  const wall = wallClock(fromMinute(minute), timeZone)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(wall.hour)}:${pad(wall.minute)}`
}

export function displayDayDay(minute, timeZone) {
  return localDay(minute, timeZone).day
}

// 区间集合工具；区间左闭右开。
export function intersect(a, b) {
  const first = Math.max(a.start, b.start)
  const last = Math.min(a.end, b.end)
  return last > first ? { start: first, end: last } : null
}

export function overlaps(a, b) {
  return Math.min(a.end, b.end) > Math.max(a.start, b.start)
}

export function subtract(interval, cuts) {
  let pieces = [interval]
  for (const cut of cuts) {
    const next = []
    for (const piece of pieces) {
      const hit = intersect(piece, cut)
      if (!hit) {
        next.push(piece)
        continue
      }
      if (hit.start > piece.start) next.push({ start: piece.start, end: hit.start })
      if (hit.end < piece.end) next.push({ start: hit.end, end: piece.end })
    }
    pieces = next
  }
  return pieces.filter(piece => piece.end > piece.start)
}

export function merge(intervals) {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)
  const output = []
  for (const interval of sorted) {
    const last = output[output.length - 1]
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end)
    else output.push({ ...interval })
  }
  return output
}
