import Link from 'next/link';

export function ScriptSourceSelector({ projectId, source, revision, sentenceCount, available, onSelect }: { projectId: string; source: 'PROJECT' | 'CUSTOM'; revision?: number; sentenceCount: number; available: boolean; onSelect: (source: 'PROJECT' | 'CUSTOM') => void }) {
  return <fieldset className="source-choice"><legend>文案来源</legend>
    <label><input type="radio" checked={source === 'PROJECT'} onChange={() => onSelect('PROJECT')} />使用当前项目脚本</label>
    <label><input type="radio" checked={source === 'CUSTOM'} onChange={() => onSelect('CUSTOM')} />粘贴自定义脚本</label>
    {source === 'PROJECT' && (available ? <p className="status">当前项目脚本 · 版本 {revision} · 已载入 {sentenceCount} 句话</p> : <p className="status">当前项目暂无可用脚本，请先到“脚本与分镜”完成脚本。<br /><Link href={`/projects/${projectId}/director`}>前往脚本与分镜</Link></p>)}
  </fieldset>;
}
