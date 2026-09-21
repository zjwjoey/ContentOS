import Link from 'next/link';

export default function DigitalHumanWorkspacePage({ params }: { params: { id: string } }) {
  const { id } = params;
  return (
    <main className="shell project-workspace">
      <div className="workspace-header">
        <div><p className="eyebrow">Digital Human V1</p><h1>数字人工作台</h1><p className="muted">声音 → 数字人 → 成片。长任务会进入 Job 队列，生成结果统一回到 Asset。</p></div>
        <Link className="module-nav-link" href={`/projects/${id}`}>返回项目</Link>
      </div>
      <div className="workspace-grid">
        <section className="card"><h2>① 声音</h2><p className="muted">管理 Voice Profile，使用本地 Speech Gateway 生成音频。</p><Link className="module-nav-link" href={`/projects/${id}/assets`}>选择参考声音</Link></section>
        <section className="card"><h2>② 数字人</h2><p className="muted">选择人物底片与已生成配音，提交云端 Avatar Provider。</p><span className="status">支持恢复外部任务与幂等提交</span></section>
        <section className="card"><h2>③ 成片</h2><p className="muted">字幕使用已知文本的 Synthetic Timing，复杂剪辑继续复用现有编辑工作台。</p><Link className="module-nav-link" href={`/projects/${id}/video`}>打开剪辑工作台</Link></section>
      </div>
      <section className="card"><h2>API 入口</h2><p className="muted">`/api/v1/projects/{id}/digital-human/*`</p><p className="muted">当前页面提供工作台入口；素材选择、生成进度和结果预览沿用现有 Asset / Job / Video 模块。</p></section>
    </main>
  );
}
