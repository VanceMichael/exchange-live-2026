// 记录解析：把制表符记录变成带字段名的对象，并保留原始行以便回读与排错。

function number(value, label, row) {
  if (!/^-?\d+$/.test(String(value))) {
    throw new Error(`${label} 不是整数: ${JSON.stringify(value)}（记录 ${JSON.stringify(row)}）`)
  }
  return Number(value)
}

function text(value, label, row) {
  const trimmed = String(value ?? '').trim()
  if (trimmed === '') throw new Error(`${label} 为空（记录 ${JSON.stringify(row)}）`)
  return trimmed
}

export function parseCalendar(rows) {
  return rows.map(row => {
    const [school, slot, day, open, close] = row
    return {
      school: text(school, '学校', row),
      slot: text(slot, '日历格', row),
      day: text(day, '当地日', row),
      open: number(open, '开放分钟', row),
      close: number(close, '关闭分钟', row),
      raw: row
    }
  })
}

export function parseTimeZones(rows) {
  return rows.map(row => {
    const [school, day, offset] = row
    return {
      school: text(school, '学校', row),
      day: text(day, '当地日', row),
      offset: number(offset, 'UTC 偏移分钟', row),
      raw: row
    }
  })
}

export function parseRooms(rows) {
  return rows.map(row => {
    const [school, room, open, close, state] = row
    return {
      school: text(school, '学校', row),
      room: text(room, '课堂编号', row),
      open: number(open, '开放分钟', row),
      close: number(close, '关闭分钟', row),
      state: text(state, '状态', row),
      raw: row
    }
  })
}

export function parseSessions(rows) {
  return rows.map(row => {
    const [session, pair, slots, lectureStart, lectureEnd, questionsStart, questionsEnd, lectureLanguage, questionsLanguage] = row
    if (!['E,W', 'W,E'].includes(pair)) throw new Error('学校对未知: ' + pair)
    const [first, second] = slots.split(',')
    return {
      session: text(session, '课堂编号', row),
      pair,
      schools: pair.split(','),
      slots,
      slotsBySchool: Object.fromEntries(pair.split(',').map((school, index) => [school, [first, second][index]])),
      lecture: { start: number(lectureStart, '主讲起', row), end: number(lectureEnd, '主讲止', row) },
      questions: { start: number(questionsStart, '问答起', row), end: number(questionsEnd, '问答止', row) },
      languages: { lecture: text(lectureLanguage, '主讲语言', row), questions: text(questionsLanguage, '问答语言', row) },
      raw: row
    }
  })
}

export function parseRoster(rows) {
  return rows.map(row => {
    const [interpreter, start, end, directions] = row
    const list = String(directions).split(',').map(value => value.trim()).filter(Boolean)
    return {
      interpreter: text(interpreter, '口译员', row),
      available: { start: number(start, '可用起', row), end: number(end, '可用止', row) },
      directions: list,
      directionsText: String(directions),
      raw: row
    }
  })
}

export function parseSigned(rows) {
  return rows.map(row => {
    const [session, interpreter, segment, credential, state] = row
    return {
      session: text(session, '课堂', row),
      interpreter: text(interpreter, '志愿者', row),
      segment: text(segment, '环节', row),
      credential: text(credential, '凭据', row),
      state: text(state, '状态', row),
      raw: row
    }
  })
}


export const PARSERS = {
  calendar: parseCalendar,
  tz: parseTimeZones,
  rooms: parseRooms,
  sessions: parseSessions,
  roster: parseRoster,
  signed: parseSigned
}
