// iCalendar 子集解析：只取本工具需要的 VEVENT、UID、起止、状态与 TZID。
// 行展开（折行）与参数解析按 RFC 5545 的常见形式处理。

import { parseIcsDateTime } from './time.mjs'

export function unfold(text) {
  const raw = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  const lines = []
  for (const line of raw) {
    if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1)
    else lines.push(line)
  }
  return lines
}

function splitProperty(line) {
  let inQuotes = false
  let colon = -1
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') inQuotes = !inQuotes
    else if (char === ':' && !inQuotes) {
      colon = index
      break
    }
  }
  if (colon < 0) return null
  const head = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const [name, ...parameterParts] = head.split(';')
  const parameters = {}
  for (const part of parameterParts) {
    const equals = part.indexOf('=')
    if (equals > 0) parameters[part.slice(0, equals).toUpperCase()] = part.slice(equals + 1).replace(/^"|"$/g, '')
  }
  return { name: name.toUpperCase(), parameters, value }
}

export function parseIcs(text) {
  const events = []
  const stack = []
  let current = null
  for (const line of unfold(text)) {
    if (line === '') continue
    const property = splitProperty(line)
    if (!property) continue
    if (property.name === 'BEGIN') {
      stack.push(property.value.toUpperCase())
      if (property.value.toUpperCase() === 'VEVENT') current = { properties: {} }
      continue
    }
    if (property.name === 'END') {
      const closing = property.value.toUpperCase()
      stack.pop()
      if (closing === 'VEVENT') {
        if (current) events.push(finishEvent(current))
        current = null
      }
      continue
    }
    if (current && stack[stack.length - 1] === 'VEVENT') {
      const list = current.properties[property.name] || (current.properties[property.name] = [])
      list.push(property)
    }
  }
  return events
}

function first(properties, name) {
  return properties[name]?.[0]
}

function finishEvent(record) {
  const properties = record.properties
  const uid = first(properties, 'UID')?.value?.trim()
  if (!uid) throw new Error('日历事件缺少 UID')
  const startProperty = first(properties, 'DTSTART')
  const endProperty = first(properties, 'DTEND')
  if (!startProperty) throw new Error('日历事件缺少 DTSTART: ' + uid)
  const timeZone = startProperty.parameters.TZID || endProperty?.parameters.TZID
  const start = parseIcsDateTime(startProperty.value, timeZone)
  const end = endProperty ? parseIcsDateTime(endProperty.value, endProperty.parameters.TZID || timeZone) : start
  if (!(end > start)) throw new Error('日历事件起止无效: ' + uid)
  const status = (first(properties, 'STATUS')?.value || 'CONFIRMED').trim().toUpperCase()
  return {
    uid,
    startMs: start,
    endMs: end,
    timeZone: timeZone || 'UTC',
    status,
    summary: first(properties, 'SUMMARY')?.value || '',
    blocked: /^blocked(?:-|$)/i.test(uid)
  }
}
// 来源的 X-Scope 是「当地半开日期」：2026-11-20/2026-11-21 只覆盖 11-20。
export function parseScope(value) {
  const match = /^(\d{4}-\d{2}-\d{2})\/(\d{4}-\d{2}-\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  if (match[1] >= match[2]) throw new Error('日历有效范围为空: ' + value)
  return { from: match[1], until: match[2] }
}
