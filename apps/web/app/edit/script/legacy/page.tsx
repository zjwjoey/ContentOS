import { Suspense } from 'react';
import { WorkbenchForm } from '../../_components/workbench-form';

/**
 * Compatibility surface for existing saved Workbench flows and regression
 * coverage. The official product entry remains /edit/script (V3 Unified).
 */
export default function LegacyScriptWorkbenchPage() {
  return <main className="shell"><header className="page-header"><p className="eyebrow">剪辑 / 脚本剪辑</p><h1>脚本剪辑兼容工作台</h1><p className="muted">保留既有 Workbench 任务的读取与继续编辑能力。</p></header><Suspense fallback={<p className="muted">正在加载剪辑设置…</p>}><WorkbenchForm mode="SCRIPT" /></Suspense></main>;
}
