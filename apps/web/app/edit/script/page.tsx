import Link from 'next/link';
import { Suspense } from 'react';
import { WorkbenchForm } from '../_components/workbench-form';
export default function ScriptEditPage() { return <main className="shell"><header className="page-header"><p className="eyebrow">剪辑 / 脚本剪辑</p><div className="page-header-row"><div><h1>脚本剪辑</h1><p className="muted">选择 V3 Unified 进入逐句工作台；V2 仍保留。</p></div><div className="module-nav"><Link className="module-nav-link" href="/edit">返回剪辑首页</Link><Link className="module-nav-link" href="/edit/script/v3">Script Editing V3 Unified</Link><Link className="module-nav-link" href="/edit/script/v2">规则方案 V2</Link></div></div></header><Suspense fallback={<p className="muted">正在加载剪辑设置…</p>}><WorkbenchForm mode="SCRIPT" /></Suspense></main>; }
