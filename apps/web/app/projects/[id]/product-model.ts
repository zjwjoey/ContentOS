export type ProductStageKey = 'ASSETS' | 'DIRECTOR' | 'BENCHMARK' | 'VIDEO' | 'APPROVALS' | 'PUBLISHER' | 'REVIEW';

export const PRODUCT_STAGES: ReadonlyArray<{ key: ProductStageKey; label: string; href: (projectId: string) => string }> = [
  { key: 'ASSETS', label: 'Assets', href: (projectId) => `/projects/${projectId}/assets` },
  { key: 'DIRECTOR', label: 'Director', href: (projectId) => `/projects/${projectId}/director` },
  { key: 'BENCHMARK', label: 'Benchmark', href: (projectId) => `/projects/${projectId}/benchmark` },
  { key: 'VIDEO', label: 'Video', href: (projectId) => `/projects/${projectId}/video` },
  { key: 'APPROVALS', label: 'Approval Gate', href: (projectId) => `/projects/${projectId}/approvals` },
  { key: 'PUBLISHER', label: 'Publisher', href: (projectId) => `/projects/${projectId}/publisher` },
  { key: 'REVIEW', label: 'Review Analytics', href: (projectId) => `/projects/${projectId}/review` },
];

export function productStageHref(projectId: string, stage: ProductStageKey): string {
  const match = PRODUCT_STAGES.find((item) => item.key === stage);
  if (!match) throw new Error(`Unknown product stage: ${stage}`);
  return match.href(projectId);
}
