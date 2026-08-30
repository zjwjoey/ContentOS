import type { ReactNode } from 'react';
import './globals.css';
import { OperatorShell } from './_components/operator-shell';

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body><OperatorShell>{children}</OperatorShell></body></html>;
}
