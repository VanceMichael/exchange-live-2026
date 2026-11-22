# 校历变更与双边开通

`GET /school/calendars?school=值` 返回 iCalendar 日表。 `since` 带该校的增量凭据，响应头 `X-Sync-Key` 给后续凭据。完整响应的 `X-Scope` 形如 `2026-11-20/2026-11-21`，仅覆盖当地半开日期。410 表示需重取完整范围。样例使用 IANA TZID 的 DTSTART/DTEND，增量撤销可从记录的 `STATUS:CANCELLED` 看出。
`GET /calling/offers` 返回课堂和两边房间的 `held`、`open`、`closed` 或 `live`。 `POST /calling/amend` 接课堂、学校和原通知号，合计结果按两边实际回读。
演练 `held` 为双方暂留，`local-change` 是一校增量丢失且一方关闭，`accepted` 出现另一班的开通状态。口译员及语言方向在原资料格式中。

表里的 UTC 分钟自 2026-11-20T00:00Z 起计，本地时刻自各自日期零点起计。正式校历使用 IANA 时区，UID 在后缀之前给与用房接口相同的 C1/C2 课堂号。校历有效范围只声明该站本地日期，C0 占用或历史通知不因另一天的全量响应删除。

同步覆盖范围按课历记录的当地起始日解释；跨午夜的实际占用延续到真实结束时刻。UID blocked-W 为学校禁止使用房间的时窗。对某个课堂的 CANCELLED 只移除该课堂由该校公布的可用时窗。

/calling/hold 分别接收 session 和 by 取得校方暂留。/calling/open 接收 session 与暂留凭据，202 只表示收到。校方实际开通仍由 offers 查询；后续 accepted 档模拟两边均已开通。
