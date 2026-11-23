import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BASE_MS, eachDay, fromWallClock, localDay, parseIcsDateTime, shiftDay, toMinute, wallClock
} from '../src/time.mjs'
import { parseIcs, parseScope } from '../src/ical.mjs'
import { parseRoster, parseSessions } from '../src/records.mjs'

test('本地墙上时间换算跨时区与时区跳变', () => {
  const shanghai = fromWallClock('2026-11-20T19:00:00', 'Asia/Shanghai')
  const melbourne = fromWallClock('2026-11-20T22:00:00', 'Australia/Melbourne')
  assert.equal(shanghai, BASE_MS + 660 * 60000)
  assert.equal(melbourne, BASE_MS + 660 * 60000)
  assert.equal(toMinute(parseIcsDateTime('20261120T190000', 'Asia/Shanghai')), 660)
  assert.equal(toMinute(parseIcsDateTime('20261120T220000', 'Australia/Melbourne')), 660)

  // 墨尔本 11 月已进入夏令时（UTC+11），跨零点要保持真实时刻。
  const late = fromWallClock('2026-11-21T00:30:00', 'Australia/Melbourne')
  assert.equal(toMinute(late), 810)
  assert.equal(wallClock(late, 'Australia/Melbourne').hour, 0)

  // 纽约 2026-03-08 02:30 是不存在的墙上时刻；换算必须落在跳变后的有效时刻而不是 NaN。
  const gap = fromWallClock('2026-03-08T02:30:00', 'America/New_York')
  assert.ok(Number.isFinite(gap))
  assert.equal(wallClock(gap, 'America/New_York').hour, 3)
})

test('本地日与跨月日期推进', () => {
  assert.deepEqual(localDay(810, 'Australia/Melbourne').day, '2026-11-21')
  assert.deepEqual(localDay(660, 'Asia/Shanghai').day, '2026-11-20')
  assert.deepEqual(eachDay('2026-11-30', '2026-12-02'), ['2026-11-30', '2026-12-01', '2026-12-02'])
  assert.equal(shiftDay('2026-11-30', 1), '2026-12-01')
})

test('iCalendar 解析展开折行并保留 TZID 与状态', () => {
  const text = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:C9-E',
    'DTSTART;TZID=Asia/Shanghai:20261120T190000',
    'DTEND;TZID=Asia/Shanghai:20261120T200000',
    'STATUS:CANCELLED',
    'SUMMARY:跨零点',
    ' 测试',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n')
  const [event] = parseIcs(text)
  assert.equal(event.uid, 'C9-E')
  assert.equal(event.status, 'CANCELLED')
  assert.equal(event.summary, '跨零点测试')
  assert.equal(toMinute(event.startMs), 660)
  assert.equal(toMinute(event.endMs), 720)
})

test('日历有效范围是当地半开日期', () => {
  assert.deepEqual(parseScope('2026-11-20/2026-11-22'), { from: '2026-11-20', until: '2026-11-22' })
  assert.equal(parseScope('2026-11-20'), null)
  assert.throws(() => parseScope('2026-11-22/2026-11-20'))
})

test('口译员方向集合与课堂双环节解析', () => {
  const [session] = parseSessions([['C1', 'E,W', 'X,Y', '670', '690', '690', '700', 'zh-en', 'en-zh']])
  assert.deepEqual(session.schools, ['E', 'W'])
  assert.deepEqual(session.slotsBySchool, { E: 'X', W: 'Y' })
  assert.deepEqual(session.languages, { lecture: 'zh-en', questions: 'en-zh' })
  const roster = parseRoster([
    ['I', '660', '705', 'zh-en'],
    ['J', '685', '735', 'en-zh,zh-en']
  ])
  assert.deepEqual(roster[1].directions, ['en-zh', 'zh-en'])
})
