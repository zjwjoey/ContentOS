import Link from 'next/link';

export default function EditHomePage() {
  return <main className="shell"><header className="page-header"><p className="eyebrow">ContentOS / Edit</p><h1>剪辑工作台</h1><p className="muted">不需要理解项目、素材或任务编号，选择一种方式就可以开始。</p></header><section className="mode-cards"><Link className="mode-card" href="/edit/script"><strong>脚本剪辑</strong><span>根据文案自动组织多个素材，生成一条完整视频。</span><em>开始脚本剪辑 →</em></Link><Link className="mode-card" href="/edit/mix"><strong>批量混剪</strong><span>批量添加文案和音频，使用多个素材文件夹生成多条视频。</span><em>开始批量混剪 →</em></Link></section><section className="card"><div className="section-title"><h2>最近剪辑</h2><Link className="module-nav-link" href="/edit/history">查看全部</Link></div><RecentEdits /></section></main>;
}

async function RecentEdits() {
  let items: Array<{ id: string; title: string; mode: string; status: string; totalCount: number; succeededCount: number; failedCount: number; createdAt: string }> = [];
  try { const response = await fetch(`${process.env.CONTENTOS_API_URL || 'http://127.0.0.1:3000'}/api/v1/edit/history`, { cache: 'no-store' }); if (response.ok) items = (await response.json() as { items: typeof items }).items.slice(0, 5); } catch { /* empty state is useful while API starts */ }
  if (items.length === 0) return <p className="muted">还没有剪辑记录，先从上面的入口开始。</p>;
  return <ul className="project-list">{items.map((item) => <li key={item.id}><Link href={`/edit/history?batch=${encodeURIComponent(item.id)}`}><span><strong>{item.title}</strong><small>{item.mode === 'MIX' ? '批量混剪' : '脚本剪辑'} · {item.totalCount} 条</small></span><small>{item.status === 'SUCCEEDED' ? '已完成' : item.status === 'PARTIAL' ? `${item.succeededCount} 成功 / ${item.failedCount} 失败` : item.status}</small></Link></li>)}</ul>;
}
