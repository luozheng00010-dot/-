/** 自动剪辑模块的数据契约，字段与后端 /api/video/* 接口一一对应。 */

export interface VideoCategory {
    id: string;
    name: string;
    isSystem: boolean;
    sortOrder: number;
}

export type VideoBatchStatus = "processing" | "done" | "partial" | "failed";

export interface VideoIngestBatch {
    id: string;
    sku: string;
    categoryId: string;
    totalCount: number;
    doneCount: number;
    failedCount: number;
    status: VideoBatchStatus;
}

export interface VideoFailedMaterial {
    id: string;
    fileName: string;
    tagError: string | null;
}

export interface VideoIngestBatchDetail extends VideoIngestBatch {
    failedMaterials: VideoFailedMaterial[];
}

export type VideoTagStatus = "pending" | "processing" | "done" | "failed";

/** 货号（一等数据，先建后用）；"通用"是哨兵值，不出现在货号列表里 */
export interface VideoSku {
    id: string;
    name: string;
    materialCount: number;
    createdAt: string;
}

export interface VideoMaterial {
    id: string;
    sku: string;
    categoryId: string;
    categoryName: string;
    fileName: string;
    duration: number;
    width: number | null;
    height: number | null;
    tagStatus: VideoTagStatus;
    tagError: string | null;
    description: string | null;
    shotType: string | null;
    motion: string | null;
    productVisible: boolean | null;
    reviewStatus: "none" | "warn_confirmed" | "corrected";
    status: "active" | "archived";
    createdAt: string;
    mediaFileId: string;
    thumbnailMediaId: string | null;
}

export interface VideoMaterialListQuery {
    sku?: string;
    categoryId?: string;
    tagStatus?: VideoTagStatus | "";
    productVisible?: boolean;
    keyword?: string;
    ids?: string[];
    status?: "active" | "archived";
    page?: number;
    pageSize?: number;
}

/** 拆句结果（VideoScript.sentences 的元素）；tts* 是 F2 生成旁白后回填的可选字段（未生成时不存在） */
export interface SentencePlan {
    sentenceId: number;
    text: string;
    needCategory: string;
    durationHint: number;
    visualNote: string;
    ttsMediaId?: string | null;
    ttsDuration?: number | null;
    textDurationHint?: number;
}

export interface VideoScript {
    id: string;
    title: string;
    sku: string;
    rawText: string;
    sentences: SentencePlan[] | null;
    status: "draft" | "split" | "matched";
}

/** 时间线内的一段素材引用 */
export interface TimelineSegment {
    materialId: string;
    inPoint: number;
    outPoint: number;
    reason: string;
}

/** 时间线单元：一句 → N 段素材顺序拼接 */
export interface TimelineItem {
    sentenceId: number;
    subtitle: string;
    needCategory: string;
    duration: number;
    downgraded: boolean;
    segments: TimelineSegment[];
}

export interface GapItem {
    sentenceId: number;
    kind: "no_candidate" | "insufficient";
    needCategory: string;
    detail: string;
    missingSeconds: number;
}

export interface GapReport {
    items: GapItem[];
}

export interface VideoTimeline {
    id: string;
    scriptId: string;
    version: number;
    items: TimelineItem[];
    gapReport: GapReport | null;
    status: "matched" | "edited" | "exporting" | "exported" | "failed";
}

/** 管理设置（VideoSetting id="default"），字段与后端 /api/video/admin/settings 一致 */
export interface VideoSettings {
    chatChannelId: string | null;
    chatModel: string | null;
    visionChannelId: string | null;
    visionModel: string | null;
}

export interface VideoChannelOption {
    id: string;
    name: string;
    apiFormat: string;
    models: string[];
}

export type VideoExportStatus = "queued" | "running" | "succeeded" | "failed";

export interface VideoExportTask {
    id: string;
    timelineId: string;
    status: VideoExportStatus;
    progress: number;
    error: string | null;
    outputMediaId: string | null;
    createdAt: string;
    finishedAt: string | null;
}
