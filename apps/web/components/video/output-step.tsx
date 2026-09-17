type OutputManifest = { id: string; manifest: { timeline: Array<{ role?: string; durationMs: number; timelineStartMs?: number; timelineEndMs?: number }> } } | null;
type OutputSnapshot = { currentRender: { manifestId: string; outputAssetId: string } | null; job: { state: string; errorMessage?: string } | null } | null;

function clock(value: number): string { const total = Math.max(0, value) / 1000; return `${String(Math.floor(total / 60)).padStart(2, '0')}:${(total % 60).toFixed(1).padStart(4, '0')}`; }

export function OutputStep({ projectId, manifest, snapshot, introName, outroName, busy, jobRunning, onRender, onBack, onApproval }: { projectId: string; manifest: OutputManifest; snapshot: OutputSnapshot; introName: string; outroName: string; busy: boolean; jobRunning: boolean; onRender: () => void; onBack: () => void; onApproval: () => void }) {
  const current = snapshot?.currentRender?.manifestId === manifest?.id;
  const duration = (manifest?.manifest.timeline || []).reduce((total, clip) => total + (clip.timelineEndMs !== undefined && clip.timelineStartMs !== undefined ? Math.max(clip.durationMs, clip.timelineEndMs - clip.timelineStartMs) : clip.durationMs), 0);
  return <section className="workflow-panel output-panel card">
    <div className="section-title"><h2>⑤ 生成成片</h2><span>{current ? '视频生成完成' : snapshot?.job?.state === 'FAILED' ? '视频生成失败' : '剪辑已准备好'}</span></div>
    <h3>成片预览</h3>
    <p>{manifest?.manifest.timeline.filter((clip) => clip.role === 'CONTENT' || !clip.role).length || 0} 个正文镜头 · 预计时长 {clock(duration)}</p>
    <p className="muted">片头：{introName || '未设置'} · 片尾：{outroName || '未设置'}</p>
    {current ? <><video controls preload="metadata" src={`/api/v1/projects/${projectId}/assets/${snapshot!.currentRender!.outputAssetId}/content`} /><div className="output-actions"><button type="button" onClick={() => onBack()}>返回调整镜头</button><button type="button" onClick={() => onApproval()}>送往审批</button></div></> : <><>{snapshot?.job?.state === 'FAILED' && <p className="status">{snapshot.job.errorMessage || '视频生成失败，请重试。'}</p>}</><button type="button" className="primary-action" onClick={() => onRender()} disabled={busy || !manifest || jobRunning}>{snapshot?.job?.state === 'FAILED' ? '重新生成' : '生成成片'}</button>{jobRunning && <p className="status">正在生成视频……</p>}</>}
  </section>;
}
