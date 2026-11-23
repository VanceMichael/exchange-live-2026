import { assertTimeZone } from './time.mjs'

export const DEFAULT_SCHOOLS = {
  E: { timeZone: 'Asia/Shanghai' },
  W: { timeZone: 'Australia/Melbourne' }
}

// 配置全部可被命令行或环境变量覆盖，方便演练和测试各自使用临时状态。
export function loadConfig(overrides = {}) {
  const env = process.env
  const schools = {}
  for (const [school, value] of Object.entries({ ...DEFAULT_SCHOOLS, ...(overrides.schools || {}) })) {
    schools[school] = { timeZone: assertTimeZone(value.timeZone || value) }
  }
  return {
    sourceBase: overrides.sourceBase || env.SOURCE_URL || 'http://127.0.0.1:8700',
    providerBase: overrides.providerBase || env.PROVIDER_URL || 'http://127.0.0.1:8701',
    statePath: overrides.statePath || env.LIAISON_STATE || 'data/state.json',
    timeout: Number(overrides.timeout || env.LIAISON_HTTP_TIMEOUT || 5000),
    now: overrides.now || env.LIAISON_NOW || null,
    schools
  }
}

export function schoolOf(config, letter) {
  const school = config.schools[letter]
  if (!school) throw new Error('未知学校: ' + letter)
  return school
}
