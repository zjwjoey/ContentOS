"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  EditModeSelector,
  type EditMode,
} from "../../../../components/video/edit-mode-selector";
import { MediaBrowser } from "../../../../components/video/media-browser";
import { OutputStep } from "../../../../components/video/output-step";
import { ReviewStep } from "../../../../components/video/review-step";

// 兼容旧版测试与历史入口：生成视频调整版本、创建精确渲染 Job、Manifest v、时间线、TRIM、REMOVE、REORDER、REPLACE、REROLL。

type Asset = {
  id: string;
  kind: string;
  lifecycle: string;
  byteSize: number;
  originalName: string;
  metadata: {
    durationMs?: number;
    width?: number;
    height?: number;
    tags?: string[];
  };
};
type MediaItem = {
  id: string;
  originalName: string;
  durationMs: number;
  width?: number;
  height?: number;
  orientation?: string;
  tags?: string[];
  category?: string;
  usageCount?: number;
  lastUsedAt?: string;
  thumbnailStatus?: string;
  thumbnailUrl?: string;
};
type Clip = {
  assetId: string;
  sourceInMs: number;
  durationMs: number;
  transition?: "cut" | "fade";
  sentenceIndex?: number;
  sentenceText?: string;
  sceneId?: string;
  role?: "INTRO" | "CONTENT" | "OUTRO";
  reviewStatus?: "GOOD" | "REVIEW" | "MANUAL";
  voiceStartMs?: number;
  voiceEndMs?: number;
  timelineStartMs?: number;
  timelineEndMs?: number;
  matching?: {
    matchedKeywords: string[];
    matchScore: number;
    fallback: boolean;
    matchingReason: string;
  };
};
type Manifest = {
  id: string;
  revision: number;
  status: "PERSISTED" | "SUPERSEDED";
  manifest: {
    timeline: Clip[];
    seed: number;
    metadata?: {
      editMode?: "SCRIPT" | "RANDOM";
      localMediaSourceRootId?: string;
      localMediaScanId?: string;
      audioOffsetMs?: number;
    };
  };
};
type Snapshot = {
  sourceAssets: Asset[];
  currentRender: {
    renderId: string;
    outputAssetId: string;
    manifestId: string;
    status: string;
  } | null;
  renderHistory: Array<{
    renderId: string;
    outputAssetId?: string;
    status: string;
  }>;
  job: {
    id: string;
    state: string;
    attemptCount: number;
    maxAttempts: number;
  } | null;
  approval: { status: string } | null;
};
type ScriptInfo = {
  scriptRevisionId: string;
  revision: number;
  title: string;
  body: string;
  status: string;
};
type Scan = {
  id: string;
  sourceRootId: string;
  status: string;
  progress: {
    discovered?: number;
    analyzed?: number;
    available?: number;
    unavailable?: number;
  };
  files: Array<{
    fileName: string;
    relativePath: string;
    durationMs: number;
    width: number;
    height: number;
    available: boolean;
    orientation?: string;
    tags?: string[];
    category?: string;
    usageCount?: number;
    lastUsedAt?: string;
    thumbnailStatus?: string;
  }>;
};
type Preset = {
  id: string;
  name: string;
  description: string;
  editModeDefault: EditMode;
  minClipDurationMs: number;
  maxClipDurationMs: number;
  preferUnusedMedia: boolean;
  introAssetId: string | null;
  outroAssetId: string | null;
  canvas?: { width: number; height: number; aspectRatio: "9:16" };
  fps?: number;
};
type ApiError = { error?: { message?: string } };
type ReviewFilter = "ALL" | "REVIEW" | "MANUAL";
const activeJobs = new Set([
  "QUEUED",
  "RUNNING",
  "RETRY_WAIT",
  "CANCEL_REQUESTED",
]);
async function responseMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    return ((await response.json()) as ApiError).error?.message || fallback;
  } catch {
    return fallback;
  }
}
export default function VideoPage({ params }: { params: { id: string } }) {
  const projectId = params.id;
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState<EditMode | null>(null);
  const [script, setScript] = useState("");
  const [scriptInfo, setScriptInfo] = useState<ScriptInfo | null>(null);
  const [scriptSource, setScriptSource] = useState<"PROJECT" | "CUSTOM">(
    "PROJECT",
  );
  const [scriptCount, setScriptCount] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [renderingManifestId, setRenderingManifestId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [manifestHistory, setManifestHistory] = useState<Manifest[]>([]);
  const [selectedClip, setSelectedClip] = useState<number | null>(null);
  const [selectedClips, setSelectedClips] = useState<number[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("ALL");
  const [operations, setOperations] = useState<Array<Record<string, unknown>>>(
    [],
  );
  const [sourceRoot, setSourceRoot] = useState("");
  const [recursive, setRecursive] = useState(true);
  const [scan, setScan] = useState<Scan | null>(null);
  const [indexedMedia, setIndexedMedia] = useState<MediaItem[]>([]);
  const [indexTotal, setIndexTotal] = useState(0);
  const [mediaPage, setMediaPage] = useState(1);
  const [mediaHasNext, setMediaHasNext] = useState(false);
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [orientation, setOrientation] = useState("ALL");
  const [category, setCategory] = useState("");
  const [usage, setUsage] = useState("ALL");
  const [sort, setSort] = useState("RECOMMENDED");
  const [detailsAsset, setDetailsAsset] = useState<MediaItem | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [categoryDraft, setCategoryDraft] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [introAssetId, setIntroAssetId] = useState("");
  const [outroAssetId, setOutroAssetId] = useState("");
  const [preferUnused, setPreferUnused] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [seed, setSeed] = useState(1);
  const [editIdempotencyKey, setEditIdempotencyKey] = useState("");

  const applyPresetToUi = (next: Preset | null) => {
    setPreset(next);
    if (!next) return;
    setMode(next.editModeDefault);
    setPreferUnused(next.preferUnusedMedia);
    setIntroAssetId(next.introAssetId || "");
    setOutroAssetId(next.outroAssetId || "");
  };

  const loadScript = useCallback(async () => {
    const response = await fetch(
      `/api/v1/projects/${projectId}/video/current-script`,
    );
    if (!response.ok) {
      setScriptInfo(null);
      return;
    }
    const next = (await response.json()) as ScriptInfo;
    setScriptInfo(next);
    if (scriptSource === "PROJECT") setScript(next.body);
  }, [projectId, scriptSource]);
  const refresh = useCallback(async () => {
    const response = await fetch(`/api/v1/projects/${projectId}/video`);
    if (!response.ok) {
      setMessage(await responseMessage(response, "视频剪辑读取失败。"));
      return;
    }
    const next = (await response.json()) as Snapshot;
    setSnapshot(next);
    const manifestsResponse = await fetch(
      `/api/v1/projects/${projectId}/video/manifests`,
    );
    if (manifestsResponse.ok) {
      const data = (await manifestsResponse.json()) as { items: Manifest[] };
      setManifestHistory(data.items);
      setManifest(
        (current) =>
          current ||
          data.items.find((item) => item.status === "PERSISTED") ||
          data.items[0] ||
          null,
      );
    }
  }, [projectId]);
  const loadPresets = useCallback(async () => {
    const response = await fetch("/api/v1/video/presets");
    if (response.ok) {
      const data = (await response.json()) as { items: Preset[] };
      setPresets(data.items);
    }
    const current = await fetch(`/api/v1/projects/${projectId}/video/preset`);
    if (current.ok) {
      const data = (await current.json()) as { preset: Preset | null };
      applyPresetToUi(data.preset);
    }
  }, [projectId]);
  const loadIndex = useCallback(async () => {
    if (!scan?.sourceRootId) return;
    const params = new URLSearchParams({
      projectId,
      page: String(mediaPage),
      pageSize: "50",
      sort,
      ...(query ? { query } : {}),
      ...(orientation !== "ALL" ? { orientation } : {}),
      ...(category ? { category } : {}),
      ...(usage !== "ALL" ? { usage } : {}),
    });
    const response = await fetch(`/api/v1/video/local-media/index?${params}`);
    if (!response.ok) return;
    const data = (await response.json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
      hasNext?: boolean;
    };
    const items = data.items.map((file) => {
      const relativePath = String(file.relativePath || "");
      const id = `${scan.sourceRootId}:${relativePath}`;
      return {
        id,
        originalName: String(file.fileName),
        durationMs: Number(file.durationMs || 0),
        width: Number(file.width || 0),
        height: Number(file.height || 0),
        orientation: String(file.orientation || "UNKNOWN"),
        tags: Array.isArray(file.tags) ? (file.tags as string[]) : [],
        category: file.category ? String(file.category) : undefined,
        usageCount: Number(file.usageCount || 0),
        lastUsedAt: file.lastUsedAt ? String(file.lastUsedAt) : undefined,
        thumbnailStatus: file.thumbnailStatus
          ? String(file.thumbnailStatus)
          : "PENDING",
        thumbnailUrl: `/api/v1/video/local-media/thumbnails/${encodeURIComponent(id)}?projectId=${encodeURIComponent(projectId)}`,
      };
    });
    setIndexedMedia(items);
    setIndexTotal(data.total);
    setMediaHasNext(Boolean(data.hasNext));
  }, [
    category,
    orientation,
    projectId,
    query,
    scan?.sourceRootId,
    mediaPage,
    sort,
    usage,
  ]);
  useEffect(() => {
    void refresh();
    void loadScript();
    void loadPresets();
  }, [loadPresets, loadScript, refresh]);
  useEffect(() => {
    void loadIndex();
  }, [loadIndex]);
  useEffect(() => {
    if (!snapshot?.job || !activeJobs.has(snapshot.job.state)) return;
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [refresh, snapshot?.job?.id, snapshot?.job?.state]);
  useEffect(() => {
    if (!renderingManifestId) return;
    if (snapshot?.currentRender?.manifestId === renderingManifestId || (snapshot?.job && !activeJobs.has(snapshot.job.state))) {
      setRenderingManifestId(null);
      return;
    }
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => window.clearInterval(timer);
  }, [refresh, renderingManifestId, snapshot?.currentRender?.manifestId, snapshot?.job?.state]);
  useEffect(() => {
    if (!scan?.sourceRootId || !indexedMedia.some((item) => item.thumbnailStatus === "PENDING")) return;
    const timer = window.setInterval(() => void loadIndex(), 1500);
    return () => window.clearInterval(timer);
  }, [indexedMedia, loadIndex, scan?.sourceRootId]);
  useEffect(() => {
    if (!script.trim()) {
      setScriptCount(0);
      return;
    }
    const timer = window.setTimeout(() => {
      void fetch("/api/v1/video/sentence-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ script }),
      })
        .then((response) =>
          response.ok
            ? (response.json() as Promise<{ items: unknown[] }>)
            : null,
        )
        .then((data) => setScriptCount(data?.items.length || 0));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [script]);
  useEffect(() => {
    if (manifest?.manifest.metadata?.localMediaScanId && !scan)
      void fetch(
        `/api/v1/video/local-media/scans/${manifest.manifest.metadata.localMediaScanId}?projectId=${encodeURIComponent(projectId)}`,
      )
        .then((response) =>
          response.ok ? (response.json() as Promise<Scan>) : null,
        )
        .then((next) => {
          if (next) setScan(next);
        });
  }, [manifest, projectId, scan]);

  const projectMedia = useMemo(
    () =>
      (snapshot?.sourceAssets || [])
        .filter(
          (asset) => asset.lifecycle === "READY" && asset.kind === "VIDEO",
        )
        .map((asset) => ({
          id: asset.id,
          originalName: asset.originalName,
          durationMs: Number(asset.metadata.durationMs || 0),
          width: asset.metadata.width,
          height: asset.metadata.height,
          tags: asset.metadata.tags,
          usageCount: 0,
          thumbnailStatus: "NONE",
        })),
    [snapshot],
  );
  const mediaAssets =
    scan?.status === "SUCCEEDED" ? [...projectMedia, ...indexedMedia] : projectMedia;
  useEffect(() => {
    if (projectMedia.length === 0) return;
    setSelectedAssets((current) => current.length > 0 ? current : projectMedia.map((asset) => asset.id));
  }, [projectMedia]);
  const currentClip =
    manifest && selectedClip !== null
      ? manifest.manifest.timeline[selectedClip]
      : undefined;
  const clipSource = useMemo(() => {
    if (!currentClip) return undefined;
    const rootId = manifest?.manifest.metadata?.localMediaSourceRootId;
    if (rootId && currentClip.assetId.startsWith(`${rootId}:`))
      return `/api/v1/video/local-media/content?projectId=${encodeURIComponent(projectId)}&sourceRootId=${encodeURIComponent(rootId)}&fileId=${encodeURIComponent(currentClip.assetId)}`;
    return `/api/v1/projects/${projectId}/assets/${encodeURIComponent(currentClip.assetId)}/content`;
  }, [currentClip, manifest, projectId]);
  const jobRunning = Boolean(
    snapshot?.job && activeJobs.has(snapshot.job.state),
  );
  const reviewCount =
    manifest?.manifest.timeline.filter(
      (clip) => clip.reviewStatus === "REVIEW" || clip.matching?.fallback,
    ).length || 0;
  const manualCount = manifest?.manifest.timeline.filter((clip) => clip.reviewStatus === "MANUAL").length || 0;
  const visibleClipIndexes = useMemo(() => (manifest?.manifest.timeline || []).map((clip, index) => ({ clip, index })).filter(({ clip }) => reviewFilter === "ALL" ? true : reviewFilter === "MANUAL" ? clip.reviewStatus === "MANUAL" : clip.reviewStatus === "REVIEW" || clip.matching?.fallback).map(({ index }) => index), [manifest, reviewFilter]);
  const clipThumbnail = (clip: Clip): string | undefined => {
    if (!clip.assetId.startsWith("local-")) return undefined;
    const rootId = clip.assetId.split(":", 1)[0] || "";
    return `/api/v1/video/local-media/thumbnails/${encodeURIComponent(clip.assetId)}?projectId=${encodeURIComponent(projectId)}&sourceRootId=${encodeURIComponent(rootId)}`;
  };

  const chooseMode = (next: EditMode) => {
    setMode(next);
    if (next === "SCRIPT") void loadScript();
  };
  const toggleAsset = (id: string) =>
    setSelectedAssets((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  const scanFolder = async () => {
    if (!sourceRoot.trim()) {
      setMessage("请先输入素材文件夹路径。");
      return;
    }
    setBusy(true);
    const response = await fetch("/api/v1/video/local-media/scan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        sourceRoot: sourceRoot.trim(),
        recursive,
      }),
    });
    setBusy(false);
    if (!response.ok) {
      setMessage(await responseMessage(response, "素材文件夹扫描失败。"));
      return;
    }
    const created = (await response.json()) as {
      scanId: string;
      sourceRootId: string;
      jobId: string;
      state: string;
      progress: Scan["progress"];
    };
    setScan({
      id: created.scanId,
      sourceRootId: created.sourceRootId,
      status: created.state,
      progress: created.progress || {},
      files: [],
    });
    setMessage("正在扫描素材……");
    const poll = async (): Promise<void> => {
      const statusResponse = await fetch(
        `/api/v1/video/local-media/scans/${created.scanId}?projectId=${encodeURIComponent(projectId)}`,
      );
      if (!statusResponse.ok) return;
      const next = (await statusResponse.json()) as Scan;
      setScan(next);
      if (["QUEUED", "RUNNING"].includes(next.status))
        window.setTimeout(() => void poll(), 700);
      else {
          setMessage(
            next.status === "SUCCEEDED"
              ? `扫描完成：可用 ${next.progress.available || next.files.filter((file) => file.available).length} 个视频（共 ${next.progress.discovered || next.files.length} 条）。`
            : "素材扫描未完成，请重试。",
        );
            if (next.status === "SUCCEEDED") {
              const localSelection = next.files.filter((file) => file.available).map((file) => ({ id: `${next.sourceRootId}:${file.relativePath}`, originalName: file.fileName, durationMs: file.durationMs, width: file.width, height: file.height, orientation: file.orientation, tags: file.tags, category: file.category, usageCount: file.usageCount, lastUsedAt: file.lastUsedAt, thumbnailStatus: file.thumbnailStatus || "PENDING", thumbnailUrl: `/api/v1/video/local-media/thumbnails/${encodeURIComponent(`${next.sourceRootId}:${file.relativePath}`)}?projectId=${encodeURIComponent(projectId)}` }));
              setIndexedMedia(localSelection);
              setSelectedAssets((current) => [...new Set([...current, ...projectMedia.map((asset) => asset.id), ...localSelection.map((asset) => asset.id)])]);
              setIndexTotal(next.files.filter((file) => file.available).length);
              setStep(2);
          await loadIndex();
        }
      }
    };
    void poll();
  };
  const saveMediaDetails = async () => {
    if (!detailsAsset) return;
    const fileId = encodeURIComponent(detailsAsset.id);
    const tags = `${tagDraft},${tagInput}`
      .split(/[,，\n]/u)
      .map((tag) => tag.trim())
      .filter(Boolean);
    const response = await fetch(
      `/api/v1/video/local-media/index/${fileId}?projectId=${encodeURIComponent(projectId)}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category: categoryDraft || null, tags }),
      },
    );
    setMessage(
      response.ok
        ? "素材信息已保存。"
        : await responseMessage(response, "素材信息保存失败。"),
    );
    if (response.ok) {
      setDetailsAsset(null);
      await loadIndex();
    }
  };
  const createPlan = async () => {
    if (!mode || !script.trim()) {
      setMessage("请先准备文案。");
      return;
    }
    setBusy(true);
    const selectedPreset = preset;
    const response = await fetch(
      `/api/v1/projects/${projectId}/video/montage-plans`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode,
          script,
          seed,
          minClipDurationMs: selectedPreset?.minClipDurationMs || 2000,
          maxClipDurationMs: selectedPreset?.maxClipDurationMs || 5000,
          ...(scan?.status === "SUCCEEDED" ? { scanId: scan.id } : {}),
          videoAssetIds: selectedAssets.filter((id) => !id.startsWith("local-")),
          selectedLocalMediaIds: selectedAssets.filter((id) => id.startsWith("local-")),
          preferUnusedMedia: preferUnused,
          ...(introAssetId || selectedPreset?.introAssetId
            ? { introAssetId: introAssetId || selectedPreset.introAssetId }
            : {}),
          ...(outroAssetId || selectedPreset?.outroAssetId
            ? { outroAssetId: outroAssetId || selectedPreset.outroAssetId }
            : {}),
        }),
      },
    );
    setBusy(false);
    if (!response.ok) {
      setMessage(await responseMessage(response, "剪辑方案生成失败。"));
      return;
    }
    const data = (await response.json()) as Manifest;
    setManifest(data);
    setSelectedClip(0);
    setSelectedClips([]);
    setStep(4);
    setMessage(
      `已生成 ${data.manifest.timeline.filter((clip) => clip.role === "CONTENT" || !clip.role).length} 个镜头。`,
    );
    await refresh();
  };
  const submitOperations = async (
    nextOperations: Array<Record<string, unknown>>,
  ) => {
    if (!manifest || nextOperations.length === 0) return;
    setBusy(true);
    const idempotencyKey =
      editIdempotencyKey || `ui-${globalThis.crypto.randomUUID()}`;
    setEditIdempotencyKey(idempotencyKey);
    const response = await fetch(
      `/api/v1/projects/${projectId}/video/adjustments`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parentManifestId: manifest.id,
          operations: nextOperations,
          createdBy: "operator",
          idempotencyKey,
        }),
      },
    );
    setBusy(false);
    if (!response.ok) {
      setMessage(await responseMessage(response, "镜头调整失败。"));
      return;
    }
    setManifest((await response.json()) as Manifest);
    setOperations([]);
    setSelectedClips([]);
    setEditIdempotencyKey("");
    setMessage("新的剪辑版本已创建。");
    await refresh();
  };
  const createVersion = async () => submitOperations(operations);
  const bulkAdjust = async (type: "REMATCH" | "REROLL") => {
    const next = selectedClips
      .filter(
        (index) =>
          manifest?.manifest.timeline[index]?.role !== "INTRO" &&
          manifest?.manifest.timeline[index]?.role !== "OUTRO",
      )
      .map((clipIndex) => ({ type, clipIndex }));
    await submitOperations(next);
  };
  const renderManifest = async (manifestIdOverride?: string) => {
    const manifestId = manifestIdOverride || manifest?.id;
    if (!manifestId) {
      setMessage("当前没有可渲染的剪辑版本，请返回上一步重试。");
      return;
    }
    setBusy(true);
    const response = await fetch(
      `/api/v1/projects/${projectId}/video/manifests/${manifestId}/render`,
      { method: "POST" },
    );
    setBusy(false);
    setMessage(
      response.ok
        ? "正在生成视频……"
        : await responseMessage(response, "生成成片失败。"),
    );
    setRenderingManifestId(response.ok ? manifestId : null);
    setStep(5);
    await refresh();
  };
  const sendToApproval = async () => {
    if (!snapshot?.currentRender) return;
    const target = snapshot.currentRender;
    const response = await fetch(`/api/v1/projects/${projectId}/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        targetType: "RENDER",
        targetId: target.renderId,
        targetRevisionId: target.outputAssetId,
        status: "PENDING",
        approver: "operator",
        evidence: { source: "video-workflow" },
      }),
    });
    setMessage(
      response.ok
        ? "成片已送往审批。"
        : await responseMessage(response, "提交审批失败。"),
    );
    await refresh();
  };
  const selectDetails = (asset: MediaItem) => {
    setDetailsAsset(asset);
    setTagDraft((asset.tags || []).join("、"));
    setTagInput("");
    setCategoryDraft(asset.category || "");
  };
  const steps = ["文案", "素材", "自动剪辑", "检查镜头", "生成成片"];

  return (
    <main className="shell video-workflow">
      <header>
        <p className="eyebrow">项目</p>
        <h1>视频剪辑</h1>
        <nav className="workflow-steps" aria-label="视频剪辑流程">
          {steps.map((label, index) => (
          <button
            type="button"
            key={label}
            aria-label={`步骤 ${index + 1}`}
              className={
                step === index + 1 ? "active" : step > index + 1 ? "done" : ""
              }
              onClick={() => index + 1 <= step && setStep(index + 1)}
            >
              {index + 1} {label}
            </button>
          ))}
        </nav>
        <nav className="module-nav">
          <Link href={`/projects/${projectId}/assets`}>素材库</Link>
          <Link href={`/projects/${projectId}/director`}>脚本与分镜</Link>
          <Link href={`/projects/${projectId}/approvals`}>审批</Link>
        </nav>
      </header>
      {step === 1 && (
        <section className="workflow-panel">
          <div className="section-title">
            <h2>① 准备文案</h2>
            <span>
              {scriptCount ? `共 ${scriptCount} 句话` : "每句话对应一个镜头"}
            </span>
          </div>
          <label>
            剪辑模板
            <select
              aria-label="剪辑模板"
              value={preset?.id || ""}
              onChange={async (event) => {
                const selected = presets.find(
                  (item) => item.id === event.target.value,
                );
                if (!selected) return;
                const previous = preset;
                const response = await fetch(`/api/v1/projects/${projectId}/video/preset`, {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ presetId: selected.id }),
                });
                if (!response.ok) {
                  applyPresetToUi(previous);
                  setMessage("模板应用失败，请重试。");
                  return;
                }
                applyPresetToUi(selected);
              }}
            >
              <option value="">选择模板</option>
              {presets.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          {preset && (
            <p className="muted">
              已自动应用镜头长度、品牌片头片尾和素材策略。
            </p>
          )}
          <h3>剪辑方式</h3>
          <EditModeSelector mode={mode} onSelect={chooseMode} />
          <fieldset>
            <legend>文案来源</legend>
            <label className="inline-check">
              <input
                type="radio"
                checked={scriptSource === "PROJECT"}
                onChange={() => {
                  setScriptSource("PROJECT");
                  void loadScript();
                }}
              />
              使用当前项目脚本
            </label>
            <label className="inline-check">
              <input
                type="radio"
                checked={scriptSource === "CUSTOM"}
                onChange={() => {
                  setScriptSource("CUSTOM");
                  setScript("");
                }}
              />
              粘贴其他文案
            </label>
          </fieldset>
          {scriptSource === "PROJECT" && scriptInfo ? (
            <p className="status">
              已加载当前项目脚本 · 版本 {scriptInfo.revision} · 已载入{" "}
              {scriptCount} 句话
            </p>
          ) : scriptSource === "PROJECT" ? (
            <p className="muted">当前项目暂无可用脚本。</p>
          ) : (
            <textarea
              aria-label="脚本文案"
              value={script}
              onChange={(event) => setScript(event.target.value)}
              placeholder="粘贴文案，每句话会自动匹配一个画面。"
            />
          )}
          {scriptSource === "PROJECT" && scriptInfo && (
            <textarea
              aria-label="脚本文案"
              value={script}
              onChange={(event) => setScript(event.target.value)}
            />
          )}
          <button
            type="button"
            className="primary-action"
            onClick={() => setStep(2)}
            disabled={!mode || !script.trim()}
          >
            下一步：选择素材
          </button>
        </section>
      )}
      {step === 2 && (
        <section className="workflow-panel">
          <div className="section-title">
            <h2>② 选择素材</h2>
            <span>{indexTotal || mediaAssets.length} 条可用素材 · 已选择 {selectedAssets.length} 条</span>
          </div>
          <p className="muted">项目素材库和本地素材可以混合选择；取消勾选的素材不会参与本次剪辑。</p>
          <div className="media-source-row">
            <label>
              素材文件夹
              <input
                aria-label="素材文件夹"
                value={sourceRoot}
                onChange={(event) => setSourceRoot(event.target.value)}
                placeholder="例如：F:\\素材\\欧洲零售"
              />
            </label>
            <button
              type="button"
              onClick={() => void scanFolder()}
              disabled={busy}
            >
              扫描文件夹
            </button>
          </div>
          {scan && (
            <p className="scan-summary">
              {scan.status === "RUNNING" || scan.status === "QUEUED"
                ? `正在扫描素材……已处理 ${scan.progress.analyzed || 0} / ${scan.progress.discovered || 0}`
                : `扫描完成：共 ${scan.progress.discovered || scan.files.length} 条视频，可用 ${scan.progress.available || scan.files.filter((file) => file.available).length} 条，无法读取 ${scan.progress.unavailable || 0} 条`}
            </p>
          )}
          <div className="media-toolbar">
            <input
              aria-label="搜索素材"
              placeholder="搜索素材"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="方向筛选"
              value={orientation}
              onChange={(event) => setOrientation(event.target.value)}
            >
              <option value="ALL">全部方向</option>
              <option value="VERTICAL">竖屏</option>
              <option value="HORIZONTAL">横屏</option>
              <option value="SQUARE">方形</option>
            </select>
            <select
              aria-label="分类筛选"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              <option value="">全部分类</option>
              <option value="门店">门店</option>
              <option value="商品">商品</option>
              <option value="人物">人物</option>
              <option value="货架">货架</option>
              <option value="数据图表">数据图表</option>
              <option value="其他">其他</option>
            </select>
            <select
              aria-label="使用情况"
              value={usage}
              onChange={(event) => setUsage(event.target.value)}
            >
              <option value="ALL">全部使用情况</option>
              <option value="UNUSED">从未使用</option>
              <option value="RECENT">最近少用</option>
              <option value="FREQUENT">高频使用</option>
            </select>
            <select
              aria-label="排序"
              value={sort}
              onChange={(event) => setSort(event.target.value)}
            >
              <option value="RECOMMENDED">推荐</option>
              <option value="NEWEST">最近新增</option>
              <option value="LEAST_USED">最少使用</option>
              <option value="MOST_RECENT">最近使用</option>
              <option value="DURATION">时长</option>
            </select>
          </div>
          <MediaBrowser
            assets={mediaAssets}
            selected={selectedAssets}
            onToggle={toggleAsset}
            onEdit={selectDetails}
          />
          <div className="media-pagination" aria-label="素材分页">
            <button
              type="button"
              onClick={() => setMediaPage((page) => Math.max(1, page - 1))}
              disabled={mediaPage <= 1}
            >
              上一页
            </button>
            <span>第 {mediaPage} 页 · 共 {indexTotal} 条</span>
            <button
              type="button"
              onClick={() => setMediaPage((page) => page + 1)}
              disabled={!mediaHasNext}
            >
              下一页
            </button>
          </div>
          <details>
            <summary>高级设置：品牌包装</summary>
            <p className="muted">片头和片尾会使用同一个素材浏览器选择，默认来自当前模板。</p>
            <p>片头</p>
            <MediaBrowser assets={mediaAssets} selected={introAssetId ? [introAssetId] : []} onToggle={(id) => setIntroAssetId((current) => current === id ? "" : id)} />
            <p>片尾</p>
            <MediaBrowser assets={mediaAssets} selected={outroAssetId ? [outroAssetId] : []} onToggle={(id) => setOutroAssetId((current) => current === id ? "" : id)} />
          </details>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={preferUnused}
              onChange={(event) => setPreferUnused(event.target.checked)}
            />
            优先使用近期没出现过的素材
          </label>
          <p className="muted">系统会尽量避开最近视频中已经使用过的素材。</p>
          <button
            type="button"
            className="primary-action"
            onClick={() => setStep(3)}
            disabled={selectedAssets.length === 0}
          >
            下一步：自动剪辑
          </button>
        </section>
      )}
      {step === 3 && (
        <section className="workflow-panel">
          <div className="section-title">
            <h2>③ 自动剪辑</h2>
            <span>准备开始自动剪辑</span>
          </div>
          <p className="workflow-summary">
            {scriptCount || 0} 句话 · {indexTotal || mediaAssets.length}{" "}
            条可用素材 · 模板：{preset?.name || "默认短视频"}
          </p>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={preferUnused}
              onChange={(event) => setPreferUnused(event.target.checked)}
            />
            优先使用近期未出现过的素材
          </label>
          {busy ? (
            <p className="status">正在生成剪辑方案……</p>
          ) : (
            <button
              type="button"
              className="primary-action"
              onClick={() => void createPlan()}
              disabled={!mode || !script.trim() || selectedAssets.length === 0}
            >
              开始自动剪辑
            </button>
          )}
        </section>
      )}
      {step === 4 && <ReviewStep manifest={manifest} visibleClipIndexes={visibleClipIndexes} reviewCount={reviewCount} manualCount={manualCount} reviewFilter={reviewFilter} setReviewFilter={setReviewFilter} selectedClips={selectedClips} setSelectedClips={setSelectedClips} currentClip={currentClip} selectedClip={selectedClip} setSelectedClip={setSelectedClip} clipSource={clipSource} mediaAssets={mediaAssets} busy={busy} mode={manifest?.manifest.metadata?.editMode || mode || "RANDOM"} operations={operations} setOperations={setOperations} onBulk={(type) => void bulkAdjust(type)} onSave={() => void createVersion()} onNext={() => setStep(5)} history={manifestHistory} onRegenerate={() => void createPlan()} thumbnailFor={clipThumbnail} onModeChange={chooseMode} />}
      {step === 5 && <OutputStep projectId={projectId} manifest={manifest ? { id: manifest.id, manifest: manifest.manifest } : null} snapshot={snapshot ? { currentRender: snapshot.currentRender, job: snapshot.job } : null} introName={mediaAssets.find((asset) => asset.id === introAssetId)?.originalName || ""} outroName={mediaAssets.find((asset) => asset.id === outroAssetId)?.originalName || ""} busy={busy} jobRunning={jobRunning || Boolean(renderingManifestId)} onRender={() => void renderManifest(manifest?.id)} onBack={() => setStep(4)} onApproval={() => void sendToApproval()} />}
      {message && <p className="status">{message}</p>}
      {detailsAsset && (
        <aside className="media-details" aria-label="素材信息">
          <h3>素材信息</h3>
          <p>{detailsAsset.originalName}</p>
          <label>
            分类
            <select
              value={categoryDraft}
              onChange={(event) => setCategoryDraft(event.target.value)}
            >
              <option value="">未分类</option>
              <option value="门店">门店</option>
              <option value="商品">商品</option>
              <option value="人物">人物</option>
              <option value="货架">货架</option>
              <option value="数据图表">数据图表</option>
              <option value="其他">其他</option>
            </select>
          </label>
          <label>
            标签
            <span className="tag-chip-list">
              {tagDraft.split(/[、,，\n]/u).map((tag) => tag.trim()).filter(Boolean).map((tag) => (
                <button type="button" className="tag-chip" key={tag} onClick={() => setTagDraft((current) => current.split(/[、,，\n]/u).map((item) => item.trim()).filter((item) => item && item !== tag).join("、"))}>{tag} ×</button>
              ))}
            </span>
            <input
              aria-label="添加标签"
              value={tagInput}
              onChange={(event) => setTagInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter" && tagInput.trim()) { event.preventDefault(); setTagDraft((current) => [...current.split(/[、,，\n]/u).map((item) => item.trim()).filter(Boolean), tagInput.trim()].filter((item, index, all) => all.indexOf(item) === index).join("、")); setTagInput(""); } }}
              placeholder="输入标签后按 Enter"
            />
          </label>
          <p className="muted">使用次数：{detailsAsset.usageCount || 0} 次</p>
          <button type="button" onClick={() => void saveMediaDetails()}>
            保存
          </button>
          <button type="button" onClick={() => setDetailsAsset(null)}>
            取消
          </button>
        </aside>
      )}
    </main>
  );
}
