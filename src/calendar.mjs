// 校历解释：把 ICS 事件变成内部分钟区间，并按「当地起始日」判断落在哪个公布范围。
//
// 关键语义（来自 provider.md）：
// - 完整响应的 X-Scope 只声明该站「当地半开日期」内的可用时窗。范围外此前的记录
//   不能被全量响应悄悄删掉，也不能被另一天的全量响应删除。
// - 增量里的 STATUS:CANCELLED 只移除相应 UID 的已公布时窗，不能把取消件继续当作开放。
// - 覆盖范围按记录的「当地起始日」解释；跨午夜的实际占用延续到真实结束时刻，
//   blocked-W 的禁止时窗同样会压到另一地的可用窗口上。

import { toMinute } from './time.mjs'

export function eventInterval(event) {
  return {
    uid: event.uid,
    start: toMinute(event.startMs),
    end: toMinute(event.endMs),
    status: event.status,
    blocked: event.blocked,
    timeZone: event.timeZone,
    localDay: event.startDay || null
  }
}

export function eventStartDay(event, fallbackZone) {
  const zone = event.timeZone && event.timeZone !== 'UTC' ? event.timeZone : fallbackZone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date(event.startMs))
  const value = {}
  for (const part of parts) if (part.type !== 'literal') value[part.type] = part.value
  return `${value.year}-${value.month}-${value.day}`
}

export function inScope(day, scope) {
  return Boolean(scope) && day >= scope.from && day < scope.until
}
