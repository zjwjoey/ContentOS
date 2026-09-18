import Link from 'next/link';
export function OperatorSidebar() { return <aside className="operator-sidebar"><div className="brand-mark">ContentOS <span>运营台</span></div><nav aria-label="全局导航"><Link href="/">首页</Link><Link href="/plan">内容计划</Link><Link href="/edit">剪辑</Link><Link href="/settings">设置</Link></nav><div className="sidebar-foot">V1 · 桌面工作台</div></aside>; }
