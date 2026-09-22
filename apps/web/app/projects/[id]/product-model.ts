export type ProductStageKey = 'ASSETS' | 'DIRECTOR' | 'BENCHMARK' | 'VIDEO' | 'APPROVALS' | 'PUBLISHER' | 'REVIEW';

export const PRODUCT_STAGES: ReadonlyArray<{ key: ProductStageKey; label: string; href: (projectId: string) => string }> = [
  { key: 'ASSETS', label: '素材库', href: (projectId) => `/projects/${projectId}/assets` },
  { key: 'DIRECTOR', label: '内容策划', href: (projectId) => `/projects/${projectId}/director` },
  { key: 'BENCHMARK', label: '对标分析', href: (projectId) => `/projects/${projectId}/benchmark` },
  { key: 'VIDEO', label: '视频剪辑', href: (projectId) => `/projects/${projectId}/video` },
  { key: 'APPROVALS', label: '审批', href: (projectId) => `/projects/${projectId}/approvals` },
  { key: 'PUBLISHER', label: '发布', href: (projectId) => `/projects/${projectId}/publisher` },
  { key: 'REVIEW', label: '复盘分析', href: (projectId) => `/projects/${projectId}/review` },
];

export function productStageHref(projectId: string, stage: ProductStageKey): string {
  const match = PRODUCT_STAGES.find((item) => item.key === stage);
  if (!match) throw new Error(`Unknown product stage: ${stage}`);
  return match.href(projectId);
}
