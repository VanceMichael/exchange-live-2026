// 终端可读的表格与摘要。命令行用它输出教师视图和计划结论；
// 程序化调用仍拿结构化 JSON。

function width(text) {
  // CJK 字符按两列估算，足够本地终端对齐。
  let total = 0
  for (const char of String(text)) total += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1
  return total
}

function pad(text, size) {
  return String(text) + ' '.repeat(Math.max(0, size - width(text)))
}

export function table(headers, rows) {
  const sizes = headers.map((header, index) =>
    Math.max(width(header), ...rows.map(row => width(row[index] ?? ''))))
  const line = values => '| ' + values.map((value, index) => pad(value, sizes[index])).join(' | ') + ' |'
  return [
    line(headers),
    '| ' + sizes.map(size => '-'.repeat(size)).join(' | ') + ' |',
    ...rows.map(line)
  ].join('\n')
}

export function renderTeacher(view) {
  const rows = view.sessions.map(entry => {
    const connected = Object.entries(entry.evidence)
      .map(([school, detail]) => detail.accepted ? school : detail.held ? school + '(暂留)' : detail.closed ? school + '(关闭)' : school + '(未接通)')
      .join(' ')
    return [
      entry.session,
      statusLabel(entry.status),
      `${entry.lecture.localStart}–${entry.lecture.localEnd} ${entry.lecture.interpreter || '—'}`,
      `${entry.questions.localStart}–${entry.questions.localEnd} ${entry.questions.interpreter || '—'}`,
      connected,
      entry.waiting.length ? entry.waiting.join('；') : '—',
      entry.notificationSentAt || '—'
    ]
  })
  const completed = view.completed.map(entry => [
    entry.session,
    entry.originals.map(item => item.segment + ':' + item.interpreter).join(' '),
    entry.schools.join(' ')
  ])
  return [
    `学校 ${view.school}（${view.timeZone}）${view.day ? '本地日 ' + view.day : '全部本地日'}`,
    '',
    table(['课堂', '状态', '主讲', '问答', '接通实据', '仍待', '通知已发'], rows),
    ...(completed.length ? ['', '已完成（保留原资源，不重新择配）', table(['课堂', '原资源', '学校'], completed)] : []),
    ...(view.reschedules.length ? ['', '需联络员改约：' + view.reschedules.map(entry => entry.session).join('、')] : [])
  ].join('\n')
}

const STATUS_LABELS = {
  notified: '已通知',
  ready: '可接力',
  reschedule: '改约',
  'room-closed': '房间关闭',
  'commitment-at-risk': '承诺待续查',
  blocked: '待补齐'
}

export function statusLabel(status) {
  return STATUS_LABELS[status] || status || '待排'
}

export function renderPlan(plan) {
  const rows = plan.sessions.map(entry => [
    entry.session,
    statusLabel(entry.status),
    entry.schools.map(school => {
      const local = entry.local[school]
      return school + ' ' + local.lecture.startText + '–' + local.questions.endText
    }).join(' / '),
    Object.entries(entry.assignments).map(([key, value]) => key + ':' + value.interpreter).join(' ') || '—',
    entry.sides.map(side => side.school + (side.ok ? '✓' : '✗')).join(' '),
    entry.needsReschedule ? '是' : '否',
    entry.releases.length ? entry.releases.map(item => item.label + '@' + item.releaseBy).join(' ') : '—'
  ])
  return [
    `截至 ${plan.asOfText}`,
    '',
    table(['课堂', '状态', '各校本地时段', '接力', '双边', '改约', '释放期限'], rows),
    '',
    `可接力 ${plan.ready.length} · 待补齐 ${plan.blocked.length} · 改约 ${plan.reschedules.length} · 已完成 ${plan.completed.length}`
  ].join('\n')
}