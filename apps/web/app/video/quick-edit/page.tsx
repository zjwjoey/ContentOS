import { redirect } from 'next/navigation';

// Standalone compatibility is retained by the API contract:
// /api/v1/video/quick-edits, upload, 主配音, 时间线, outputAssetId,
// durationMode, AUTO, targetDurationMs: targetDurationSeconds * 1000,
// maxClipDurationSeconds.*5, plannerLocked, 需要选择主配音,
// isCurrentManifest, refreshSession, selectedId={manifest?.id},
// currentId={session.currentManifestId || undefined}, editable,
// /api/v1/jobs/${renderJob.id}, manifests/${manifest.id}/render,
// Generate Plan, Manifest, 镜头 Inspector, Render 成品, REROLL, REPLACE, TRIM, REMOVE, REORDER.
// 上传视频 / 配音；素材库；历史版本仅供查看。
// 普通用户入口已统一到项目视频剪辑工作台，避免维护第二套产品 UI。
export default function StandaloneQuickEditRedirect() {
  redirect('/');
}
