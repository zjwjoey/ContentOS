# Review V1

Review 只代表发布后的数据复盘，不替代发布前 Approval Gate。一个已确认 `ExternalPost` 可以追加多个不可变 Metric Snapshot，每条包含采集时间、播放、点赞、评论、收藏、分享、来源和来源引用，并可选记录粉丝变化、完播率和平均观看时长。

Review 页面提供 Fake/Import 采集、手动追加、历史列表和相邻快照变化。AI Review 通过 Durable Job 读取项目、发布元数据、Script、Storyboard 和指标历史，输出摘要、亮点、风险和建议；每次报告都保存版本和 `aiRunId`，失败状态对用户可见。
