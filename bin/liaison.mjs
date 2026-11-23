#!/usr/bin/env node
// 命令行入口。把编排层包成可脚本化的子命令，默认从环境变量取来源地址与状态文件。

import { Liaison } from '../src/liaison.mjs'
import { loadConfig } from '../src/config.mjs'
import { renderPlan, renderTeacher } from '../src/render.mjs'

function parseArgs(argv) {
  const [command, ...rest] = argv
  const options = { _: [] }
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index]
    if (value.startsWith('--')) {
      const key = value.slice(2)
      const next = rest[index + 1]
      if (next === undefined || next.startsWith('--')) options[key] = true
      else {
        options[key] = next
        index += 1
      }
    } else {
      options._.push(value)
    }
  }
  return { command, options }
}

function print(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2))
  const config = loadConfig({
    sourceBase: options.source,
    providerBase: options.provider,
    statePath: options.state,
    now: options.now,
    timeout: options.timeout ? Number(options.timeout) : undefined,
    schools: options.schools ? JSON.parse(options.schools) : undefined
  })
  const liaison = new Liaison(config)
  await liaison.load()

  switch (command) {
    case 'sync': {
      const result = await liaison.sync({
        full: Boolean(options.full),
        edition: options.edition,
        calendars: options.calendars !== 'false',
        offers: options.offers !== 'false'
      })
      if (options.format === 'text') {
        for (const calendar of Object.values(result.calendars)) {
          process.stdout.write(`${calendar.school} 校历：${calendar.syncKey || '未取'} · 范围 ${calendar.scope ? calendar.scope.from + '/' + calendar.scope.until : '—'} · 已发布 ${Object.keys(calendar.published).length}\n`)
        }
        process.stdout.write(renderPlan(result.plan) + '\n')
      } else print(summarizeSync(result))
      return
    }
    case 'plan': {
      const plan = liaison.plan()
      if (options.format === 'text') process.stdout.write(renderPlan(plan) + '\n')
      else print(summarizePlan(plan))
      return
    }
    case 'hold': {
      print(await liaison.hold(options._[0], list(options.by)))
      return
    }
    case 'open': {
      print(await liaison.open(options._[0], list(options.by)))
      return
    }
    case 'confirm': {
      print(await liaison.confirm(options._[0], { schools: list(options.by) }))
      return
    }
    case 'amend': {
      print(await liaison.amend(options._[0], options.by))
      return
    }
    case 'notify': {
      print(await liaison.notify(options._[0], { kind: options.kind || 'reschedule', message: options.message }))
      return
    }
    case 'teacher': {
      const view = liaison.teacherView({ school: options.school, day: options.day })
      if (options.format === 'text') process.stdout.write(renderTeacher(view) + '\n')
      else print(view)
      return
    }
    case 'state': {
      print(liaison.state)
      return
    }
    case 'help':
    case undefined: {
      print({
        commands: {
          sync: '--full --edition r2 --source URL --provider URL --state PATH',
          plan: '输出窗口、接力、关闭与释放结论',
          hold: 'hold <课堂> [--by E,W]',
          open: 'open <课堂> [--by E,W]',
          confirm: 'confirm <课堂> [--by E,W]',
          amend: 'amend <课堂> --by E',
          notify: 'notify <课堂> --kind confirm|reschedule',
          teacher: 'teacher --school E [--day 2026-11-20]',
          state: '输出持久状态'
        }
      })
      return
    }
    default: {
      throw new Error('未知命令: ' + command)
    }
  }
}

function list(value) {
  if (value === undefined || value === true) return undefined
  return String(value).split(',').map(item => item.trim()).filter(Boolean)
}

function summarizeSync(result) {
  return {
    edition: result.edition,
    records: result.records,
    calendars: Object.values(result.calendars).map(calendar => ({
      school: calendar.school,
      syncKey: calendar.syncKey,
      scope: calendar.scope,
      lastSyncAt: calendar.lastSyncAt,
      published: Object.values(calendar.published).map(entry => ({
        uid: entry.uid,
        start: entry.start,
        end: entry.end,
        status: entry.status,
        blocked: entry.blocked,
        localDay: entry.localDay
      }))
    })),
    plan: summarizePlan(result.plan)
  }
}

function summarizePlan(plan) {
  return {
    asOf: plan.asOf,
    asOfText: plan.asOfText,
    sessions: plan.sessions.map(entry => ({
      session: entry.session,
      status: entry.status,
      completeRelay: entry.completeRelay,
      needsReschedule: entry.needsReschedule,
      assignments: Object.fromEntries(Object.entries(entry.assignments).map(([key, value]) => [key, value?.interpreter || null])),
      missingSegments: entry.missingSegments || [],
      issues: entry.issues || [],
      sides: entry.sides.map(side => ({ school: side.school, ok: side.ok, room: side.room, calendar: side.calendar, reasons: side.reasons })),
      opening: entry.opening,
      eligibleToConfirm: entry.eligibleToConfirm
    })),
    releases: plan.releases,
    reschedules: plan.reschedules.map(entry => entry.session),
    completed: plan.completed,
    ready: plan.ready.map(entry => entry.session),
    blocked: plan.blocked.map(entry => entry.session)
  }
}

main().catch(error => {
  process.stderr.write(JSON.stringify({
    error: error.message,
    detail: error.detail ?? null
  }, null, 2) + '\n')
  process.exitCode = 1
})
