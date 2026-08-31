# Benchmark Library V1

Benchmark Library 是项目级对标资料库，不做自动抓取。用户人工录入账号、链接和文案后，Benchmark Worker 通过 `BENCHMARK_ANALYZE` Durable Job 调用 Fake 或真实文本 AI，生成结构化分析。

核心实体：`BenchmarkAccount`（平台、账号、定位、分类、关键词、备注）、`BenchmarkContent`（标题、链接、文案、可选发布时间和手工指标）和 append-only `BenchmarkAnalysis`。内容通过 `benchmark_references` 明确绑定到 Content Project，才能作为 Director Reference。

分析字段包括 Hook、Opening Structure、Content Structure、Information Density、Rhythm、Emotional Change、Evidence/Data Usage、Story/Opinion Structure、Ending/CTA、Title Pattern、Reusable Structure、Success Reasons、ContentOS Lessons 和 Do Not Copy。分析是启发式参考，不会直接复制原文生成脚本。
