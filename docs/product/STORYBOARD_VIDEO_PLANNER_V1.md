# Storyboard-driven Video Planner V1

Video 保留 Random Planner，并新增 Storyboard Planner。输入是已批准 Storyboard、READY 视频素材、素材标签/文件名/metadata、可选配音和 seed。

每个 Scene 的 `asset_keywords` 被拆分为确定性 token；系统对每个素材计算 `matchedKeywords / keywordCount * 100` 的 score，按 score 降序和 Asset ID 稳定排序，避免相邻重复。所有 Scene 均写入合法 `EDIT_MANIFEST_V0`，Renderer 只消费 Manifest，不做创意推断。

没有关键词匹配时，记录 `fallback: true` 并使用确定性候选；当分镜总时长不足目标时回退 Random Planner。相同输入和 seed 必须产生相同决策，Planner 结果可在 Video 页面按 Manifest 版本查看。
