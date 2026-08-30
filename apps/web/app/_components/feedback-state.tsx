export function LoadingState({ text = '正在加载…' }: { text?: string }) { return <p className="feedback loading-state">{text}</p>; }
export function EmptyState({ text }: { text: string }) { return <p className="feedback empty-state">{text}</p>; }
export function ErrorState({ text }: { text: string }) { return <p className="feedback error-state">{text}</p>; }
