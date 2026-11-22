# 校历变更与双边开通

`GET /school/calendars?school=值` 返回 iCalendar 日表。 `since` 带该校的增量凭据，响应头 `X-Sync-Key` 给后续凭据。完整响应的 `X-Scope` 形如 `2026-11-20/2026-11-21`，仅覆盖当地半开日期。410 表示需重取完整范围。样例使用 IANA TZID 的 DTSTART/DTEND，增量撤销可从记录的 `STATUS:CANCELLED` 看出。
`GET /calling/offers` 返回课堂和两边房间的 `held`、`open`、`closed` 或 `live`。 `POST /calling/amend` 接课堂、学校和原通知号，合计结果按两边实际回读。
演练 `held` 为双方暂留，`local-change` 是一校增量丢失且一方关闭，`accepted` 出现另一班的开通状态。口译员及语言方向在原资料格式中。

旧表里的时间是值班内部抽象分钟。正式校历接口使用独立 IANA 时区的日表，用房接口则按 C1/C2 连接，二者通过课堂标识关联。校历有效范围只声明该站本地日期，C0 占用或历史通知不因另一天的全量响应删除。
