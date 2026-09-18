import Link from 'next/link';
import { WorkbenchForm } from '../_components/workbench-form';
export default function MixEditPage() { return <main className="shell"><header className="page-header"><p className="eyebrow">剪辑 / 批量混剪</p><div className="page-header-row"><div><h1>批量混剪</h1><p className="muted">逐条添加文案，一次生成多条视频；每条任务独立记录，失败可以单独重试。</p></div><Link className="module-nav-link" href="/edit">返回剪辑首页</Link></div></header><WorkbenchForm mode="MIX" /></main>; }
