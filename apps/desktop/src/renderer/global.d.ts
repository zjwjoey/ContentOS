import type { DesktopApi } from '../../../../packages/desktop-contract/src/index.js';
declare global { interface Window { contentosDesktop: DesktopApi; } }
export {};
