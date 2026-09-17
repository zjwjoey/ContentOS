"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipInspector } from "../../../../components/video/clip-inspector";
import { ClipPreview } from "../../../../components/video/clip-preview";
import {
  EditModeSelector,
  type EditMode,
} from "../../../../components/video/edit-mode-selector";
import { MediaBrowser } from "../../../../components/video/media-browser";

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
};
type ApiError = { error?: { message?: string } };
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
function clock(value: number): string {
  const total = Math.max(0, value) / 1000;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${(total % 60).toFixed(1).padStart(4, "0")}`;
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
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [selectedClip, setSelectedClip] = useState<number | null>(null);
  const [selectedClips, setSelectedClips] = useState<number[]>([]);
  const [operations, setOperations] = useState<Array<Record<string, unknown>>>(
    [],
  );
  const [sourceRoot, setSourceRoot] = useState("");
  const [recursive, setRecursive] = useState(true);
  const [scan, setScan] = useState<Scan | null>(null);
  const [indexedMedia, setIndexedMedia] = useState<MediaItem[]>([]);
  const [indexTotal, setIndexTotal] = useState(0);
  const [selectedAssets, setSelectedAssets] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [orientation, setOrientation] = useState("ALL");
  const [category, setCategory] = useState("");
  const [usage, setUsage] = useState("ALL");
  const [sort, setSort] = useState("RECOMMENDED");
  const [detailsAsset, setDetailsAsset] = useState<MediaItem | null>(null);
  const [tagDraft, setTagDraft] = useState("");
  const [categoryDraft, setCategoryDraft] = useState("");
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preset, setPreset] = useState<Preset | null>(null);
  const [preferUnused, setPreferUnused] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [seed, setSeed] = useState(1);
  const [editIdempotencyKey, setEditIdempotencyKey] = useState("");

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
      setPreset(data.preset);
      if (data.preset) {
        setMode(data.preset.editModeDefault);
        setPreferUnused(data.preset.preferUnusedMedia);
      }
    }
  }, [projectId]);
  const loadIndex = useCallback(async () => {
    if (!scan?.sourceRootId) return;
    const params = new URLSearchParams({
      projectId,
      page: "1",
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
  }, [
    category,
    orientation,
    projectId,
    query,
    scan?.sourceRootId,
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
          thumbnailStatus: "PENDING",
        })),
    [snapshot],
  );
  const mediaAssets =
    scan?.status === "SUCCEEDED" ? indexedMedia : projectMedia;
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
              setIndexedMedia(next.files.filter((file) => file.available).map((file) => ({ id: `${next.sourceRootId}:${file.relativePath}`, originalName: file.fileName, durationMs: file.durationMs, width: file.width, height: file.height, orientation: file.orientation, tags: file.tags, category: file.category, usageCount: file.usageCount, lastUsedAt: file.lastUsedAt, thumbnailStatus: file.thumbnailStatus || "PENDING", thumbnailUrl: `/api/v1/video/local-media/thumbnails/${encodeURIComponent(`${next.sourceRootId}:${file.relativePath}`)}?projectId=${encodeURIComponent(projectId)}` })));
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
    const tags = tagDraft
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
          ...(scan?.status === "SUCCEEDED"
            ? { scanId: scan.id }
            : { videoAssetIds: selectedAssets }),
          ...(selectedPreset?.introAssetId
            ? { introAssetId: selectedPreset.introAssetId }
            : {}),
          ...(selectedPreset?.outroAssetId
            ? { outroAssetId: selectedPreset.outroAssetId }
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
  const renderManifest = async () => {
    if (!manifest) return;
    setBusy(true);
    const response = await fetch(
      `/api/v1/projects/${projectId}/video/manifests/${manifest.id}/render`,
      { method: "POST" },
    );
    setBusy(false);
    setMessage(
      response.ok
        ? "正在生成视频……"
        : await responseMessage(response, "生成成片失败。"),
    );
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
    setCategoryDraft(asset.category || "");
  };
  const steps = ["文案", "素材", "自动剪辑", "检查镜头", "生成成片"];

  return (
    <main className="shell video-workflow">
      <header>
        <p className="eyebrow">项目 / {projectId}</p>
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
                setPreset(selected);
                setMode(selected.editModeDefault);
                setPreferUnused(selected.preferUnusedMedia);
                await fetch(`/api/v1/projects/${projectId}/video/preset`, {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ presetId: selected.id }),
                });
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
          {mode && (
            <div className="compat-source-panel">
              <label>
                素材文件夹
                <input
                  aria-label="素材文件夹"
                  value={sourceRoot}
                  onChange={(event) => {
                    setSourceRoot(event.target.value);
                    setScan(null);
                  }}
                  placeholder="输入已授权的本地文件夹路径"
                />
              </label>
              <button
                type="button"
                onClick={() => void scanFolder()}
                disabled={busy}
              >
                扫描文件夹
              </button>
              {scan?.status === "SUCCEEDED" && (
                <button
                  type="button"
                  onClick={() => void createPlan()}
                  disabled={busy || !script.trim()}
                >
                  生成剪辑方案
                </button>
              )}
            </div>
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
            <span>{indexTotal || mediaAssets.length} 条可用素材</span>
          </div>
          <div className="source-choice">
            <button
              type="button"
              className={!scan ? "selected" : ""}
              onClick={() => setScan(null)}
            >
              项目素材库
            </button>
            <button
              type="button"
              className={scan ? "selected" : ""}
              onClick={() => setSourceRoot(sourceRoot)}
            >
              本地素材文件夹
            </button>
          </div>
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
          {scan?.status === "SUCCEEDED" && (
            <button type="button" onClick={() => void createPlan()} disabled={busy || !script.trim()}>
              生成剪辑方案
            </button>
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
            disabled={mediaAssets.length === 0}
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
              disabled={!mode || !script.trim() || mediaAssets.length === 0}
            >
              开始自动剪辑
            </button>
          )}
        </section>
      )}
      {step === 4 && (
        <section className="workflow-panel review-panel">
          <div className="section-title">
            <h2>④ 检查镜头</h2>
            <span>
              {manifest?.manifest.timeline.length || 0} 个镜头 · {reviewCount}{" "}
              个建议检查
            </span>
          </div>
          <div className="review-toolbar">
            <button
              type="button"
              onClick={() =>
                setSelectedClips(
                  manifest?.manifest.timeline.map((_, index) => index) || [],
                )
              }
            >
              全部
            </button>
            <button
              type="button"
              onClick={() =>
                setSelectedClips(
                  manifest?.manifest.timeline
                    .map((clip, index) =>
                      clip.reviewStatus === "REVIEW" || clip.matching?.fallback
                        ? index
                        : -1,
                    )
                    .filter((index) => index >= 0),
                )
              }
            >
              只看建议检查
            </button>
            <button type="button" onClick={() => setSelectedClips([])}>
              取消选择
            </button>
            {selectedClips.length > 0 && (
              <>
                <span>已选择 {selectedClips.length} 个镜头</span>
                <button
                  type="button"
                  onClick={() => void bulkAdjust("REMATCH")}
                >
                  重新匹配
                </button>
                <button type="button" onClick={() => void bulkAdjust("REROLL")}>
                  随机换素材
                </button>
              </>
            )}
          </div>
          {manifest && (
            <div className="review-list sentence-list">
              {manifest.manifest.timeline.map((clip, index) => (
                <label
                  className={`review-row${selectedClips.includes(index) ? " selected" : ""}`}
                  key={`${clip.assetId}-${index}`}
                >
                  <input
                    type="checkbox"
                    checked={selectedClips.includes(index)}
                    onChange={() =>
                      setSelectedClips((current) =>
                        current.includes(index)
                          ? current.filter((item) => item !== index)
                          : [...current, index],
                      )
                    }
                  />
                  <span className="review-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="review-thumb">
                    {clip.role === "INTRO"
                      ? "片头"
                      : clip.role === "OUTRO"
                        ? "片尾"
                        : "镜头"}
                  </span>
                  <span>
                    <strong>
                      {clip.role === "INTRO"
                        ? "片头"
                        : clip.role === "OUTRO"
                          ? "片尾"
                          : clip.sentenceText || "正文镜头"}
                    </strong>
                    <small>
                      {clip.reviewStatus === "MANUAL"
                        ? "人工修改"
                        : clip.reviewStatus === "REVIEW" ||
                            clip.matching?.fallback
                          ? "建议检查"
                          : "良好"}{" "}
                      · {clock(clip.durationMs)}
                    </small>
                  </span>
                  <button type="button" className="review-row-button" onClick={() => setSelectedClip(index)}>
                    选择镜头
                  </button>
                </label>
              ))}
            </div>
          )}
          {currentClip ? (
            <div className="current-clip">
              <h3>当前镜头预览</h3>
              <ClipPreview
                src={clipSource}
                sourceInMs={currentClip.sourceInMs}
                durationMs={currentClip.durationMs}
                label={currentClip.assetId}
              />
              <p className="muted">
                文案：{currentClip.sentenceText || "品牌包装"} · 素材：
                {currentClip.assetId}
              </p>
              <ClipInspector
                clip={currentClip}
                index={selectedClip}
                clipCount={manifest?.manifest.timeline.length || 0}
                replacementAssets={mediaAssets}
                mode={manifest?.manifest.metadata?.editMode || mode || "RANDOM"}
                editable={manifest?.status !== "SUPERSEDED"}
                busy={busy}
                onOperation={(operation) =>
                  setOperations((current) => [...current, operation])
                }
              />
            </div>
          ) : (
            <p className="muted">选择镜头查看预览。</p>
          )}
          {operations.length > 0 && (
            <p className="status">待提交调整：{operations.length} 项</p>
          )}
          <div className="review-actions">
            <button
              type="button"
              onClick={() => void createVersion()}
              disabled={busy || operations.length === 0}
            >
              保存镜头调整
            </button>
            {operations.length > 0 && (
              <button type="button" onClick={() => void createVersion()} disabled={busy}>
                生成剪辑版本
              </button>
            )}
            <button
              type="button"
              className="primary-action"
              onClick={() => setStep(5)}
              disabled={!manifest || operations.length > 0}
            >
              下一步：生成成片
            </button>
          </div>
          <p className="muted">当前剪辑版本 v{manifest?.revision || 1}</p>
          <details open>
            <summary>切换剪辑方式</summary>
            <EditModeSelector mode={mode} onSelect={chooseMode} />
            <button
              type="button"
              onClick={() => void createPlan()}
              disabled={!mode || !script.trim() || mediaAssets.length === 0}
            >
              生成剪辑方案
            </button>
          </details>
        </section>
      )}
      {step === 5 && (
        <section className="workflow-panel output-panel card">
          <div className="section-title">
            <h2>⑤ 生成成片</h2>
            <span>
              {snapshot?.currentRender ? "视频生成完成" : "剪辑已准备好"}
            </span>
          </div>
          <h3>成片预览</h3>
          <p>
            {manifest?.manifest.timeline.filter(
              (clip) => clip.role === "CONTENT" || !clip.role,
            ).length || 0}{" "}
            个正文镜头 · 预计时长{" "}
            {clock(
              (manifest?.manifest.timeline || []).reduce(
                (total, clip) =>
                  total +
                  (clip.timelineEndMs && clip.timelineStartMs !== undefined
                    ? Math.max(
                        clip.durationMs,
                        clip.timelineEndMs - clip.timelineStartMs,
                      )
                    : clip.durationMs),
                0,
              ),
            )}
          </p>
          {snapshot?.currentRender ? (
            <>
              <video
                controls
                preload="metadata"
                src={`/api/v1/projects/${projectId}/assets/${snapshot.currentRender.outputAssetId}/content`}
              />
              <div className="output-actions">
                <button type="button" onClick={() => setStep(4)}>
                  返回调整镜头
                </button>
                <button type="button" onClick={() => void sendToApproval()}>
                  送往审批
                </button>
              </div>
            </>
          ) : (
            <>
              <video controls preload="metadata" src={clipSource} />
              <button
                type="button"
                className="primary-action"
                onClick={() => void renderManifest()}
                disabled={busy || !manifest || jobRunning}
              >
                生成成片
              </button>
              {jobRunning && <p className="status">正在生成视频……</p>}
            </>
          )}
        </section>
      )}
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
            标签（用逗号或换行分隔）
            <input
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              placeholder="Action，门店，外景"
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
