# ContentOS V1 普通用户流程

1. 启动 ContentOS 后打开首页，点击“创建项目”，填写项目名称、选题、平台、账号和计划日期。
2. 进入项目总控，查看当前阶段和“待处理事项”，点击 Director。
3. 在 ContentBrief 填写定位、受众、时长、内容类型、语气、关键词和事实依据，点击保存；点击“生成 Script”。
4. 在 Script 列表查看 AI 版本，可在编辑框修改并“保存为新版本”，确认具体版本后点击接受。
5. 对接受的 Script 点击“生成 Storyboard Job”。每个 Scene 会展示口播、画面指令、时长和素材关键词；可编辑场景 JSON 并保存为新版本，确认后批准。
6. 打开 Benchmark，录入对标账号和对标内容，点击“AI 分析”，查看 Hook、结构、节奏和可复用建议，再点击“作为 Director Reference”。
7. 打开 Assets，多选上传视频/音频。等待 Import 进入 READY；可为素材添加标签并按类型/标签筛选、预览。
8. 打开 Video，选择素材和规划器。Random 用于随机混剪；Storyboard 按分镜关键词和素材标签匹配，无匹配时自动回退。点击创建渲染 Job。
9. Job 完成后在 Video 预览成片。选择 Manifest 版本可查看历史；对当前版本执行调整并生成新版本，再按需渲染。
10. 点击“送往 Approval Gate”，在 Approval 页面批准明确的 Render Revision。
11. 打开 Publisher，创建 Fake 账号和发布草稿，选择成片、标题、描述、hashtags、可选封面和账号；在 Approval Gate 批准发布 Revision，再点击进入发布队列。
12. Fake Worker 完成后，Publisher 显示 Attempt、ExternalPost、链接和最终状态。失败、登录失效、RECONCILING 都会显示下一步人工动作。
13. 打开 Review，选择 ExternalPost。可以“追加快照”手动录入指标，查看多个快照和播放变化，点击“生成 AI 复盘”查看历史报告。

没有任何一步要求用户填写 Job ID、Asset ID、Manifest Digest 或执行 SQL；内部标识只在详情中显示。
