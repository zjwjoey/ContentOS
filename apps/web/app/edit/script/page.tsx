import Link from 'next/link';
import { WorkbenchForm } from '../_components/workbench-form';
export default function ScriptEditPage() { return <main className="shell"><header className="page-header"><p className="eyebrow">剪辑 / 脚本剪辑</p><div className="page-header-row"><div><h1>脚本剪辑</h1><p className="muted">输入文案，添加一个或多个素材文件夹，剩下的交给 ContentOS。</p></div><Link className="module-nav-link" href="/edit">返回剪辑首页</Link></div></header><WorkbenchForm mode="SCRIPT" /></main>; }
