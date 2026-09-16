'use client';

import { useEffect, useRef } from 'react';

export function ClipPreview({ src, sourceInMs, durationMs, label }: { src?: string; sourceInMs: number; durationMs: number; label?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video || !src) return;
    const seek = () => { video.currentTime = Math.max(0, sourceInMs / 1000); };
    const stop = () => { if (video.currentTime >= (sourceInMs + durationMs) / 1000) video.pause(); };
    video.addEventListener('loadedmetadata', seek); video.addEventListener('timeupdate', stop); seek();
    return () => { video.removeEventListener('loadedmetadata', seek); video.removeEventListener('timeupdate', stop); };
  }, [src, sourceInMs, durationMs]);
  if (!src) return <div className="feedback">选择镜头后预览源素材</div>;
  return <video ref={ref} className="media-preview clip-preview" controls preload="metadata" aria-label={label ? '当前镜头源素材' : undefined} src={src} />;
}
