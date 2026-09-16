export type EditMode = 'SCRIPT' | 'RANDOM';

export function EditModeSelector({ mode, onSelect }: { mode: EditMode | null; onSelect: (mode: EditMode) => void }) {
  return <section className="mode-cards">
    <button type="button" className={`mode-card${mode === 'SCRIPT' ? ' selected' : ''}`} onClick={() => onSelect('SCRIPT')}><strong>按脚本剪辑</strong><span>根据脚本文案逐句匹配视频素材，一句话对应一个镜头。</span><em>开始脚本剪辑 →</em></button>
    <button type="button" className={`mode-card${mode === 'RANDOM' ? ' selected' : ''}`} onClick={() => onSelect('RANDOM')}><strong>随机混剪</strong><span>从授权素材文件夹随机选择片段，一句话对应一个镜头。</span><em>开始随机混剪 →</em></button>
  </section>;
}
