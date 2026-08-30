import type { ReactNode } from 'react';
import { OperatorSidebar } from './operator-sidebar';
import { OperatorTopbar } from './operator-topbar';
export function OperatorShell({ children }: { children: ReactNode }) { return <div className="operator-shell"><OperatorSidebar /><div className="operator-main"><OperatorTopbar />{children}</div></div>; }
