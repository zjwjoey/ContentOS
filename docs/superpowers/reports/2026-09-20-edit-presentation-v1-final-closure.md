# ContentOS Editing Presentation V1 Final Integrity Closure

日期：2026-09-20  
审计基线：`c97f640633166e6821db3cc2a03728573ed362eb3`  
实现提交：`2a2934b`  
目标分支：`codex/script-editing-v2-rule-editorial-layer`

## 结论

READY FOR REVIEW。Final Integrity Closure 的 P0/P1 项已完成，真实 PostgreSQL、FFmpeg、Next.js 和浏览器门禁均通过；本轮没有引入 AI 逻辑、主分支合并、PR 或 force push。

## 关闭项

- 文案原文、分段规则或确认段被修改后，旧 `cleanedScript`、segments、plan 和本地缓存立即失效；必须重新点击“整理文案”才能生成方案。生成按钮在未确认时禁用。
- 前端不再复制脚本清洗器；`/api/v1/edit/script/segment` 与共享 `cleanAndSegmentScriptV1` 是唯一自动分段路径，合并/拆分/删除仍是本地确认编辑。
- 字幕预览和 FFmpeg 使用同一归一化中心锚点语义，位置表达式带边界 clamp；SLIDE_UP 也沿用同一锚点。
- `BLUR_BACKGROUND` 使用放大裁切的模糊背景 + 保持比例的清晰前景，不给前景加黑边；增加了真实 640×360→1080×1920 FFmpeg fixture 验证。
- 字体通过 Font Registry API 返回实际存在的字体；渲染前校验字体文件，不可用时稳定失败 `RENDER_SUBTITLE_FONT_UNAVAILABLE`。
- V1 没有稳定的阴影模糊渲染原语，因此移除 UI 的“阴影模糊”控制并在合同归一化时固定为 `0`，不保留伪效果。
- PresentationSettings API 使用严格 schema 与共享 normalize/validate；无效设置返回 `PRESENTATION_SETTINGS_INVALID`。
- “删除空段”改为“删除该段”。Script 与 MIX 继续共用同一 compiler，确认段保持一段一 clip，旧 Manifest 仍兼容。

## 门禁证据

- `pnpm format`：PASS（349 files）
- `pnpm lint`：PASS（141 TypeScript files）
- `pnpm typecheck`：PASS
- `pnpm build`：PASS
- `pnpm --dir apps/web build`：PASS（15/15 pages，含 `/edit/script/v2`）
- `pnpm test`：282/282 PASS，0 failed，0 skipped
- migrations：9/9 PASS（真实 PostgreSQL，`127.0.0.1:55433/contentos_test`）
- Auto Edit V1：27/27 PASS
- Auto Edit V1.5：19/19 PASS
- Script Editing V2 单元/契约/渲染门禁：34/34 PASS
- 浏览器真实门禁：4/4 PASS（Auto Edit、Workbench、Hybrid、Script Editing V2）
- `pnpm doctor`：PASS；仅报告全局 pnpm bin 未加入 PATH 的非阻塞提示
- `git diff --check`：PASS

## 变更范围

API strict contract、canonical script cleaner、Script V2 dirty-state gate、Font Registry、FFmpeg renderer/fixtures、Presentation Settings UI，以及对应单元与浏览器回归测试。`local-media/` 为本机未跟踪素材目录，未加入提交。
