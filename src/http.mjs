// 轻量 HTTP 客户端：统一超时、状态码和错误体，便于把来源的拒答原样带到上层。

const DEFAULT_TIMEOUT = Number(process.env.LIAISON_HTTP_TIMEOUT || 5000)

export class HttpError extends Error {
  constructor(message, { status, url, body, headers } = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.url = url
    this.body = body
    this.headers = headers
  }
}

async function request(url, options = {}) {
  const { timeout = DEFAULT_TIMEOUT, ...rest } = options
  let response
  try {
    response = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeout) })
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      throw new HttpError('请求超时: ' + url, { url })
    }
    throw new HttpError('无法连接: ' + url + '（' + error.message + '）', { url })
  }
  const body = await response.text()
  if (!response.ok && response.status !== 304) {
    let detail = body
    try {
      detail = JSON.parse(body)
    } catch {
      // 保留原始文本
    }
    throw new HttpError('请求失败 ' + response.status + ': ' + url, {
      status: response.status,
      url,
      body: detail,
      headers: Object.fromEntries(response.headers)
    })
  }
  return { status: response.status, headers: response.headers, body }
}

export async function getText(url, options) {
  return request(url, options)
}

export async function getJson(url, options) {
  const result = await request(url, options)
  if (!result.body) return { ...result, data: undefined }
  try {
    return { ...result, data: JSON.parse(result.body) }
  } catch {
    throw new HttpError('响应不是 JSON: ' + url, {
      status: result.status,
      url,
      body: result.body,
      headers: Object.fromEntries(result.headers)
    })
  }
}

export async function postJson(url, payload, options = {}) {
  return getJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    ...options
  })
}

export function headerObject(headers) {
  return headers ? Object.fromEntries(headers) : {}
}
