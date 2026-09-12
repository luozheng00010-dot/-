import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Group, Video } from "lucide-react";
import { saveAs } from "file-saver";

import { requestEdit, requestGeneration, requestImageQuestion } from "@/services/api/image";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { requestVideoGeneration, storeGeneratedVideo } from "@/services/api/video";
import { defaultConfig, resolveModelRequestConfig, useConfigStore, useEffectiveConfig, type AiConfig } from "@/stores/use-config-store";
import { ensureUploadedImage, imageThumbnailUrl, imageToDataUrl, uploadImage } from "@/services/image-storage";
import { findImageGenerationTask, getImageGenerationTask, listImageGenerationTasks, waitForImageGenerationTask, type ImageGenerationTask } from "@/services/image-generation-tasks";
import { releaseCanvasEditLease } from "@/services/canvas-edit-lease";
import { uploadMediaFile } from "@/services/file-storage";
import { nanoid } from "nanoid";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, splitDataUrl, upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { fitImageNodeInitialSize, fitNodeSize, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { App, Button, Modal } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { ActiveConnectionPath, ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasCompetitorReplicationDialog } from "@/components/canvas/canvas-competitor-replication-dialog";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasNodeAngleDialog, type CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { CanvasNodeSplitDialog, type CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { buildNodeGenerationContext, buildNodeGenerationInputs, buildNodeResponseMessages, hydrateNodeGenerationContext, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-hover-toolbar";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { AssetPickerModal, CanvasProductPickerModal, type InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasSidePanel } from "@/components/canvas/canvas-side-panel";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { useAgentStore } from "@/stores/use-agent-store";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAgentBridge } from "@/pages/canvas/hooks/use-agent-bridge";
import { usePluginHost } from "@/pages/canvas/hooks/use-plugin-host";
import { buildNodeMentionReferences, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import {
    buildCompetitorAnalysisMessages,
    buildCompetitorGenerationPrompt,
    formatCompetitorVisualAnalysis,
    parseCompetitorVisualAnalysis,
    sourceImageRatio,
    type CompetitorReplicationDialogValue,
} from "@/lib/canvas/competitor-visual-replication";
import { applyNodeConfigPatch, audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, createCanvasNode, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { findContainingGroupId, findGroupDropTarget, getConnectionTargetAnchor, isHiddenBatchChild, isHiddenBatchConnectionEndpoint, normalizeConnection, snapNodesIntoGroup } from "@/lib/canvas/canvas-node-geometry";
import {
    audioExtension,
    buildAngleLabel,
    buildAnglePrompt,
    buildGenerationConfig,
    findRetrySourceNode,
    generationReferenceUrls,
    getGenerationCount,
    getInputSummary,
    hydrateAssistantImages,
    hydrateCanvasImages,
    imageExtension,
    isAudioFile,
    isGenerationCanceled,
    resetInterruptedGeneration,
    resolveMetadataReferences,
    sourceNodeReferenceImages,
} from "@/lib/canvas/canvas-generation-helpers";
import { getNodeDefinition, isBuiltinNodeType as isBuiltinType, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { CanvasPluginManagerModal } from "@/components/canvas/canvas-plugin-manager-modal";
import { CanvasRefreshShell } from "@/components/canvas/canvas-refresh-shell";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { ConnectionCreateMenu, NodeCreateMenu, type PendingConnectionCreate } from "@/components/canvas/canvas-create-menus";
import {
    CanvasNodeType,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "@/types/canvas";
import type { DetailPageProject } from "@/types/detail-page";
import { getDetailPageProject } from "@/services/detail-pages";
import type { MainImageProject } from "@/types/main-image-replication";
import { getMainImageReplicationProject } from "@/services/main-image-replications";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";

// 内置节点注册到统一注册表(模块加载时执行一次)
registerBuiltinNodes();

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type CanvasDetailPageMedia = {
    id?: string;
    mediaId?: string;
    url?: string;
    thumbnailUrl?: string;
    storageKey?: string;
    width?: number;
    height?: number;
};

type CanvasDetailPagePair = {
    id: string;
    sortOrder: number;
    referenceImage?: CanvasDetailPageMedia;
    resultImage?: CanvasDetailPageMedia;
    referenceWidth?: number;
    referenceHeight?: number;
    prompt?: string;
    resolvedPrompt?: string;
    status?: "draft" | "queued" | "running" | "succeeded" | "failed" | "interrupted";
    activeTaskId?: string;
    error?: string;
};

type CanvasDetailPageProject = DetailPageProject & {
    pairs?: CanvasDetailPagePair[];
    productMediaId?: string;
    productMedia?: CanvasDetailPageMedia;
};

type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

const VIDEO_NODE_MAX_WIDTH = 420;
const VIDEO_NODE_MAX_HEIGHT = 420;
// 稳定的空引用数组:避免每次渲染 `... || []` 产生新数组引用而击穿 CanvasNode 的 React.memo
const EMPTY_REFERENCES: CanvasResourceReference[] = [];
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;
const IMAGE_PROMPT_REVERSE_PRESET = `请根据参考图片反推一段适合用于 AI 生图的提示词。

要求：
1. 只输出提示词正文，不要解释。
2. 覆盖主体、构图、风格、光线、色彩、材质、镜头和氛围。
3. 尽量写成可直接用于生图模型的完整提示词。`;

function mediaStorageSignature(value: unknown) {
    const keys: string[] = [];
    const visit = (item: unknown) => {
        if (!item || typeof item !== "object") return;
        if ("storageKey" in item && typeof item.storageKey === "string" && item.storageKey.startsWith("media:")) keys.push(item.storageKey);
        if ("generationTaskId" in item && typeof item.generationTaskId === "string") keys.push(`task:${item.generationTaskId}`);
        if ("generationClientRequestId" in item && typeof item.generationClientRequestId === "string") keys.push(`client:${item.generationClientRequestId}`);
        if ("generationTaskId" in item && typeof item.generationTaskId === "string" && "status" in item && typeof item.status === "string") keys.push(`task-status:${item.generationTaskId}:${item.status}`);
        Object.values(item).forEach((child) => Array.isArray(child) ? child.forEach(visit) : visit(child));
    };
    visit(value);
    return keys.sort().join("|");
}

function applyCanvasImageTask(nodes: CanvasNodeData[], task: ImageGenerationTask) {
    return nodes.map((node) => {
        if (node.metadata?.generationTaskId !== task.id) return node;
        if (node.metadata.generationSlot == null) {
            const failed = task.status === "failed" || task.status === "cancelled";
            return { ...node, metadata: { ...node.metadata, status: failed ? NODE_STATUS_ERROR : task.status === "queued" || task.status === "running" ? NODE_STATUS_LOADING : NODE_STATUS_SUCCESS, errorDetails: failed ? task.error || "生成失败" : undefined } };
        }
        const result = task.results.find((item) => item.index === node.metadata?.generationSlot);
        if (result?.status === "succeeded" && result.image) {
            const size = fitNodeSize(result.image.width, result.image.height, NODE_DEFAULT_SIZE[CanvasNodeType.Image].width, NODE_DEFAULT_SIZE[CanvasNodeType.Image].height);
            const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
            return { ...node, position: { x: center.x - size.width / 2, y: center.y - size.height / 2 }, width: size.width, height: size.height, metadata: { ...node.metadata, ...imageMetadata({ ...result.image, url: result.image.url || result.image.dataUrl }), generationTaskId: task.id, generationSlot: result.index } };
        }
        if (result?.status === "failed") return { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: result.error || task.error || "生成失败" } };
        return { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } };
    });
}

function bindCanvasImageTask(nodes: CanvasNodeData[], task: ImageGenerationTask) {
    const bindings = task.context?.bindings || [];
    return nodes.map((node) => {
        const binding = bindings.find((item) => item.nodeId === node.id);
        const matches = node.metadata?.generationTaskId === task.id || node.metadata?.generationClientRequestId === task.clientRequestId || Boolean(binding);
        if (!matches) return node;
        return {
            ...node,
            metadata: {
                ...node.metadata,
                generationTaskId: task.id,
                generationClientRequestId: task.clientRequestId,
                ...(binding?.slot == null ? {} : { generationSlot: binding.slot }),
            },
        };
    });
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell />;

    return <InfiniteCanvasPage />;
}

function InfiniteCanvasPage() {
    const { message, modal } = App.useApp();
    // 订阅节点注册表版本,插件动态注册/卸载后驱动画布重渲染
    const nodeRegistryVersion = useNodeRegistryVersion((state) => state.version);
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const projectId = params.id || "";
    const openAgentPanel = useAgentStore((state) => state.openPanel);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const projectLoadAttemptRef = useRef("");
    const lastMediaSignatureRef = useRef("");
    const skipNextProjectSaveRef = useRef(true);
    const skipNextViewportSaveRef = useRef(true);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const didInitialCenterRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        initialSelectedNodes: { id: string; x: number; y: number }[];
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: [],
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const addAsset = useAssetStore((state) => state.addAsset);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const createProject = useCanvasStore((state) => state.createProject);
    const openProject = useCanvasStore((state) => state.openProject);
    const loadProject = useCanvasStore((state) => state.loadProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const flushProject = useCanvasStore((state) => state.flushProject);
    const acquireEditLease = useCanvasStore((state) => state.acquireEditLease);
    const heartbeatEditLease = useCanvasStore((state) => state.heartbeatEditLease);
    const checkProjectRevision = useCanvasStore((state) => state.checkProjectRevision);
    const leaseState = useCanvasStore((state) => state.leaseStates[projectId]);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const deleteProjects = useCanvasStore((state) => state.deleteProjects);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const saveStatus = useCanvasStore((state) => state.saveStates[projectId]?.status || "idle");
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const leaseHeld = currentProject?.accessLevel === "edit" && leaseState?.status === "held";
    const readOnly = currentProject?.accessLevel === "view" || (currentProject?.accessLevel === "edit" && !leaseHeld);
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [assetPickerOpen, setAssetPickerOpen] = useState(false);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [projectReloadVersion, setProjectReloadVersion] = useState(0);
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
    const [editRequestNonce, setEditRequestNonce] = useState(0);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [competitorReplicationNodeId, setCompetitorReplicationNodeId] = useState<string | null>(null);
    const [detailPageSourceNodeId, setDetailPageSourceNodeId] = useState<string | null>(null);
    const [mainImageSourceNodeId, setMainImageSourceNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [collapsingBatchIds, setCollapsingBatchIds] = useState<Set<string>>(new Set());
    const [openingBatchIds, setOpeningBatchIds] = useState<Set<string>>(new Set());
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const focusAnimRef = useRef<number | null>(null);
    const generateNodeRef = useRef<((nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => Promise<void>) | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef(selectionBox);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const leaseAttemptRef = useRef("");

    const imageTaskOptions = useCallback((bindings: Array<{ nodeId: string; slot?: number }>, signal?: AbortSignal, clientRequestId = nanoid(), context?: Record<string, unknown>) => {
        return {
            signal,
            clientRequestId,
            ownerId: currentProject?.ownerId,
            context: { ...context, origin: "canvas", canvasId: projectId, bindings },
            onTaskUpdate: (task: ImageGenerationTask) => setNodes((current) => applyCanvasImageTask(current.map((node) => {
                const binding = bindings.find((item) => item.nodeId === node.id);
                return binding ? { ...node, metadata: { ...node.metadata, generationTaskId: task.id, generationClientRequestId: clientRequestId, ...(binding.slot == null ? {} : { generationSlot: binding.slot }) } } : node;
            }), task)),
        };
    }, [currentProject?.ownerId, projectId]);

    const prepareImageTask = useCallback(async (bindings: Array<{ nodeId: string; slot?: number }>, clientRequestId: string, baseNodes = nodesRef.current, baseConnections = connectionsRef.current) => {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        const nextNodes = baseNodes.map((node) => {
            const binding = bindings.find((item) => item.nodeId === node.id);
            return binding ? { ...node, metadata: { ...node.metadata, generationClientRequestId: clientRequestId, ...(binding.slot == null ? {} : { generationSlot: binding.slot }) } } : node;
        });
        nodesRef.current = nextNodes;
        connectionsRef.current = baseConnections;
        skipNextProjectSaveRef.current = true;
        setNodes(nextNodes);
        updateProject(projectId, { nodes: nextNodes, connections: baseConnections });
        return flushProject(projectId);
    }, [flushProject, projectId, updateProject]);

    const prepareImageRequestOptions = useCallback(async (generationConfig: AiConfig, bindings: Array<{ nodeId: string; slot?: number }>, signal?: AbortSignal, context?: Record<string, unknown>) => {
        if (resolveModelRequestConfig(generationConfig, generationConfig.model).source !== "remote") return { signal };
        const clientRequestId = nanoid();
        if (!await prepareImageTask(bindings, clientRequestId)) throw new Error("任务标识尚未保存，暂时无法提交生图任务");
        return imageTaskOptions(bindings, signal, clientRequestId, context);
    }, [imageTaskOptions, prepareImageTask]);

    const saveCanvasSnapshot = useCallback(async (nextNodes: CanvasNodeData[], nextConnections: CanvasConnection[]) => {
        nodesRef.current = nextNodes;
        connectionsRef.current = nextConnections;
        skipNextProjectSaveRef.current = true;
        setNodes(nextNodes);
        setConnections(nextConnections);
        updateProject(projectId, { nodes: nextNodes, connections: nextConnections });
        return flushProject(projectId);
    }, [flushProject, projectId, updateProject]);

    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
        }),
        [activeChatId, backgroundMode, chatSessions, showImageInfo],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) generationRequestsRef.current.delete(targetNodeId);
    }, []);

    const stopGenerationByRunningId = useCallback((runningId: string) => {
        const affectedNodeIds = new Set<string>();
        generationRequestsRef.current.forEach((request) => {
            if (request.runningNodeId !== runningId) return;
            request.controller.abort();
            generationRequestsRef.current.delete(request.targetNodeId);
            affectedNodeIds.add(request.targetNodeId);
            affectedNodeIds.add(request.originNodeId);
        });
        setRunningNodeId((current) => (current === runningId ? null : current));
        if (!affectedNodeIds.size) return;
        setNodes((prev) => prev.map((node) => (affectedNodeIds.has(node.id) && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
    }, []);

    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            modal.confirm({
                title: "停止生成？",
                content: "当前生成请求会被中断，已经生成完成的内容会保留。",
                okText: "停止",
                cancelText: "继续生成",
                okButtonProps: { danger: true },
                onOk: () => stopGenerationByRunningId(nodeId),
            });
        },
        [modal, stopGenerationByRunningId],
    );

    useEffect(() => {
        if (!projectId || openProject(projectId) || projectLoadAttemptRef.current === projectId) return;
        projectLoadAttemptRef.current = projectId;
        void loadProject(projectId).then((project) => {
            if (project) return;
            message.error("画布读取失败或没有访问权限");
            navigate("/canvas", { replace: true });
        });
    }, [loadProject, message, navigate, openProject, projectId]);

    useEffect(() => {
        if (!currentProject || currentProject.accessLevel !== "edit" || leaseAttemptRef.current === projectId) return;
        leaseAttemptRef.current = projectId;
        void acquireEditLease(projectId);
        return () => {
            if (leaseAttemptRef.current === projectId) leaseAttemptRef.current = "";
        };
    }, [acquireEditLease, currentProject?.accessLevel, currentProject?.id, projectId]);

    useEffect(() => {
        if (!projectLoaded || currentProject?.accessLevel !== "edit" || leaseState?.status !== "held") return;
        const timer = window.setInterval(() => void heartbeatEditLease(projectId), 10_000);
        return () => window.clearInterval(timer);
    }, [currentProject?.accessLevel, heartbeatEditLease, leaseState?.status, projectId, projectLoaded]);

    useEffect(() => {
        if (!projectLoaded || !readOnly) return;
        let disposed = false;
        const refresh = async () => {
            const revision = await checkProjectRevision(projectId);
            if (disposed || !revision) return;
            const current = useCanvasStore.getState();
            const local = current.projects.find((item) => item.id === projectId);
            const status = current.saveStates[projectId]?.status;
            if (!local || revision.revision === local.revision || ["dirty", "saving", "error", "conflict"].includes(status || "")) return;
            const refreshed = await loadProject(projectId);
            if (refreshed) setProjectReloadVersion((value) => value + 1);
        };
        void refresh();
        window.addEventListener("focus", refresh);
        const timer = window.setInterval(refresh, 2_000);
        return () => {
            disposed = true;
            window.removeEventListener("focus", refresh);
            window.clearInterval(timer);
        };
    }, [checkProjectRevision, loadProject, projectId, projectLoaded, readOnly]);

    useEffect(() => {
        if (!hydrated) return;
        setProjectLoaded(false);
        const project = openProject(projectId);
        if (!project) return;

        const restore = async () => {
            const restoredNodes = await hydrateCanvasImages(resetInterruptedGeneration(project.nodes), { allowWrite: !readOnly });
            const videoThumbnailBackfilled = !readOnly && restoredNodes.some((node, index) => node.type === CanvasNodeType.Video && !project.nodes[index]?.metadata?.thumbnail && Boolean(node.metadata?.thumbnail));
            const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);
            setNodes(restoredNodes);
            setConnections(project.connections);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            lastMediaSignatureRef.current = mediaStorageSignature({ nodes: restoredNodes, chatSessions: restoredSessions });
            skipNextProjectSaveRef.current = true;
            skipNextViewportSaveRef.current = true;
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes,
                connections: project.connections,
                chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null,
                backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            setProjectLoaded(true);
            if (videoThumbnailBackfilled) updateProject(projectId, { nodes: restoredNodes }, { immediate: true });
        };
        void restore();
    }, [currentProject?.id, hydrated, openProject, projectId, projectReloadVersion, readOnly, updateProject]);

    useEffect(() => {
        if (!projectLoaded) return;
        setAgentState({ activeThreadId: "", messages: [], tokenUsage: null, pendingTool: null });
    }, [projectId, projectLoaded, setAgentState]);

    useEffect(() => {
        if (!projectLoaded || !["new", "recent", "choose"].includes(searchParams.get("mode") || "")) return;
        if (!searchParams.has("agentUrl")) openAgentPanel();
    }, [openAgentPanel, projectLoaded, searchParams]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (
            previous?.nodes === next.nodes &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded) return;
        const controller = new AbortController();
        const restoreTasks = async () => {
            const snapshot = nodesRef.current;
            const taskIds = Array.from(new Set(snapshot.map((node) => node.metadata?.generationTaskId).filter((value): value is string => Boolean(value))));
            const clientRequestIds = Array.from(new Set(snapshot.map((node) => node.metadata?.generationClientRequestId).filter((value): value is string => Boolean(value))));
            if (!taskIds.length && !clientRequestIds.length) return;

            const tasks = new Map<string, ImageGenerationTask>();
            const unresolved = new Set(snapshot.filter((node) => node.metadata?.generationTaskId || node.metadata?.generationClientRequestId).map((node) => node.id));
            const remember = (task?: ImageGenerationTask) => {
                if (!task) return;
                tasks.set(task.id, task);
                const bindings = task.context?.bindings || [];
                bindings.forEach((binding) => unresolved.delete(binding.nodeId));
                snapshot.forEach((node) => {
                    if (node.metadata?.generationTaskId === task.id || node.metadata?.generationClientRequestId === task.clientRequestId) unresolved.delete(node.id);
                });
            };
            const recoverTasks = async () => {
                let failed = false;
                for (const taskId of taskIds) {
                    if (tasks.has(taskId)) continue;
                    try {
                        remember(await getImageGenerationTask(taskId));
                    } catch (error) {
                        if (!(error && typeof error === "object" && "status" in error && (error as { status?: number }).status === 404)) failed = true;
                    }
                }
                for (const clientRequestId of clientRequestIds) {
                    if (Array.from(tasks.values()).some((task) => task.clientRequestId === clientRequestId)) continue;
                    try {
                        remember(await findImageGenerationTask(clientRequestId));
                    } catch {
                        failed = true;
                    }
                }
                if (unresolved.size) {
                    try {
                        const recentTasks = await listImageGenerationTasks("", { owner: "all", canvasId: projectId });
                        for (const nodeId of unresolved) {
                            const task = recentTasks.find((candidate) => candidate.context?.bindings?.some((binding) => binding.nodeId === nodeId));
                            remember(task);
                        }
                    } catch {
                        failed = true;
                    }
                }
                return failed;
            };

            let lookupFailed = await recoverTasks();
            if (unresolved.size && !controller.signal.aborted) {
                await new Promise<void>((resolve) => window.setTimeout(resolve, 2_000));
                if (controller.signal.aborted) return;
                lookupFailed = await recoverTasks();
            }

            const applyTask = async (task: ImageGenerationTask) => {
                const update = (current: CanvasNodeData[], nextTask = task) => applyCanvasImageTask(bindCanvasImageTask(current, nextTask), nextTask);
                setNodes((current) => update(current));
                if (task.status === "queued" || task.status === "running") {
                    await waitForImageGenerationTask(task.id, { signal: controller.signal, onUpdate: (next) => setNodes((current) => update(current, next)) });
                }
            };
            await Promise.all(Array.from(tasks.values()).map(applyTask));
            if (controller.signal.aborted || lookupFailed) return;
            if (unresolved.size) {
                setNodes((current) => current.map((node) => unresolved.has(node.id) ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: "后台生成任务不存在，请重新生成。" } } : node));
            }
        };
        void restoreTasks();
        return () => controller.abort();
    }, [projectId, projectLoaded]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current) return;
        if (skipNextProjectSaveRef.current) { skipNextProjectSaveRef.current = false; return; }
        if (!leaseHeld) return;
        const mediaSignature = mediaStorageSignature({ nodes, chatSessions });
        const immediate = mediaSignature !== lastMediaSignatureRef.current;
        lastMediaSignatureRef.current = mediaSignature;
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo }, { immediate });
    }, [activeChatId, backgroundMode, chatSessions, connections, leaseHeld, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        if (!["dirty", "saving", "error", "conflict"].includes(saveStatus)) return;
        const warnUnsaved = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
        window.addEventListener("beforeunload", warnUnsaved);
        return () => window.removeEventListener("beforeunload", warnUnsaved);
    }, [saveStatus]);

    useEffect(() => () => {
        const state = useCanvasStore.getState();
        if (state.leaseStates[projectId]?.status !== "held") return;
        const release = () => {
            void releaseCanvasEditLease(projectId, true);
            useCanvasStore.setState((current) => ({ leaseStates: { ...current.leaseStates, [projectId]: { status: "idle" } } }));
        };
        if (["dirty", "error"].includes(state.saveStates[projectId]?.status || "idle")) void flushProject(projectId).finally(release);
        else release();
    }, [flushProject, projectId]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded || !leaseHeld) return;
        if (skipNextViewportSaveRef.current) { skipNextViewportSaveRef.current = false; return; }
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        viewportSaveTimerRef.current = setTimeout(() => {
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        }, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [leaseHeld, projectId, projectLoaded, updateProject, viewport]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    useLayoutEffect(() => {
        selectionBoxRef.current = selectionBox;
    }, [selectionBox]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const getCanvasViewportFrame = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return rect ? { width: rect.width, height: rect.height, viewport: viewportRef.current } : null;
    }, []);

    const openDetailPageRoute = useCallback((nodeId: string, productId?: string, detailPageProjectId?: string) => {
        const query = new URLSearchParams({ canvasId: projectId, nodeId });
        if (productId) query.set("productId", productId);
        if (detailPageProjectId) query.set("projectId", detailPageProjectId);
        navigate(`/detail-pages?${query.toString()}`);
    }, [navigate, projectId]);

    const openMainImageRoute = useCallback((nodeId: string, productId?: string, projectIdValue?: string) => {
        const query = new URLSearchParams({ canvasId: projectId, nodeId });
        if (productId) query.set("productId", productId);
        if (projectIdValue) query.set("projectId", projectIdValue);
        navigate(`/main-image-replications?${query.toString()}`);
    }, [navigate, projectId]);

    const syncDetailPageProject = useCallback((project: DetailPageProject, anchorNodeId: string, productId?: string) => {
        const detailProject = project as CanvasDetailPageProject;
        const anchor = nodesRef.current.find((node) => node.id === anchorNodeId);
        if (!anchor) return;
        const sourceMetadata = anchor.metadata || {};
        const sourceNode = { ...anchor, metadata: { ...sourceMetadata, ...(productId ? { productId } : {}), detailPageProjectId: detailProject.id, detailPageProjectMissing: undefined, workflow: "detail-page-replication" as const } };
        const workflowNodes: CanvasNodeData[] = [];
        const workflowConnections: CanvasConnection[] = [];
        const pairs = [...(Array.isArray(detailProject.pairs) ? detailProject.pairs : [])].sort((a, b) => a.sortOrder - b.sortOrder);
        const baseX = anchor.position.x + anchor.width + 100;
        const baseY = anchor.position.y;
        const existingById = new Map(nodesRef.current.map((node) => [node.id, node]));
        const oldWorkflowIds = new Set(nodesRef.current.filter((node) => node.id !== anchor.id && node.metadata?.detailPageProjectId === detailProject.id && node.metadata?.workflow === "detail-page-replication").map((node) => node.id));
        pairs.forEach((pair, index) => {
            const reference = pair.referenceImage || {};
            const result = pair.resultImage;
            const referenceUrl = reference.url || "";
            const referenceThumbnail = reference.thumbnailUrl || referenceUrl;
            const referenceWidth = pair.referenceWidth || reference.width || 800;
            const referenceHeight = pair.referenceHeight || reference.height || 1200;
            const referenceId = `detail-reference-${detailProject.id}-${pair.id}`;
            const resultId = `detail-result-${detailProject.id}-${pair.id}`;
            const referenceSize = fitNodeSize(referenceWidth, referenceHeight, 300, 450);
            const resultWidth = result?.width || referenceWidth;
            const resultHeight = result?.height || referenceHeight;
            const resultSize = fitNodeSize(resultWidth, resultHeight, 340, 510);
            const status = pair.status === "failed" || pair.status === "interrupted" ? NODE_STATUS_ERROR : pair.status === "queued" || pair.status === "running" ? NODE_STATUS_LOADING : result?.url ? NODE_STATUS_SUCCESS : NODE_STATUS_IDLE;
            const referenceMetadata = { content: referenceUrl, thumbnail: referenceThumbnail, storageKey: reference.storageKey, status: referenceUrl ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: referenceUrl ? undefined : "参考图不存在", workflow: "detail-page-replication" as const, workflowRole: "reference" as const, detailPageProjectId: detailProject.id, detailPagePairId: pair.id, naturalWidth: referenceWidth, naturalHeight: referenceHeight } as CanvasNodeMetadata;
            const resultMetadata = { content: result?.url || "", thumbnail: result?.thumbnailUrl || result?.url, storageKey: result?.storageKey, status, errorDetails: pair.error, generationTaskId: pair.activeTaskId, workflow: "detail-page-replication" as const, workflowRole: "result" as const, detailPageProjectId: detailProject.id, detailPagePairId: pair.id, prompt: pair.resolvedPrompt || pair.prompt, naturalWidth: resultWidth, naturalHeight: resultHeight } as CanvasNodeMetadata;
            workflowNodes.push({ id: referenceId, type: CanvasNodeType.Image, title: `参考图 ${index + 1}`, position: { x: baseX, y: baseY + index * 560 }, width: referenceSize.width, height: referenceSize.height, metadata: referenceMetadata });
            workflowNodes.push({ id: resultId, type: CanvasNodeType.Image, title: `生成图 ${index + 1}`, position: { x: baseX + 430, y: baseY + index * 560 }, width: resultSize.width, height: resultSize.height, metadata: resultMetadata });
            workflowConnections.push({ id: `detail-connection-${detailProject.id}-${pair.id}-source`, fromNodeId: sourceNode.id, toNodeId: resultId });
            workflowConnections.push({ id: `detail-connection-${detailProject.id}-${pair.id}-result`, fromNodeId: referenceId, toNodeId: resultId });
        });
        const nextNodes = nodesRef.current.filter((node) => !oldWorkflowIds.has(node.id));
        const anchorIndex = nextNodes.findIndex((node) => node.id === anchor.id);
        if (anchorIndex >= 0) nextNodes[anchorIndex] = sourceNode;
        workflowNodes.forEach((node) => {
            const existing = existingById.get(node.id);
            if (!existing) nextNodes.push(node);
            else {
                const index = nextNodes.findIndex((item) => item.id === node.id);
                const nextNode = { ...existing, ...node, position: existing.position, width: existing.width, height: existing.height };
                if (index >= 0) nextNodes[index] = nextNode;
                else nextNodes.push(nextNode);
            }
        });
        const retainedConnections = connectionsRef.current.filter((connection) => !oldWorkflowIds.has(connection.fromNodeId) && !oldWorkflowIds.has(connection.toNodeId));
        const existingConnections = new Set(retainedConnections.map((connection) => connection.id));
        const nextConnections = [...retainedConnections, ...workflowConnections.filter((connection) => !existingConnections.has(connection.id))];
        const validNodeIds = new Set(nextNodes.map((node) => node.id));
        const cleanedConnections = nextConnections.filter((connection) => validNodeIds.has(connection.fromNodeId) && validNodeIds.has(connection.toNodeId));
        if (JSON.stringify(nextNodes) === JSON.stringify(nodesRef.current) && JSON.stringify(cleanedConnections) === JSON.stringify(connectionsRef.current)) return;
        if (readOnly) {
            nodesRef.current = nextNodes;
            connectionsRef.current = cleanedConnections;
            setNodes(nextNodes);
            setConnections(cleanedConnections);
        } else saveCanvasSnapshot(nextNodes, cleanedConnections);
    }, [readOnly, saveCanvasSnapshot]);

    const syncMainImageReplicationProject = useCallback((project: MainImageProject, anchorNodeId: string) => {
        const anchor = nodesRef.current.find((node) => node.id === anchorNodeId);
        if (!anchor) return;
        const sourceNode = { ...anchor, metadata: { ...anchor.metadata, productId: project.productId, mainImageReplicationProjectId: project.id, workflow: "main-image-replication" as const, workflowRole: "product" as const } };
        const baseX = anchor.position.x + anchor.width + 100;
        const baseY = anchor.position.y;
        const oldIds = new Set(nodesRef.current.filter((node) => node.metadata?.mainImageReplicationProjectId === project.id && node.id !== anchor.id).map((node) => node.id));
        const workflowNodes: CanvasNodeData[] = [];
        const workflowConnections: CanvasConnection[] = [];
        project.pairs.forEach((pair, index) => {
            const referenceId = `main-image-reference-${project.id}-${pair.id}`;
            const resultId = `main-image-result-${project.id}-${pair.id}`;
            const referenceMetadata = { content: pair.referenceImage?.url || "", thumbnail: pair.referenceImage?.thumbnailUrl || pair.referenceImage?.url, storageKey: pair.referenceImage?.storageKey, status: pair.referenceImage?.url ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, workflow: "main-image-replication" as const, workflowRole: "reference" as const, mainImageReplicationProjectId: project.id, mainImageReplicationPairId: pair.id, naturalWidth: pair.referenceWidth, naturalHeight: pair.referenceHeight } as CanvasNodeMetadata;
            const resultMetadata = { content: pair.resultImage?.url || "", thumbnail: pair.resultImage?.thumbnailUrl || pair.resultImage?.url, storageKey: pair.resultImage?.storageKey, status: pair.resultImage?.url ? NODE_STATUS_SUCCESS : pair.status === "queued" || pair.status === "running" ? NODE_STATUS_LOADING : NODE_STATUS_IDLE, errorDetails: pair.error, generationTaskId: pair.activeTaskId, workflow: "main-image-replication" as const, workflowRole: "result" as const, mainImageReplicationProjectId: project.id, mainImageReplicationPairId: pair.id, prompt: pair.resolvedPrompt || pair.prompt, naturalWidth: 1, naturalHeight: 1 } as CanvasNodeMetadata;
            workflowNodes.push({ id: referenceId, type: CanvasNodeType.Image, title: `主图参考 ${index + 1}`, position: { x: baseX, y: baseY + index * 430 }, width: 320, height: 320, metadata: referenceMetadata });
            workflowNodes.push({ id: resultId, type: CanvasNodeType.Image, title: `主图结果 ${index + 1}`, position: { x: baseX + 390, y: baseY + index * 430 }, width: 320, height: 320, metadata: resultMetadata });
            workflowConnections.push({ id: `main-image-connection-${project.id}-${pair.id}-source`, fromNodeId: sourceNode.id, toNodeId: resultId });
            workflowConnections.push({ id: `main-image-connection-${project.id}-${pair.id}-reference`, fromNodeId: referenceId, toNodeId: resultId });
        });
        const nextNodes = nodesRef.current.filter((node) => !oldIds.has(node.id));
        const anchorIndex = nextNodes.findIndex((node) => node.id === anchor.id);
        if (anchorIndex >= 0) nextNodes[anchorIndex] = sourceNode;
        workflowNodes.forEach((node) => { const index = nextNodes.findIndex((item) => item.id === node.id); if (index >= 0) nextNodes[index] = { ...nextNodes[index], ...node, position: nextNodes[index].position, width: nextNodes[index].width, height: nextNodes[index].height }; else nextNodes.push(node); });
        const retained = connectionsRef.current.filter((connection) => !oldIds.has(connection.fromNodeId) && !oldIds.has(connection.toNodeId));
        const nextConnections = [...retained, ...workflowConnections.filter((connection) => !retained.some((item) => item.id === connection.id))];
        if (JSON.stringify(nextNodes) === JSON.stringify(nodesRef.current) && JSON.stringify(nextConnections) === JSON.stringify(connectionsRef.current)) return;
        if (readOnly) { nodesRef.current = nextNodes; connectionsRef.current = nextConnections; setNodes(nextNodes); setConnections(nextConnections); } else void saveCanvasSnapshot(nextNodes, nextConnections);
    }, [readOnly, saveCanvasSnapshot]);

    const startDetailPageReplication = useCallback((nodeId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node || node.type !== CanvasNodeType.Image) return;
        setContextMenu(null);
        if (node.metadata?.detailPageProjectId) {
            openDetailPageRoute(nodeId, node.metadata.productId, node.metadata.detailPageProjectId);
            return;
        }
        if (node.metadata?.productId) {
            openDetailPageRoute(nodeId, node.metadata.productId);
            return;
        }
        setDetailPageSourceNodeId(nodeId);
    }, [openDetailPageRoute]);

    const startMainImageReplication = useCallback((nodeId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if (!node || node.type !== CanvasNodeType.Image) return;
        setContextMenu(null);
        if (node.metadata?.mainImageReplicationProjectId) {
            openMainImageRoute(nodeId, node.metadata.productId, node.metadata.mainImageReplicationProjectId);
            return;
        }
        if (node.metadata?.productId) {
            openMainImageRoute(nodeId, node.metadata.productId);
            return;
        }
        setMainImageSourceNodeId(nodeId);
    }, [openMainImageRoute]);

    const continueMainImageReplication = useCallback((product: { id: string }) => {
        if (!mainImageSourceNodeId) return;
        const nodeId = mainImageSourceNodeId;
        setMainImageSourceNodeId(null);
        openMainImageRoute(nodeId, product.id);
    }, [mainImageSourceNodeId, openMainImageRoute]);

    const continueDetailPageReplication = useCallback((product: { id: string }, project?: DetailPageProject) => {
        if (!detailPageSourceNodeId) return;
        const nodeId = detailPageSourceNodeId;
        setDetailPageSourceNodeId(null);
        openDetailPageRoute(nodeId, product.id, project?.id);
    }, [detailPageSourceNodeId, openDetailPageRoute]);

    useEffect(() => {
        if (!projectLoaded) return;
        const requestedProjectId = searchParams.get("projectId");
        const projectIds = new Set<string>();
        if (requestedProjectId) projectIds.add(requestedProjectId);
        nodesRef.current.forEach((node) => {
            if (node.metadata?.detailPageProjectId) projectIds.add(node.metadata.detailPageProjectId);
        });
        if (!projectIds.size) return;
        const requestedAnchorId = searchParams.get("nodeId");
        let disposed = false;
        let timer: number | null = null;
        const sync = async () => {
            let shouldPoll = false;
            for (const detailProjectId of projectIds) {
                if (disposed) return;
                try {
                    const item = await getDetailPageProject(detailProjectId);
                    if (disposed) return;
                    const detailItem = item as CanvasDetailPageProject;
                    const currentDetailNodes = nodesRef.current.filter((node) => node.metadata?.detailPageProjectId === detailProjectId);
                    const requestedAnchor = detailProjectId === requestedProjectId && requestedAnchorId ? nodesRef.current.find((node) => node.id === requestedAnchorId) : undefined;
                    const anchor = requestedAnchor && requestedAnchor.metadata?.workflowRole !== "reference" && requestedAnchor.metadata?.workflowRole !== "result"
                        ? requestedAnchor.id
                        : currentDetailNodes.find((node) => node.metadata?.productId && node.metadata.workflowRole !== "reference" && node.metadata.workflowRole !== "result")?.id;
                    if (anchor) syncDetailPageProject(detailItem, anchor, detailItem.productId);
                    const pairs = Array.isArray(detailItem.pairs) ? detailItem.pairs : [];
                    if (pairs.some((pair) => pair.status === "queued" || pair.status === "running") || detailItem.status === "generating") shouldPoll = true;
                } catch (error) {
                    if (disposed) return;
                    const errorText = error instanceof Error ? error.message : "详情页项目同步失败";
                    if (/不存在|未找到|404/.test(errorText)) {
                        const invalidNodes = nodesRef.current.map((node) => node.metadata?.detailPageProjectId === detailProjectId ? { ...node, metadata: { ...node.metadata, detailPageProjectMissing: true, errorDetails: "详情页项目已删除，画布保留当前静态内容" } } : node);
                        nodesRef.current = invalidNodes;
                        setNodes(invalidNodes);
                        if (!readOnly) void saveCanvasSnapshot(invalidNodes, connectionsRef.current);
                    } else {
                        message.error(errorText);
                    }
                }
            }
            if (shouldPoll && !disposed) timer = window.setTimeout(sync, 2_000);
        };
        void sync();
        const onFocus = () => void sync();
        window.addEventListener("focus", onFocus);
        return () => {
            disposed = true;
            if (timer) window.clearTimeout(timer);
            window.removeEventListener("focus", onFocus);
        };
    }, [message, projectLoaded, readOnly, saveCanvasSnapshot, searchParams, syncDetailPageProject]);

    useEffect(() => {
        if (!projectLoaded) return;
        const requestedProjectId = searchParams.get("projectId");
        if (!requestedProjectId) return;
        const anchorId = searchParams.get("nodeId");
        const anchor = nodesRef.current.find((node) => node.id === anchorId) || nodesRef.current.find((node) => node.metadata?.mainImageReplicationProjectId === requestedProjectId);
        if (!anchor && !nodesRef.current.some((node) => node.metadata?.mainImageReplicationProjectId === requestedProjectId)) return;
        let disposed = false;
        const sync = async () => {
            try { const item = await getMainImageReplicationProject(requestedProjectId); if (!disposed) syncMainImageReplicationProject(item, anchor?.id || nodesRef.current.find((node) => node.metadata?.mainImageReplicationProjectId === requestedProjectId)!.id); }
            catch (error) { if (!disposed && !/不存在|未找到|404/.test(error instanceof Error ? error.message : "")) message.error(error instanceof Error ? error.message : "主图复刻项目同步失败"); }
        };
        void sync();
        const timer = window.setInterval(() => void sync(), 2_000);
        return () => { disposed = true; window.clearInterval(timer); };
    }, [message, projectLoaded, searchParams, syncMainImageReplicationProject]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen || !selectedNodeIdsRef.current.has(nodeId)) return;
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {}, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning("配置节点之间不能连接");
                return;
            }
            const { fromNodeId, toNodeId } = connection;
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                setConnections((prev) => [...prev, { id: `conn-${Date.now()}`, fromNodeId, toNodeId }]);
            }
            setContextMenu(null);
        },
        [message],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio, pending: PendingConnectionCreate) => {
            if (readOnly) return;
            const metadata = type === CanvasNodeType.Config ? { model: effectiveConfig.imageModel || effectiveConfig.model, size: effectiveConfig.size, count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count) } : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning("配置节点之间不能连接");
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message, readOnly, setConnecting],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            let isNearNode = false;
            let bestNodeId: string | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;

            [...nodesRef.current]
                .filter((node) => !isHiddenBatchChild(node, nodesRef.current))
                .reverse()
                .forEach((node) => {
                    const anchor = getConnectionTargetAnchor(node, current);
                    const dx = world.x - anchor.x;
                    const dy = world.y - anchor.y;
                    const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
                    const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                    const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

                    if (!hitsHandle && !hitsInside && !hitsExpanded) return;
                    isNearNode = true;
                    if (node.id === current.nodeId || !normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType)) return;

                    const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
                    if (priority < bestPriority) {
                        bestNodeId = node.id;
                        bestPriority = priority;
                    }
                });

            return { nodeId: bestNodeId, isNearNode };
        },
        [screenToCanvas],
    );

    const visibleNodes = useMemo(() => {
        const padding = 280;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + width / viewport.k + padding * 2;
        const viewBottom = viewTop + height / viewport.k + padding * 2;

        return nodes.filter((node) => !isHiddenBatchChild(node, nodes, collapsingBatchIds) && node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom);
    }, [collapsingBatchIds, nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    // 工具条跟随「单选节点」:点击/新建/框选/键盘选中任一节点都会显示,不再仅靠精确点中触发。
    // 多选时不显示;拖拽中由下方 isNodeDragging 守卫隐藏。
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const toolbarNode = (toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null) || (singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) || null : null);
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const competitorReplicationNode = competitorReplicationNodeId ? nodeById.get(competitorReplicationNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const batchChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            if (node.metadata?.isBatchRoot) map.set(node.id, node.metadata.batchChildIds?.length || 0);
        });
        return map;
    }, [nodes]);
    const groupChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        nodes.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId) map.set(groupId, (map.get(groupId) || 0) + 1);
        });
        return map;
    }, [nodes]);
    const batchMotionById = useMemo(() => {
        const map = new Map<string, { x: number; y: number; index: number }>();
        nodes.forEach((node) => {
            const rootId = node.metadata?.batchRootId;
            if (!rootId) return;
            const root = nodeById.get(rootId);
            const index = root?.metadata?.batchChildIds?.indexOf(node.id) ?? 0;
            const stackX = root ? root.position.x + 34 + index * 14 : node.position.x;
            const stackY = root ? root.position.y + 14 + index * 8 : node.position.y;
            map.set(node.id, { x: stackX - node.position.x, y: stackY - node.position.y, index: Math.max(index, 0) });
        });
        return map;
    }, [nodeById, nodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections]);

    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Config) return;
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections));
        });
        return map;
    }, [connections, nodes]);
    const mentionReferencesByNodeId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof buildNodeMentionReferences>>();
        nodes.forEach((node) => map.set(node.id, buildNodeMentionReferences(node, nodes, connections)));
        return map;
    }, [connections, nodes]);
    const { applyAgentOps } = useAgentBridge({
        projectId,
        readOnly,
        title: currentProject?.title,
        nodes,
        connections,
        selectedNodeIds,
        viewport,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setViewport,
        setContextMenu,
    });

    const { pluginHost, renderPluginPanel, buildNodeToolbarItems } = usePluginHost({
        effectiveConfig,
        isAiConfigReady,
        openConfigDialog,
        theme,
        nodesRef,
        connectionsRef,
        viewportRef,
        setNodes,
        setDialogNodeId,
        applyAgentOps,
    });
    const createNode = useCallback(
        (type: CanvasNodeTypeId, position?: Position) => {
            if (readOnly) return;
            const targetPosition = position || getCanvasCenter();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.size,
                          count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                      }
                    : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            const definition = getNodeDefinition(type);
            // 纯展示型插件节点(hidePanel)不弹面板;插件自定义 Panel 需显式 autoOpenPanel 才在新建时打开;
            // 声明了 useBuiltinPanel 的插件节点复用内置生成面板,新建即打开(与图片节点一致);
            // 内置的图片/视频/配置类节点保持原有「新建即打开生图面板」行为。
            const wantsPanel = definition?.hidePanel
                ? false
                : definition?.Panel
                  ? Boolean(definition.autoOpenPanel)
                  : definition?.useBuiltinPanel
                    ? true
                    : isBuiltinType(type) && type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio && type !== CanvasNodeType.Group;
            if (wantsPanel) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, getCanvasCenter, readOnly],
    );

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (readOnly || !ids.size) return;
            const allIds = new Set(ids);
            nodesRef.current.forEach((node) => {
                if (ids.has(node.id)) node.metadata?.batchChildIds?.forEach((childId) => allIds.add(childId));
            });
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const groupId = node.metadata?.groupId;
                    if (groupId && allIds.has(groupId)) return { ...node, metadata: { ...node.metadata, groupId: undefined } };
                    const childIds = node.metadata?.batchChildIds?.filter((childId) => !allIds.has(childId));
                    if (!node.metadata?.isBatchRoot || childIds?.length === node.metadata.batchChildIds?.length) return node;
                    const primaryImageId = childIds?.includes(node.metadata.primaryImageId || "") ? node.metadata.primaryImageId : childIds?.[0];
                    const primaryNode = next.find((item) => item.id === primaryImageId);
                    return {
                        ...node,
                        metadata: {
                            ...node.metadata,
                            batchChildIds: childIds,
                            primaryImageId,
                            content: primaryNode?.metadata?.content || node.metadata.content,
                            thumbnail: primaryNode?.metadata?.thumbnail || node.metadata.thumbnail,
                            naturalWidth: primaryNode?.metadata?.naturalWidth || node.metadata.naturalWidth,
                            naturalHeight: primaryNode?.metadata?.naturalHeight || node.metadata.naturalHeight,
                        },
                    };
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setEditingNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, projectId, readOnly],
    );

    const deleteConnection = useCallback((connectionId: string) => {
        if (readOnly) return;
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, [readOnly]);

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setSelectionBox(null);
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        setEditingNodeId(null);
    }, [cancelPendingConnectionCreate]);

    const clearCanvas = useCallback(() => {
        if (readOnly) return;
        setNodes([]);
        setConnections([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, deselectCanvas, projectId, readOnly]);

    const duplicateNode = useCallback((nodeId: string) => {
        if (readOnly) return;
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const next: CanvasNodeData = {
            ...source,
            id,
            title: `${source.title} Copy`,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
        };

        setNodes((prev) => [...prev, next]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, [readOnly]);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        if (readOnly) return false;
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            return { ...node, metadata: { ...node.metadata, groupId: idMap.get(groupId) } };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...pastedNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter, readOnly]);

    const resetViewport = useCallback(() => {
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const worldX = node.position.x + node.width / 2;
            const worldY = node.position.y + node.height / 2;
            const k = Math.min(Math.max(Math.min((size.width * 0.6) / node.width, (size.height * 0.6) / node.height), 0.05), 1.5);
            const target = { x: size.width / 2 - worldX * k, y: size.height / 2 - worldY * k, k };
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setContextMenu(null);

            if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
            const start = { ...viewportRef.current };
            const duration = 450;
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
            let startTime: number | null = null;
            const step = (now: number) => {
                if (startTime === null) startTime = now;
                const progress = Math.min((now - startTime) / duration, 1);
                const t = easeOutCubic(progress);
                setViewport({ x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t, k: start.k + (target.k - start.k) * t });
                focusAnimRef.current = progress < 1 ? requestAnimationFrame(step) : null;
            };
            focusAnimRef.current = requestAnimationFrame(step);
        },
        [size.height, size.width],
    );

    useEffect(() => () => void (focusAnimRef.current && cancelAnimationFrame(focusAnimRef.current)), []);

    const setZoomScale = useCallback(
        (scale: number) => {
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        setNodes(entry.nodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = entry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    const createAndOpenProject = useCallback(() => {
        const id = createProject(`无限画布 ${useCanvasStore.getState().projects.length + 1}`);
        navigate(`/canvas/${id}`);
    }, [createProject, navigate]);

    const deleteCurrentProject = useCallback(async () => {
        try {
            await deleteProjects([projectId]);
            cleanupAssetImages();
            navigate("/canvas");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "删除画布失败");
        }
    }, [cleanupAssetImages, deleteProjects, message, navigate, projectId]);

    const exportCurrentProject = useCallback(async () => {
        const project = useCanvasStore.getState().projects.find((item) => item.id === projectId);
        if (!project) return message.error("未找到当前画布");
        const hide = message.loading("正在导出当前画布…", 0);
        try {
            await exportCanvasProjects([project], project.title || "无限画布");
            message.success("已导出当前画布");
        } catch (error) {
            console.error(error);
            message.error("导出失败，请重试");
        } finally {
            hide();
        }
    }, [message, projectId]);

    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            setNodeCreatePosition(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            if (!event.ctrlKey && !event.metaKey) {
                setSelectionBox(null);
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas],
    );

    // 仅处理「选中」的纯逻辑,供 body 冒泡拖拽入口与外层 capture 入口共用。
    // 返回本次点击后的单选目标 id(多选/取消时为 null),用于同步工具条。
    const selectNodeByEvent = useCallback((event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">, nodeId: string) => {
        const nextSelected = new Set(selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }
        setSelectedNodeIds(nextSelected);
        const soloId = nextSelected.size === 1 && nextSelected.has(nodeId) ? nodeId : null;
        setToolbarNodeId(soloId);
        return { nextSelected, soloId };
    }, []);

    // capture 阶段选中:点击节点内部任意元素(含吞掉 mousedown 的 textarea/iframe)都能选中并弹出工具条。
    // 只做选中,不启动拖拽 —— 拖拽仍由 body 的 onMouseDown(冒泡)负责,故编辑器内选词不会拖动节点。
    // capture 必先于同一次事件的 body 冒泡触发,故把算好的选中集暂存,供紧随其后的拖拽入口复用,避免二次选中(shift 反选被抵消)。
    const pendingSelectionRef = useRef<Set<string> | null>(null);
    const handleNodeSelectCapture = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            if (event.button !== 0) return;
            setContextMenu(null);
            setHoveredNodeId(null);
            setSelectedConnectionId(null);
            const { nextSelected } = selectNodeByEvent(event, nodeId);
            pendingSelectionRef.current = nextSelected;
        },
        [selectNodeByEvent],
    );

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.stopPropagation();
        // 选中已由 capture 阶段完成;这里只负责建立拖拽。若因故没走 capture,则兜底再选一次。
        const currentNodes = nodesRef.current;
        const nextSelected = pendingSelectionRef.current ?? selectNodeByEvent(event, nodeId).nextSelected;
        pendingSelectionRef.current = null;
        const dragIds = new Set(nextSelected);
        currentNodes.forEach((node) => {
            if (!nextSelected.has(node.id)) return;
            node.metadata?.batchChildIds?.forEach((childId) => dragIds.add(childId));
            if (node.type === CanvasNodeType.Group) {
                currentNodes.forEach((child) => {
                    if (child.metadata?.groupId === node.id) dragIds.add(child.id);
                });
            }
        });
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes: currentNodes.filter((node) => dragIds.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, []);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;

        const wasClick = !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.length === 1;
        const clickedNodeId = dragRef.current.initialSelectedNodes[0]?.id;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
        const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
        const initialPositions = dragRef.current.initialSelectedNodes;

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        setDropTargetGroupId(null);
        if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            const movedIds = new Set(initialPositions.map((item) => item.id));
            setNodes((prev) => {
                const moved = prev.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                const targetGroup = findGroupDropTarget(movedIds, moved);
                if (targetGroup) return snapNodesIntoGroup(movedIds, moved, targetGroup);
                return moved.map((node) => {
                    if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
                    const groupId = findContainingGroupId(node, moved);
                    if (node.metadata?.groupId === groupId) return node;
                    return { ...node, metadata: { ...node.metadata, groupId } };
                });
            });
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = [];
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            const clickedDefinition = clickedNode ? getNodeDefinition(clickedNode.type) : undefined;
            if (clickedNode?.type === CanvasNodeType.Text) {
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedDefinition?.hidePanel) {
                // 纯展示型插件节点:单击只选中,不弹下方面板
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedNode?.type !== CanvasNodeType.Group) {
                setDialogNodeId(clickedNodeId);
            }
        }
    }, []);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const initialPositions = dragRef.current.initialSelectedNodes;
                if (Math.abs(event.clientX - dragRef.current.startX) > 3 || Math.abs(event.clientY - dragRef.current.startY) > 3) {
                    dragRef.current.hasMoved = true;
                }

                const movedIds = new Set(initialPositions.map((item) => item.id));
                const previewNodes = nodesRef.current.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                setDropTargetGroupId(findGroupDropTarget(movedIds, previewNodes)?.id || null);

                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositions.find((item) => item.id === node.id);
                            return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                        }),
                    );
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }
        },
        [finishNodeDrag, getConnectionDropTarget, screenToCanvas],
    );

    const handleGlobalPointerMove = useCallback(
        (event: PointerEvent) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;

            if (event.buttons === 0) {
                selectionBoxRef.current = null;
                setSelectionBox(null);
                return;
            }

            const world = screenToCanvas(event.clientX, event.clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current
                .filter((node) => !isHiddenBatchChild(node, nodesRef.current))
                .forEach((node) => {
                    const intersects = rectX < node.position.x + node.width && rectX + rectW > node.position.x && rectY < node.position.y + node.height && rectY + rectH > node.position.y;

                    if (intersects) nextSelected.add(node.id);
                });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            setSelectionBox(nextSelectionBox);
            setSelectedNodeIds(nextSelected);
        },
        [screenToCanvas],
    );

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);

            selectionBoxRef.current = null;
            setSelectionBox(null);

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.nodeId) {
                    connectNodes(currentConnection, dropTarget.nodeId);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [connectNodes, finishNodeDrag, getConnectionDropTarget, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => finishNodeDrag(event.clientX, event.clientY);
        const cancelNodeDrag = () => finishNodeDrag();
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", cancelNodeDrag);
        window.addEventListener("blur", cancelNodeDrag);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", cancelNodeDrag);
            window.removeEventListener("blur", cancelNodeDrag);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        if (readOnly) return;
        const image = await uploadImage(file);
        const size = fitImageNodeInitialSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, [readOnly]);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        if (readOnly) return;
        const video = await uploadMediaFile(file, "video");
        const size = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, [readOnly]);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        if (readOnly) return;
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, [readOnly]);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            if (readOnly) return false;
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || "剪切板文本",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter, readOnly],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (readOnly) return;
        if (!navigator.clipboard) return;

        const items = await navigator.clipboard.read();
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            void createImageFileNode(file, getCanvasCenter());
            message.success("已从剪切板添加图片");
            return;
        }

        const text = await navigator.clipboard.readText();
        if (createTextNodeFromClipboard(text)) message.success("已从剪切板添加文本");
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, readOnly]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore]")) return;
            if (readOnly) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                setSelectionBox(null);
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!pasteCopiedNodes()) void pasteSystemClipboard();
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    deleteNodes(new Set(selectedNodeIdsRef.current));
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setNodeCreatePosition(null);
                setSelectionBox(null);
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setEditingNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [copySelectedNodes, deleteConnection, deleteNodes, pasteCopiedNodes, pasteSystemClipboard, readOnly, redoCanvas, selectedConnectionId, setConnecting, undoCanvas]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            if (readOnly) return;
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [readOnly, screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        if (readOnly) return;
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
    }, [readOnly]);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        if (readOnly) return;
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, [readOnly]);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        if (readOnly) return;
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, [readOnly]);

    const handleNodeTitleChange = useCallback((nodeId: string, title: string) => {
        if (readOnly) return;
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, title } : node)));
    }, [readOnly]);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        if (readOnly) return;
        const isExpanded = Boolean(nodesRef.current.find((node) => node.id === nodeId)?.metadata?.imageBatchExpanded);
        if (isExpanded) {
            setCollapsingBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setCollapsingBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 320);
        } else {
            setOpeningBatchIds((prev) => new Set(prev).add(nodeId));
            window.setTimeout(() => {
                setOpeningBatchIds((prev) => {
                    const next = new Set(prev);
                    next.delete(nodeId);
                    return next;
                });
            }, 260);
        }
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                return { ...node, metadata: { ...node.metadata, imageBatchExpanded: !node.metadata?.imageBatchExpanded } };
            }),
        );
    }, [readOnly]);

    const setBatchPrimary = useCallback((child: CanvasNodeData) => {
        if (readOnly) return;
        const rootId = child.metadata?.batchRootId;
        if (!rootId || !child.metadata?.content) return;
        setNodes((prev) =>
            prev.map((node) =>
                node.id === rootId
                    ? {
                          ...node,
                          width: child.width,
                          height: child.height,
                          metadata: {
                              ...node.metadata,
                              content: child.metadata?.content,
                              thumbnail: child.metadata?.thumbnail,
                              primaryImageId: child.id,
                              naturalWidth: child.metadata?.naturalWidth,
                              naturalHeight: child.metadata?.naturalHeight,
                              freeResize: child.metadata?.freeResize,
                          },
                      }
                    : node,
            ),
        );
    }, [readOnly]);

    const openTextEditor = useCallback((node: CanvasNodeData) => {
        if (readOnly) return;
        if (node.type !== CanvasNodeType.Text) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(node.id);
        setEditingNodeId(node.id);
        setEditRequestNonce((value) => value + 1);
    }, [readOnly]);

    const handleContentEditingChange = useCallback((nodeId: string, editing: boolean) => {
        setEditingNodeId((current) => editing ? nodeId : current === nodeId ? null : current);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        if (readOnly) return;
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, [readOnly]);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        if (readOnly) return;
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, [readOnly]);

    const downloadNodeImage = useCallback((node: CanvasNodeData) => {
        if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
        saveAs(node.metadata.content, `canvas-${node.type}-${node.id}.${node.type === CanvasNodeType.Video ? "mp4" : node.type === CanvasNodeType.Audio ? audioExtension(node.metadata.mimeType) : imageExtension(node.metadata.content)}`);
    }, []);

    const saveNodeAsset = useCallback(
        async (node: CanvasNodeData) => {
            if (node.type === CanvasNodeType.Text) {
                const content = node.metadata?.content?.trim();
                if (!content) return message.error("没有可保存的文本");
                addAsset({ kind: "text", title: node.metadata?.prompt?.slice(0, 24) || "画布文本", coverUrl: "", tags: [], source: "Canvas", data: { content }, metadata: { source: "canvas", nodeId: node.id } });
                message.success("已加入我的资产");
                return;
            }
            if (node.type === CanvasNodeType.Video) {
                if (!node.metadata?.content) return message.error("没有可保存的视频");
                addAsset({
                    kind: "video",
                    title: node.metadata?.prompt?.slice(0, 24) || "画布视频",
                    coverUrl: node.metadata.thumbnail || "",
                    tags: [],
                    source: "Canvas",
                    data: { url: node.metadata.content, thumbnailUrl: node.metadata.thumbnail, storageKey: node.metadata.storageKey, width: node.width, height: node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" },
                    metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
                });
                message.success("已加入我的资产");
                return;
            }
            if (!node.metadata?.content) return message.error("没有可保存的图片");
            const dataUrl = node.metadata.storageKey ? "" : node.metadata.content;
            addAsset({
                kind: "image",
                title: node.metadata?.prompt?.slice(0, 24) || "画布图片",
                coverUrl: imageThumbnailUrl(node.metadata.storageKey, node.metadata.thumbnail || node.metadata.content),
                tags: [],
                source: "Canvas",
                data: {
                    dataUrl,
                    storageKey: node.metadata.storageKey,
                    width: node.metadata.naturalWidth || node.width,
                    height: node.metadata.naturalHeight || node.height,
                    bytes: node.metadata.bytes || getDataUrlByteSize(dataUrl),
                    mimeType: node.metadata.mimeType || "image/png",
                },
                metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt },
            });
            message.success("已加入我的资产");
        },
        [addAsset, message],
    );

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (readOnly) return;
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning("图片节点为空，无法反推提示词");
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY }, { content: IMAGE_PROMPT_REVERSE_PRESET, prompt: IMAGE_PROMPT_REVERSE_PRESET, status: NODE_STATUS_SUCCESS, fontSize: 14 }),
                title: "反推提示词",
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: `参考图片：@[node:${node.id}]\n任务说明：@[node:${textNode.id}]`,
                    },
                ),
                title: "反推提示词配置",
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message, readOnly],
    );

    const runCompetitorReplicationImage = useCallback(
        async (resultNodeId: string) => {
            if (readOnly) {
                message.warning("当前画布只读，请先接管编辑");
                return;
            }
            const resultNode = nodesRef.current.find((node) => node.id === resultNodeId);
            const sourceNode = nodesRef.current.find((node) => node.id === resultNode?.metadata?.sourceNodeId);
            const configNode = nodesRef.current.find((node) => node.id === resultNode?.metadata?.configNodeId);
            const competitorNodes = (resultNode?.metadata?.competitorReferenceNodeIds || [])
                .map((nodeId) => nodesRef.current.find((node) => node.id === nodeId))
                .filter((node): node is CanvasNodeData => Boolean(node));
            if (!resultNode || !sourceNode?.metadata?.content || !competitorNodes.length || competitorNodes.some((node) => !node.metadata?.content)) {
                const errorDetails = "复刻参考图片已丢失，无法继续生成";
                message.error(errorDetails);
                setNodes((current) => current.map((node) => node.id === resultNodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node));
                return;
            }

            const baseGenerationConfig = buildGenerationConfig(effectiveConfig, configNode || resultNode, "image");
            const generationConfig: AiConfig = {
                ...baseGenerationConfig,
                imageModel: baseGenerationConfig.model,
                size: configNode?.metadata?.size || resultNode.metadata?.size || sourceImageRatio(sourceNode.metadata.naturalWidth || sourceNode.width, sourceNode.metadata.naturalHeight || sourceNode.height),
                count: "1",
            };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true, "channels");
                setNodes((current) => current.map((node) => node.id === resultNodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: "请先配置可用的图片模型后重试" } } : node));
                return;
            }

            const prompt = (configNode?.metadata?.composerContent ?? configNode?.metadata?.prompt ?? resultNode.metadata?.prompt ?? "").trim();
            if (!prompt) {
                message.error("复刻生成提示词已丢失，无法重试");
                return;
            }
            const references: ReferenceImage[] = [sourceNode, ...competitorNodes].map((node, index) => ({
                id: node.id,
                name: index === 0 ? "my-product.png" : `competitor-${index}.png`,
                type: node.metadata?.mimeType || "image/png",
                dataUrl: node.metadata?.content || "",
                storageKey: node.metadata?.storageKey,
            }));
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, references);
            setRunningNodeId(resultNodeId);
            const loadingNodes = nodesRef.current.map((node) => node.id === resultNodeId ? {
                ...node,
                metadata: {
                    ...node.metadata,
                    prompt,
                    status: NODE_STATUS_LOADING,
                    errorDetails: undefined,
                    generationTaskId: undefined,
                    generationClientRequestId: undefined,
                    generationSlot: undefined,
                    ...generationMetadata,
                },
            } : node);
            nodesRef.current = loadingNodes;
            setNodes(loadingNodes);
            const controller = startGenerationRequest(resultNodeId, sourceNode.id, resultNodeId);
            try {
                const requestOptions = await prepareImageRequestOptions(
                    generationConfig,
                    [{ nodeId: resultNodeId, slot: 0 }],
                    controller.signal,
                    { workflow: "competitor-visual-replication" },
                );
                const image = await requestEdit(generationConfig, prompt, references, undefined, requestOptions).then((items) => items[0]);
                if (!image) throw new Error("模型没有返回复刻结果图片");
                const uploaded = image.storageKey?.startsWith("media:") ? await ensureUploadedImage(image) : await uploadImage(image.dataUrl, currentProject?.ownerId);
                const imageSize = fitNodeSize(uploaded.width, uploaded.height, NODE_DEFAULT_SIZE[CanvasNodeType.Image].width, NODE_DEFAULT_SIZE[CanvasNodeType.Image].height);
                setNodes((current) => current.map((node) => node.id === resultNodeId ? {
                    ...node,
                    width: imageSize.width,
                    height: imageSize.height,
                    position: { x: node.position.x + node.width / 2 - imageSize.width / 2, y: node.position.y + node.height / 2 - imageSize.height / 2 },
                    metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata },
                } : node));
                message.success("竞品视觉复刻已完成");
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "竞品视觉复刻生成失败";
                message.error(errorDetails);
                setNodes((current) => current.map((node) => node.id === resultNodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node));
            } finally {
                finishGenerationRequest(resultNodeId, controller);
                setRunningNodeId(null);
            }
        },
        [currentProject?.ownerId, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, prepareImageRequestOptions, readOnly, startGenerationRequest],
    );

    const runCompetitorReplicationAnalysis = useCallback(
        async (analysisNodeId: string) => {
            if (readOnly) {
                message.warning("当前画布只读，请先接管编辑");
                return;
            }
            const analysisNode = nodesRef.current.find((node) => node.id === analysisNodeId);
            const sourceNode = nodesRef.current.find((node) => node.id === analysisNode?.metadata?.sourceNodeId);
            const competitorNodes = (analysisNode?.metadata?.competitorReferenceNodeIds || [])
                .map((nodeId) => nodesRef.current.find((node) => node.id === nodeId))
                .filter((node): node is CanvasNodeData => Boolean(node));
            if (!analysisNode || !sourceNode?.metadata?.content || !competitorNodes.length || competitorNodes.some((node) => !node.metadata?.content)) {
                const errorDetails = "竞品参考图片已丢失，无法重新分析";
                message.error(errorDetails);
                setNodes((current) => current.map((node) => node.id === analysisNodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, analysisStatus: "error", analysisError: errorDetails, errorDetails } } : node));
                return;
            }

            const textModel = effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel;
            const analysisConfig = { ...effectiveConfig, model: textModel, textModel };
            if (!isAiConfigReady(analysisConfig, analysisConfig.model)) {
                openConfigDialog(true, "channels");
                const errorDetails = "请先配置支持图片理解的文本模型后重新分析";
                setNodes((current) => current.map((node) => node.id === analysisNodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, analysisStatus: "error", analysisError: errorDetails, errorDetails } } : node));
                return;
            }
            const controller = startGenerationRequest(analysisNodeId, sourceNode.id, analysisNodeId);
            setRunningNodeId(analysisNodeId);
            setNodes((current) => current.map((node) => node.id === analysisNodeId ? {
                ...node,
                metadata: { ...node.metadata, content: "", status: NODE_STATUS_LOADING, analysisStatus: "loading", analysisError: undefined, errorDetails: undefined, model: textModel },
            } : node));

            try {
                const analysisImages = await Promise.all([sourceNode, ...competitorNodes].map((node) => imageToDataUrl({
                    url: imageThumbnailUrl(node.metadata?.storageKey, node.metadata?.thumbnail || node.metadata?.content || ""),
                })));
                const replicationOptions = {
                    includeBrand: Boolean(analysisNode.metadata?.includeBrand),
                    brandOverride: analysisNode.metadata?.includeBrand ? analysisNode.metadata?.brandOverride || "" : "",
                    includeText: Boolean(analysisNode.metadata?.includeText),
                    textOverride: analysisNode.metadata?.includeText ? analysisNode.metadata?.textOverride || "" : "",
                    includePackaging: Boolean(analysisNode.metadata?.includePackaging),
                };
                let streamed = "";
                const answer = await requestImageQuestion(
                    analysisConfig,
                    buildCompetitorAnalysisMessages(analysisImages, analysisNode.metadata?.instruction || "", replicationOptions),
                    (text) => {
                        streamed = text;
                        setNodes((current) => current.map((node) => node.id === analysisNodeId ? { ...node, metadata: { ...node.metadata, content: text, status: NODE_STATUS_LOADING } } : node));
                    },
                    { signal: controller.signal },
                );
                const analysis = parseCompetitorVisualAnalysis(answer || streamed);
                const analysisText = formatCompetitorVisualAnalysis(analysis);
                const generationPrompt = buildCompetitorGenerationPrompt(analysis, analysisNode.metadata?.instruction || "", replicationOptions);
                const currentAnalysisNode = nodesRef.current.find((node) => node.id === analysisNodeId) || analysisNode;
                const existingConfigNode = nodesRef.current.find((node) => node.id === currentAnalysisNode.metadata?.configNodeId);
                const existingResultNode = nodesRef.current.find((node) => node.id === currentAnalysisNode.metadata?.resultNodeId);
                const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
                const imageSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const gap = 96;
                const centerY = sourceNode.position.y + sourceNode.height / 2;
                const configNodeId = existingConfigNode?.id || nanoid();
                const resultNodeId = existingResultNode?.id || nanoid();
                const competitorReferenceNodeIds = competitorNodes.map((node) => node.id);
                const ratioSize = sourceImageRatio(sourceNode.metadata.naturalWidth || sourceNode.width, sourceNode.metadata.naturalHeight || sourceNode.height);
                const generationConfig: AiConfig = {
                    ...effectiveConfig,
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    imageModel: effectiveConfig.imageModel,
                    size: ratioSize,
                    count: "1",
                };
                const references: ReferenceImage[] = [sourceNode, ...competitorNodes].map((node, index) => ({
                    id: node.id,
                    name: index === 0 ? "my-product.png" : `competitor-${index}.png`,
                    type: node.metadata?.mimeType || "image/png",
                    dataUrl: node.metadata?.content || "",
                    storageKey: node.metadata?.storageKey,
                }));
                const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, references);
                const configNode: CanvasNodeData = existingConfigNode ? {
                    ...existingConfigNode,
                    title: "竞品视觉复刻配置",
                    metadata: {
                        ...existingConfigNode.metadata,
                        workflow: "competitor-visual-replication",
                        workflowRole: "config",
                        sourceNodeId: sourceNode.id,
                        competitorReferenceNodeIds,
                        analysisNodeId,
                        resultNodeId,
                        instruction: currentAnalysisNode.metadata?.instruction,
                        ...replicationOptions,
                        analysisText,
                        prompt: generationPrompt,
                        composerContent: generationPrompt,
                        generationMode: "image",
                        status: NODE_STATUS_SUCCESS,
                        ...generationMetadata,
                    },
                } : {
                    id: configNodeId,
                    type: CanvasNodeType.Config,
                    title: "竞品视觉复刻配置",
                    position: {
                        x: currentAnalysisNode.position.x + currentAnalysisNode.width + gap,
                        y: centerY - configSpec.height / 2,
                    },
                    width: configSpec.width,
                    height: configSpec.height,
                    metadata: {
                        workflow: "competitor-visual-replication",
                        workflowRole: "config",
                        sourceNodeId: sourceNode.id,
                        competitorReferenceNodeIds,
                        analysisNodeId,
                        resultNodeId,
                        instruction: currentAnalysisNode.metadata?.instruction,
                        ...replicationOptions,
                        analysisText,
                        prompt: generationPrompt,
                        composerContent: generationPrompt,
                        generationMode: "image",
                        status: NODE_STATUS_SUCCESS,
                        ...generationMetadata,
                    },
                };
                const resultNode: CanvasNodeData = existingResultNode ? {
                    ...existingResultNode,
                    title: "竞品视觉复刻结果",
                    metadata: {
                        ...existingResultNode.metadata,
                        workflow: "competitor-visual-replication",
                        workflowRole: "result",
                        sourceNodeId: sourceNode.id,
                        competitorReferenceNodeIds,
                        analysisNodeId,
                        configNodeId,
                        instruction: currentAnalysisNode.metadata?.instruction,
                        ...replicationOptions,
                        analysisText,
                        prompt: generationPrompt,
                        status: NODE_STATUS_LOADING,
                        errorDetails: undefined,
                        generationTaskId: undefined,
                        generationClientRequestId: undefined,
                        generationSlot: undefined,
                        ...generationMetadata,
                    },
                } : {
                    id: resultNodeId,
                    type: CanvasNodeType.Image,
                    title: "竞品视觉复刻结果",
                    position: {
                        x: configNode.position.x + configNode.width + gap,
                        y: centerY - imageSpec.height / 2,
                    },
                    width: imageSpec.width,
                    height: imageSpec.height,
                    metadata: {
                        workflow: "competitor-visual-replication",
                        workflowRole: "result",
                        sourceNodeId: sourceNode.id,
                        competitorReferenceNodeIds,
                        analysisNodeId,
                        configNodeId,
                        instruction: currentAnalysisNode.metadata?.instruction,
                        ...replicationOptions,
                        analysisText,
                        prompt: generationPrompt,
                        status: NODE_STATUS_LOADING,
                        ...generationMetadata,
                    },
                };
                const nextNodes = [
                    ...nodesRef.current.filter((node) => node.id !== analysisNodeId && node.id !== configNodeId && node.id !== resultNodeId),
                    {
                        ...currentAnalysisNode,
                        metadata: {
                            ...currentAnalysisNode.metadata,
                            content: analysisText,
                            analysisText,
                            status: NODE_STATUS_SUCCESS,
                            analysisStatus: "success" as const,
                            analysisError: undefined,
                            errorDetails: undefined,
                            configNodeId,
                            resultNodeId,
                        },
                    },
                    configNode,
                    resultNode,
                ];
                const requiredConnections: CanvasConnection[] = [
                    { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNodeId },
                    ...competitorReferenceNodeIds.map((nodeId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: configNodeId })),
                    { id: nanoid(), fromNodeId: analysisNodeId, toNodeId: configNodeId },
                    { id: nanoid(), fromNodeId: configNodeId, toNodeId: resultNodeId },
                ];
                const nextConnections = [
                    ...connectionsRef.current.filter((connection) => !requiredConnections.some((required) => required.fromNodeId === connection.fromNodeId && required.toNodeId === connection.toNodeId)),
                    ...requiredConnections,
                ];
                if (!await saveCanvasSnapshot(nextNodes, nextConnections)) throw new Error("复刻流程节点尚未保存，请重试");
                setSelectedNodeIds(new Set([resultNodeId]));
                setSelectedConnectionId(null);
                finishGenerationRequest(analysisNodeId, controller);
                await runCompetitorReplicationImage(resultNodeId);
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "竞品视觉分析失败";
                message.error(errorDetails);
                setNodes((current) => current.map((node) => node.id === analysisNodeId ? {
                    ...node,
                    metadata: { ...node.metadata, status: NODE_STATUS_ERROR, analysisStatus: "error", analysisError: errorDetails, errorDetails },
                } : node));
            } finally {
                finishGenerationRequest(analysisNodeId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, readOnly, runCompetitorReplicationImage, saveCanvasSnapshot, startGenerationRequest],
    );

    const startCompetitorReplication = useCallback(
        async (value: CompetitorReplicationDialogValue) => {
            if (readOnly) {
                message.warning("当前画布只读，请先接管编辑");
                return;
            }
            const sourceNode = nodesRef.current.find((node) => node.id === value.sourceNodeId);
            if (!sourceNode?.metadata?.content) {
                message.warning("当前商品图片为空，无法开始复刻");
                return;
            }
            const competitorSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const analysisSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const gap = 96;
            const rowGap = 28;
            const totalHeight = value.competitorImages.length * competitorSpec.height + Math.max(0, value.competitorImages.length - 1) * rowGap;
            const centerY = sourceNode.position.y + sourceNode.height / 2;
            const competitorX = sourceNode.position.x + sourceNode.width + gap;
            const competitorNodes = value.competitorImages.map((image, index): CanvasNodeData => {
                const size = fitNodeSize(image.width, image.height, competitorSpec.width, competitorSpec.height);
                return {
                    id: nanoid(),
                    type: CanvasNodeType.Image,
                    title: `竞品参考 ${index + 1}`,
                    position: {
                        x: competitorX,
                        y: centerY - totalHeight / 2 + index * (competitorSpec.height + rowGap) + (competitorSpec.height - size.height) / 2,
                    },
                    width: size.width,
                    height: size.height,
                    metadata: {
                        ...imageMetadata(image),
                        workflow: "competitor-visual-replication",
                        workflowRole: "competitor-reference",
                        sourceNodeId: sourceNode.id,
                        instruction: value.instruction,
                        includeBrand: value.includeBrand,
                        brandOverride: value.brandOverride,
                        includeText: value.includeText,
                        textOverride: value.textOverride,
                        includePackaging: value.includePackaging,
                    },
                };
            });
            const competitorReferenceNodeIds = competitorNodes.map((node) => node.id);
            const analysisNode: CanvasNodeData = {
                id: nanoid(),
                type: CanvasNodeType.Text,
                title: "竞品视觉策略分析",
                position: {
                    x: competitorX + competitorSpec.width + gap,
                    y: centerY - analysisSpec.height / 2,
                },
                width: analysisSpec.width,
                height: analysisSpec.height,
                metadata: {
                    content: "",
                    status: NODE_STATUS_LOADING,
                    fontSize: 14,
                    workflow: "competitor-visual-replication",
                    workflowRole: "analysis",
                    analysisStatus: "loading",
                    sourceNodeId: sourceNode.id,
                    competitorReferenceNodeIds,
                    instruction: value.instruction,
                    includeBrand: value.includeBrand,
                    brandOverride: value.brandOverride,
                    includeText: value.includeText,
                    textOverride: value.textOverride,
                    includePackaging: value.includePackaging,
                    model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                },
            };
            const nextNodes = [...nodesRef.current, ...competitorNodes, analysisNode];
            const nextConnections = [
                ...connectionsRef.current,
                ...competitorNodes.map((node) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: analysisNode.id })),
            ];
            setCompetitorReplicationNodeId(null);
            if (!await saveCanvasSnapshot(nextNodes, nextConnections)) {
                setNodes((current) => current.map((node) => node.id === analysisNode.id ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, analysisStatus: "error", analysisError: "复刻流程节点保存失败，请重试", errorDetails: "复刻流程节点保存失败，请重试" } } : node));
                return;
            }
            setSelectedNodeIds(new Set([analysisNode.id]));
            setSelectedConnectionId(null);
            await runCompetitorReplicationAnalysis(analysisNode.id);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message, readOnly, runCompetitorReplicationAnalysis, saveCanvasSnapshot],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (readOnly) return;
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await uploadImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, [readOnly]);

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (readOnly) return;
            if (!node.metadata?.content) return;
            setSplitNodeId(null);
            const pieces = await splitDataUrl(node.metadata.content, params);
            const gap = 16;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const childNodes = await Promise.all(
                pieces.map(async (piece) => {
                    const image = await uploadImage(piece.dataUrl);
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        title: `${node.title || "图片"} ${piece.row + 1}-${piece.column + 1}`,
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            prompt: node.metadata?.prompt,
                        },
                    } satisfies CanvasNodeData;
                }),
            );
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            message.success(`已切分为 ${childNodes.length} 个子节点`);
        },
        [message, readOnly],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (readOnly) return;
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1", size: node.metadata?.size || "auto" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const userPrompt = payload.prompt.trim();
            const prompt = `只修改蒙版透明区域，其他区域保持不变。${userPrompt}`;
            const childId = nanoid();
            const source = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
            setMaskEditNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: userPrompt.slice(0, 32) || "局部编辑结果",
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const requestOptions = await prepareImageRequestOptions(generationConfig, [{ nodeId: childId, slot: 0 }], controller.signal);
                const image = await requestEdit(generationConfig, prompt, [source], { id: `${node.id}-mask`, name: "mask.png", type: "image/png", dataUrl: payload.maskDataUrl }, requestOptions).then((items) => items[0]);
                const uploaded = await ensureUploadedImage(image);
                const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "局部修改失败";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, prepareImageRequestOptions, readOnly, startGenerationRequest],
    );

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (readOnly) return;
        if (!node.metadata?.content) return;
        setUpscaleNodeId(null);
        const upscaled = await upscaleDataUrl(node.metadata.content, params);
        const image = await uploadImage(upscaled);
        const size = fitNodeSize(image.width, image.height);
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Upscaled Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
    }, [readOnly]);

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (readOnly) return;
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [
                { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey },
            ]);
            setAngleNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const requestOptions = await prepareImageRequestOptions(generationConfig, [{ nodeId: childId, slot: 0 }], controller.signal);
                const image = await requestEdit(
                    generationConfig,
                    prompt,
                    [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }],
                    undefined,
                    requestOptions,
                ).then((items) => items[0]);
                const uploaded = await ensureUploadedImage(image);
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, openConfigDialog, prepareImageRequestOptions, readOnly, startGenerationRequest],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        if (readOnly) return;
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, [readOnly]);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        if (readOnly) return;
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, [readOnly]);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            if (readOnly) {
                event.target.value = "";
                return;
            }
            const files = Array.from(event.target.files || []).filter(
                (f) => f.type.startsWith("image/") || f.type.startsWith("video/") || isAudioFile(f),
            );
            if (!files.length) {
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }

            const target = uploadTargetRef.current;
            const basePosition =
                target?.position ||
                screenToCanvas(
                    (containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2,
                    (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2,
                );
            const STAGGER = 40; // 多文件时的偏移间距

            // 如果有替换目标节点，第一个文件替换它，其余在附近新建
            if (target?.nodeId) {
                const [first, ...rest] = files;

                // 第一个文件：替换目标节点
                if (isAudioFile(first)) {
                    const audio = await uploadMediaFile(first, "audio");
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Audio,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                                      width: spec.width,
                                      height: spec.height,
                                      metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else if (first.type.startsWith("video/")) {
                    const video = await uploadMediaFile(first, "video");
                    const nextSize = fitNodeSize(video.width || 1280, video.height || 720, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Video,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else {
                    const image = await uploadImage(first);
                    const s = fitImageNodeInitialSize(image.width, image.height);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Image,
                                      title: first.name,
                                      width: s.width,
                                      height: s.height,
                                      metadata: {
                                          ...node.metadata,
                                          ...imageMetadata(image),
                                          errorDetails: undefined,
                                          freeResize: false,
                                          isBatchRoot: undefined,
                                          batchRootId: undefined,
                                          batchChildIds: undefined,
                                          batchUsesReferenceImages: undefined,
                                          generationType: undefined,
                                          model: undefined,
                                          size: undefined,
                                          quality: undefined,
                                          count: undefined,
                                          references: undefined,
                                          primaryImageId: undefined,
                                          imageBatchExpanded: undefined,
                                      },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                }

                // 剩余文件：在目标节点附近新建
                for (let i = 0; i < rest.length; i++) {
                    const offsetPos = { x: basePosition.x + (i + 1) * STAGGER, y: basePosition.y + (i + 1) * STAGGER };
                    const f = rest[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            } else {
                // 无替换目标：所有文件在画布中心附近新建
                for (let i = 0; i < files.length; i++) {
                    const offsetPos = { x: basePosition.x + i * STAGGER, y: basePosition.y + i * STAGGER };
                    const f = files[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, readOnly, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            if (readOnly) return;
            event.preventDefault();
            const files = Array.from(event.dataTransfer.files).filter(
                (item) => item.type.startsWith("image/") || item.type.startsWith("video/") || isAudioFile(item),
            );
            if (!files.length) return;

            const basePos = screenToCanvas(event.clientX, event.clientY);
            const STAGGER = 40;
            for (let i = 0; i < files.length; i++) {
                const pos = { x: basePos.x + i * STAGGER, y: basePos.y + i * STAGGER };
                const f = files[i];
                if (isAudioFile(f)) {
                    void createAudioFileNode(f, pos);
                } else if (f.type.startsWith("video/")) {
                    void createVideoFileNode(f, pos);
                } else {
                    void createImageFileNode(f, pos);
                }
            }
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, readOnly, screenToCanvas],
    );

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || "未命名画布");
        setTitleEditing(true);
    }, [currentProject?.title]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (nextTitle) void renameProject(projectId, nextTitle).then((ok) => { if (!ok) message.error("画布当前不可编辑，名称未保存"); });
        setTitleEditing(false);
    }, [message, projectId, renameProject, titleDraft]);

    const takeOverCanvas = useCallback(async () => {
        const acquired = await acquireEditLease(projectId, true);
        if (!acquired) {
            message.warning(leaseState?.error || "当前画布仍由其他用户编辑，请稍后再试");
            return;
        }
        message.success("已接管画布编辑");
        if (["dirty", "error"].includes(useCanvasStore.getState().saveStates[projectId]?.status || "")) await flushProject(projectId);
    }, [acquireEditLease, flushProject, leaseState?.error, message, projectId]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => {
            if (readOnly) {
                message.warning("当前画布只读，请先接管编辑");
                return;
            }
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            const generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            // 插件节点声明了 useBuiltinPanel.writeBackToSelf:复用内置面板生成,但结果写回节点自身。
            // 目前支持 image 模式(全景等展示型节点),前缀由 useBuiltinPanel.promptPrefix 指定。
            const builtinPanel = sourceNode ? getNodeDefinition(sourceNode.type)?.useBuiltinPanel : undefined;
            if (sourceNode && builtinPanel?.writeBackToSelf && builtinPanel.mode === "image") {
                const scene = prompt.trim();
                if (!scene) return;
                setRunningNodeId(nodeId);
                const controller = startGenerationRequest(nodeId, nodeId, nodeId);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
                try {
                    const fullPrompt = (builtinPanel.promptPrefix || "") + scene;
                    const requestOptions = await prepareImageRequestOptions(generationConfig, [{ nodeId, slot: 0 }], controller.signal);
                    // 上游图片节点作为参考图(图生图);无上游则纯文生图
                    const upstreamNodes = connectionsRef.current
                        .filter((conn) => conn.toNodeId === nodeId)
                        .map((conn) => nodesRef.current.find((node) => node.id === conn.fromNodeId))
                        .filter((node): node is CanvasNodeData => Boolean(node));
                    const refs = upstreamNodes.flatMap((up) =>
                        typeof up.metadata?.content === "string" && up.metadata.content && up.type !== sourceNode.type
                            ? [{ id: up.id, name: `${up.title || up.id}.png`, type: up.metadata.mimeType || "image/png", dataUrl: up.metadata.content, storageKey: up.metadata.storageKey }]
                            : [],
                    );
                    const image = refs.length
                        ? await requestEdit({ ...generationConfig, count: "1" }, fullPrompt, refs, undefined, requestOptions).then((items) => items[0])
                        : await requestGeneration({ ...generationConfig, count: "1" }, fullPrompt, requestOptions).then((items) => items[0]);
                    const uploaded = await ensureUploadedImage(image);
                    setNodes((prev) =>
                        prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: scene, model: generationConfig.model, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)),
                    );
                    setDialogNodeId(null);
                } catch (error) {
                    if (!isGenerationCanceled(error)) {
                        const errorDetails = error instanceof Error ? error.message : "生成失败";
                        message.error(errorDetails);
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                    }
                } finally {
                    finishGenerationRequest(nodeId, controller);
                }
                return;
            }

            setRunningNodeId(nodeId);
            const runController = startGenerationRequest(nodeId, nodeId, nodeId);
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            const generationContext = await hydrateNodeGenerationContext(
                buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? `请根据要求修改以下文本。\n\n原文：\n${sourceTextContent}\n\n修改要求：\n${prompt}` : prompt),
            );
            const effectivePrompt = generationContext.prompt.trim();
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image && !editingTextNode;
            if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            let pendingChildIds: string[] = [];
            if (markSourceStatus) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...(node.type === CanvasNodeType.Config ? {} : { prompt }), status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));

            try {
                if (mode === "image") {
                    const count = getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const isEmptyImageNode = isImageNode && !sourceNode?.metadata?.content;
                    const sourceReference =
                        isImageNode && sourceNode?.metadata?.content
                            ? [{ id: sourceNode.id, name: `${sourceNode.title || sourceNode.id}.png`, type: sourceNode.metadata.mimeType || "image/png", dataUrl: sourceNode.metadata.content, storageKey: sourceNode.metadata.storageKey }]
                            : [];
                    const referenceImages = sourceReference.length ? sourceReference : generationContext.referenceImages;
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const gap = 96;
                    const rowGap = 36;
                    const rootId = isEmptyImageNode ? nodeId : nanoid();
                    const childIds = count > 1 ? Array.from({ length: count }, () => nanoid()) : [];
                    const targetIds = count > 1 ? childIds : [rootId];
                    pendingChildIds = isEmptyImageNode ? childIds : [rootId, ...childIds];
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: isEmptyImageNode ? parentPosition.x : parentPosition.x + parentConfig.width + gap,
                            y: parentPosition.y + parentConfig.height / 2 - imageConfig.height / 2,
                        },
                        width: isEmptyImageNode ? sourceNode?.width || imageConfig.width : imageConfig.width,
                        height: isEmptyImageNode ? sourceNode?.height || imageConfig.height : imageConfig.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            isBatchRoot: count > 1,
                            batchChildIds: count > 1 ? childIds : undefined,
                            batchUsesReferenceImages: referenceImages.length > 0,
                            ...generationMetadata,
                            imageBatchExpanded: count > 1 ? true : undefined,
                        },
                    };
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Image,
                        title: effectivePrompt.slice(0, 32) || "Generated Image",
                        position: {
                            x: rootNode.position.x + rootNode.width + 120 + (index % 2) * (imageConfig.width + 36),
                            y: rootNode.position.y + Math.floor(index / 2) * (imageConfig.height + rowGap),
                        },
                        width: imageConfig.width,
                        height: imageConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, batchRootId: count > 1 ? rootId : undefined, ...generationMetadata },
                    }));
                    const batchConnections = [...(isEmptyImageNode ? [] : [{ id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]), ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: rootId, toNodeId: childId }))];

                    const placeholderNodes = [
                        ...nodesRef.current.map((node) =>
                            node.id === nodeId
                                ? isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined },
                                      }
                                    : isEmptyImageNode
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: { ...node.metadata, ...rootNode.metadata, errorDetails: undefined },
                                        }
                                      : isImageNode
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                                          }
                                        : {
                                              ...node,
                                              type: CanvasNodeType.Text,
                                              title: prompt.slice(0, 32) || "Prompt",
                                              width: parentConfig.width,
                                              height: parentConfig.height,
                                              metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                          }
                                : node,
                        ),
                        ...(isEmptyImageNode ? [] : [rootNode]),
                        ...childNodes,
                    ];
                    const placeholderConnections = [...connectionsRef.current, ...batchConnections];
                    nodesRef.current = placeholderNodes;
                    connectionsRef.current = placeholderConnections;
                    setNodes(placeholderNodes);
                    setConnections(placeholderConnections);
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    const controller = runController;
                    targetIds.forEach((targetId) => startGenerationRequest(targetId, nodeId, nodeId, controller));
                    if (count > 1) startGenerationRequest(rootId, nodeId, nodeId, controller);
                    let hasSuccess = false;
                    let hasFailure = false;
                    let firstError = "";
                    if (resolveModelRequestConfig(generationConfig, generationConfig.model).source === "remote") {
                        let latestTask: ImageGenerationTask | undefined;
                        const clientRequestId = nanoid();
                        const bindings: Array<{ nodeId: string; slot?: number }> = [...targetIds.map((targetId, slot) => ({ nodeId: targetId, slot })), ...(count > 1 ? [{ nodeId: rootId, slot: 0 }] : []), ...(isConfigNode ? [{ nodeId }] : [])];
                        if (!await prepareImageTask(bindings, clientRequestId, placeholderNodes, placeholderConnections)) throw new Error("任务标识尚未保存，暂时无法提交生图任务");
                        const onTaskUpdate = (task: ImageGenerationTask) => {
                            latestTask = task;
                            setNodes((current) => applyCanvasImageTask(current.map((item) => {
                                const binding = bindings.find((value) => value.nodeId === item.id);
                                if (binding) return { ...item, metadata: { ...item.metadata, generationTaskId: task.id, generationClientRequestId: clientRequestId, generationSlot: binding.slot } };
                                return item;
                            }), task));
                        };
                        const options = { signal: controller.signal, clientRequestId, context: { origin: "canvas", canvasId: projectId, bindings }, onTaskUpdate };
                        try {
                            if (referenceImages.length) await requestEdit({ ...generationConfig, count: String(count) }, effectivePrompt, referenceImages, undefined, options);
                            else await requestGeneration({ ...generationConfig, count: String(count) }, effectivePrompt, options);
                        } catch (error) {
                            if (!isGenerationCanceled(error)) {
                                const errorDetails = error instanceof Error ? error.message : "生成失败";
                                message.error(errorDetails);
                                setNodes((current) => current.map((item) => bindings.some((binding) => binding.nodeId === item.id) ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item));
                            }
                        } finally {
                            targetIds.forEach((targetId) => finishGenerationRequest(targetId, controller));
                            if (count > 1) finishGenerationRequest(rootId, controller);
                        }
                        if (latestTask?.status === "partial") message.error("部分图片生成失败");
                        if (isConfigNode) setNodes((current) => current.map((item) => item.id === nodeId ? { ...item, metadata: { ...item.metadata, status: latestTask?.status === "failed" ? NODE_STATUS_ERROR : NODE_STATUS_SUCCESS, errorDetails: latestTask?.status === "failed" ? latestTask.error || "生成失败" : undefined } } : item));
                        return;
                    }
                    await Promise.all(
                        targetIds.map(async (targetId) => {
                            try {
                                const image = referenceImages.length
                                    ? await requestEdit({ ...generationConfig, count: "1" }, effectivePrompt, referenceImages, undefined, { signal: controller.signal }).then((items) => items[0])
                                    : await requestGeneration({ ...generationConfig, count: "1" }, effectivePrompt, { signal: controller.signal }).then((items) => items[0]);
                                const uploaded = await ensureUploadedImage(image);
                                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.height);
                                setNodes((prev) => {
                                    const root = prev.find((node) => node.id === rootId);
                                    return prev.map((node) => {
                                        if (node.id !== targetId && node.id !== rootId) return node;
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        if (node.id === rootId && (targetId === rootId || !root?.metadata?.primaryImageId))
                                            return {
                                                ...node,
                                                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { ...node.metadata, ...imageMetadata(uploaded), primaryImageId: targetId },
                                            };
                                        if (node.id === targetId)
                                            return {
                                                ...node,
                                                position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                                width: imageSize.width,
                                                height: imageSize.height,
                                                metadata: { ...node.metadata, ...imageMetadata(uploaded) },
                                            };
                                        return node;
                                    });
                                });
                                hasSuccess = true;
                                if (isConfigNode) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                                return true;
                            } catch (error) {
                                if (isGenerationCanceled(error)) return false;
                                const errorDetails = error instanceof Error ? error.message : "生成失败";
                                if (!firstError) firstError = errorDetails;
                                hasFailure = true;
                                setNodes((prev) => prev.map((node) => (node.id === targetId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                            } finally {
                                finishGenerationRequest(targetId, controller);
                            }
                            return false;
                        }),
                    );
                    if (count > 1) finishGenerationRequest(rootId, controller);
                    if (controller.signal.aborted) {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId && isConfigNode && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
                        return;
                    }
                    if (hasFailure) {
                        message.error(hasSuccess ? "部分图片生成失败" : firstError || "生成失败");
                    }
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : "生成失败" } }
                                : node.id === nodeId && isEmptyImageNode
                                  ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : "生成失败" } }
                                  : node.id === rootId && !hasSuccess && !targetIds.includes(node.id)
                                    ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails: "全部图片生成失败" } }
                                    : node,
                        ),
                    );
                    return;
                }

                if (mode === "video") {
                    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                    const videoId = isEmptyVideoNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: effectivePrompt.slice(0, 32) || "Generated Video",
                        position: isEmptyVideoNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                        width: isEmptyVideoNode ? sourceNode.width : spec.width,
                        height: isEmptyVideoNode ? sourceNode.height : spec.height,
                        metadata: {
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            model: generationConfig.model,
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            references: generationReferenceUrls(generationContext),
                        },
                    };
                    pendingChildIds = [videoId];
                    setNodes((prev) =>
                        isEmptyVideoNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
                    );
                    if (!isEmptyVideoNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: videoId }]);
                    const controller = startGenerationRequest(videoId, nodeId, nodeId, runController);
                    try {
                        const video = await storeGeneratedVideo(
                            await requestVideoGeneration(generationConfig, effectivePrompt, generationContext.referenceImages, generationContext.referenceVideos, generationContext.referenceAudios, { signal: controller.signal }),
                        );
                        const videoSize = fitNodeSize(video.width || spec.width, video.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                        setNodes((prev) =>
                            prev.map((node) =>
                                node.id === videoId
                                    ? {
                                          ...node,
                                          width: videoSize.width,
                                          height: videoSize.height,
                                          position: { x: node.position.x + node.width / 2 - videoSize.width / 2, y: node.position.y + node.height / 2 - videoSize.height / 2 },
                                          metadata: {
                                              ...node.metadata,
                                              ...videoMetadata(video),
                                              prompt: effectivePrompt,
                                              model: generationConfig.model,
                                              size: generationConfig.size,
                                              seconds: generationConfig.videoSeconds,
                                              vquality: generationConfig.vquality,
                                              generateAudio: generationConfig.videoGenerateAudio,
                                              watermark: generationConfig.videoWatermark,
                                              references: generationReferenceUrls(generationContext),
                                          },
                                      }
                                    : node,
                            ),
                        );
                    } finally {
                        finishGenerationRequest(videoId, controller);
                    }
                    return;
                }

                if (mode === "audio") {
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    const isEmptyAudioNode = sourceNode?.type === CanvasNodeType.Audio && !sourceNode.metadata?.content;
                    const audioId = isEmptyAudioNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const audioNode: CanvasNodeData = {
                        id: audioId,
                        type: CanvasNodeType.Audio,
                        title: effectivePrompt.slice(0, 32) || "Generated Audio",
                        position: isEmptyAudioNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 },
                        width: isEmptyAudioNode ? sourceNode.width : spec.width,
                        height: isEmptyAudioNode ? sourceNode.height : spec.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, ...buildAudioGenerationMetadata(generationConfig) },
                    };
                    pendingChildIds = [audioId];
                    setNodes((prev) =>
                        isEmptyAudioNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...audioNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode],
                    );
                    if (!isEmptyAudioNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: audioId }]);
                    const controller = startGenerationRequest(audioId, nodeId, nodeId, runController);
                    try {
                        const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, effectivePrompt, { signal: controller.signal }), generationConfig.audioFormat);
                        setNodes((prev) => prev.map((node) => (node.id === audioId ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt: effectivePrompt, ...buildAudioGenerationMetadata(generationConfig) } } : node)));
                    } finally {
                        finishGenerationRequest(audioId, controller);
                    }
                    return;
                }

                let streamed = "";
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = isConfigNode ? getGenerationCount(generationConfig.count) : 1;
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const childIds = isConfigNode || editingTextNode ? Array.from({ length: textCount }, () => nanoid()) : [];
                pendingChildIds = childIds;
                if (isConfigNode || editingTextNode) {
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Text,
                        title: effectivePrompt.slice(0, 32) || "Generated Text",
                        position: {
                            x: parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 + (index - (textCount - 1) / 2) * (textConfig.height + 36),
                        },
                        width: textConfig.width,
                        height: textConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, fontSize: 14, model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort },
                    }));
                    setNodes((prev) => [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), ...childNodes]);
                    setConnections((prev) => [...prev, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: childId }))]);
                }

                const controller = runController;
                const textTargetIds = childIds.length ? childIds : [nodeId];
                textTargetIds.forEach((targetNodeId) => startGenerationRequest(targetNodeId, nodeId, nodeId, controller));
                const answers = await Promise.all(
                    textTargetIds.map((targetNodeId) => {
                        let localStreamed = "";
                        return requestImageQuestion(
                            generationConfig,
                            buildNodeResponseMessages({ ...generationContext, prompt: effectivePrompt }),
                            (text) => {
                                localStreamed = text;
                                streamed = text;
                                if (isConfigNode) return;
                                setNodes((prev) => prev.map((node) => (node.id === targetNodeId ? { ...node, type: CanvasNodeType.Text, metadata: { ...node.metadata, content: text, status: NODE_STATUS_LOADING } } : node)));
                            },
                            { signal: controller.signal },
                        )
                            .then((answer) => ({ nodeId: targetNodeId, content: answer || localStreamed }))
                            .finally(() => finishGenerationRequest(targetNodeId, controller));
                    }),
                );
                if (controller.signal.aborted) return;
                const answerByNodeId = new Map(answers.map((item) => [item.nodeId, item.content]));
                setNodes((prev) =>
                    prev.map((node) =>
                        childIds.includes(node.id)
                            ? { ...node, metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS } }
                            : node.id === nodeId && isConfigNode
                              ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } }
                              : node.id === nodeId && !editingTextNode
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Text,
                                      title: prompt.slice(0, 32) || "Generated Text",
                                      metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort, status: NODE_STATUS_SUCCESS },
                                  }
                                : node,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } }) : node)),
                );
            } finally {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, prepareImageRequestOptions, prepareImageTask, readOnly, startGenerationRequest],
    );
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData) => {
            if (readOnly) {
                message.warning("当前画布只读，请先接管编辑");
                return;
            }
            if (node.metadata?.workflow === "competitor-visual-replication") {
                if (node.metadata.workflowRole === "analysis") {
                    await runCompetitorReplicationAnalysis(node.id);
                    return;
                }
                if (node.metadata.workflowRole === "result") {
                    await runCompetitorReplicationImage(node.id);
                    return;
                }
            }
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const batchRoot = node.metadata?.batchRootId ? nodesRef.current.find((item) => item.id === node.metadata?.batchRootId) : null;
            const savedImageMetadata = node.type === CanvasNodeType.Image ? { ...batchRoot?.metadata, ...node.metadata } : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.size,
                          background: savedImageMetadata.background ?? effectiveConfig.background,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const context = hasSavedImageMetadata ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
            const prompt = (savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!prompt) {
                message.warning("找不到提示词，无法重试");
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages =
                hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(batchRoot || sourceNode)) : [];
            if (useReferenceImages && !retryReferenceImages) {
                message.error("参考图片已丢失，无法继续重试");
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails: "参考图片已丢失，无法继续重试" } } : item)));
                return;
            }
            const retryImages = retryReferenceImages || [];

            setRunningNodeId(node.id);
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : item)));
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id);

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    let streamed = "";
                    const answer = await requestImageQuestion(
                        generationConfig,
                        buildNodeResponseMessages({ ...context, prompt }),
                        (text) => {
                            streamed = text;
                            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                        },
                        { signal: controller.signal },
                    );
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    const video = await storeGeneratedVideo(await requestVideoGeneration(generationConfig, prompt, retryImages, context?.referenceVideos || [], context?.referenceAudios || [], { signal: controller.signal }));
                    const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                    setNodes((prev) =>
                        prev.map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      width: videoSize.width,
                                      height: videoSize.height,
                                      position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                      metadata: {
                                          ...item.metadata,
                                          ...videoMetadata(video),
                                          prompt,
                                          model: generationConfig.model,
                                          size: generationConfig.size,
                                          seconds: generationConfig.videoSeconds,
                                          vquality: generationConfig.vquality,
                                          generateAudio: generationConfig.videoGenerateAudio,
                                          watermark: generationConfig.videoWatermark,
                                      },
                                  }
                                : item,
                        ),
                    );
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, prompt, { signal: controller.signal }), generationConfig.audioFormat);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig) } } : item)));
                    return;
                }

                const requestOptions = await prepareImageRequestOptions(generationConfig, [{ nodeId: node.id, slot: 0 }], controller.signal);
                const image = useReferenceImages
                    ? await requestEdit(generationConfig, prompt, retryImages, undefined, requestOptions).then((items) => items[0])
                    : await requestGeneration(generationConfig, prompt, requestOptions).then((items) => items[0]);
                const uploadedImage = await ensureUploadedImage(image);
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const imageSize = fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.height);
                const generationMetadata = savedImageMetadata?.generationType
                    ? {
                          generationType: savedImageMetadata.generationType,
                          model: generationConfig.model,
                          size: generationConfig.size,
                          quality: generationConfig.quality,
                          ...(generationConfig.background ? { background: generationConfig.background } : {}),
                          count: savedImageMetadata.count || 1,
                          references: savedImageMetadata.references,
                      }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((prev) =>
                    prev.map((item) =>
                        item.id === node.id
                            ? {
                                  ...item,
                                  type: CanvasNodeType.Image,
                                  width: imageSize.width,
                                  height: imageSize.height,
                                  metadata: { ...item.metadata, ...imageMetadata(uploadedImage), prompt, ...generationMetadata },
                              }
                            : item,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = error instanceof Error ? error.message : "生成失败";
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, prepareImageRequestOptions, readOnly, runCompetitorReplicationAnalysis, runCompetitorReplicationImage, startGenerationRequest],
    );

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning("文本节点为空，无法生图");
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.size,
                    count: getGenerationCount(effectiveConfig.canvasImageCount || effectiveConfig.count),
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.canvasImageCount, effectiveConfig.count, effectiveConfig.imageModel, effectiveConfig.model, effectiveConfig.size, message],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage & { productId?: string }) => {
            if (readOnly) return;
            const storedImage = image.storageKey ? { url: image.dataUrl, thumbnailUrl: imageThumbnailUrl(image.storageKey, image.dataUrl), storageKey: image.storageKey, width: 1, height: 1, bytes: 0, mimeType: "image/png" } : await uploadImage(image.dataUrl);
            const meta = storedImage.width === 1 && storedImage.height === 1 ? await readImageMeta(storedImage.url) : storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt.slice(0, 32) || "Generated Image",
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt, ...(image.productId ? { productId: image.productId } : {}) },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [readOnly, screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string, title?: string) => {
            if (readOnly) return;
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: title || text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [readOnly, screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        (payload: InsertAssetPayload) => {
            if (readOnly) {
                message.warning("当前画布只读，请先接管编辑");
                return;
            }
            if (payload.kind === "text") {
                insertAssistantText(payload.content, payload.title);
            } else if (payload.kind === "video") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const nextSize = fitNodeSize(payload.width || spec.width, payload.height || spec.height, VIDEO_NODE_MAX_WIDTH, VIDEO_NODE_MAX_HEIGHT);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Video,
                        title: payload.title,
                        position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                        width: nextSize.width,
                        height: nextSize.height,
                        metadata: { content: payload.url, thumbnail: payload.thumbnailUrl, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
            } else {
                insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey, productId: payload.productId });
            }
            setAssetPickerOpen(false);
        },
        [insertAssistantImage, insertAssistantText, message, readOnly, screenToCanvas, size.height, size.width],
    );

    // --- 传给 CanvasNode 的回调/渲染函数统一 memo 化 ---
    // CanvasNode 是 React.memo,但只要这些 prop 每次渲染都是新引用,memo 就失效,
    // 导致点击/悬停/移动视角时全部节点跟着重渲染(markdown 尤其明显)。全部 useCallback 后,
    // 未变化的节点不再重渲染。依赖里的 map/handler 均已 memo 化,纯交互时保持稳定。
    const handleNodeHoverStart = useCallback((nodeId: string) => {
        if (nodeDraggingRef.current) return;
        setHoveredNodeId(nodeId);
    }, []);
    const handleNodeHoverEnd = useCallback((nodeId: string) => {
        setHoveredNodeId((current) => (current === nodeId ? null : current));
    }, []);
    const handleNodeViewImage = useCallback((node: CanvasNodeData) => setPreviewNodeId(node.id), []);
    const handleNodeRetry = useCallback((node: CanvasNodeData) => void handleRetryNode(node), [handleRetryNode]);
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, []);

    const renderNodePanel = useCallback(
        (panelNode: CanvasNodeData) =>
            getNodeDefinition(panelNode.type)?.Panel ? (
                renderPluginPanel(panelNode)
            ) : panelNode.type === CanvasNodeType.Config ? (
                <CanvasConfigComposer
                    value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                    inputs={configInputsById.get(panelNode.id) || []}
                    onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                    onClose={() => setDialogNodeId(null)}
                />
            ) : (
                <CanvasNodePromptPanel
                    node={panelNode}
                    isRunning={runningNodeId === panelNode.id}
                    mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_REFERENCES}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handleGenerateNode}
                    onStop={confirmStopGeneration}
                    modeOverride={getNodeDefinition(panelNode.type)?.useBuiltinPanel?.mode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            ),
        [configInputsById, confirmStopGeneration, handleConfigNodeChange, handleGenerateNode, handleNodePromptChange, mentionReferencesByNodeId, renderPluginPanel, runningNodeId],
    );

    const renderNodeContentPanel = useCallback(
        (contentNode: CanvasNodeData) => (
            <CanvasConfigNodePanel
                node={contentNode}
                isRunning={runningNodeId === contentNode.id}
                inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                onConfigChange={handleConfigNodeChange}
                onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                onStop={confirmStopGeneration}
                onGenerate={(nodeId) => {
                    const target = nodesRef.current.find((item) => item.id === nodeId);
                    void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                }}
            />
        ),
        [configInputsById, confirmStopGeneration, handleConfigNodeChange, handleGenerateNode, runningNodeId],
    );

    if (!projectLoaded) return <CanvasRefreshShell />;

    return (
        <main className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <CanvasSidePanel nodes={nodes} selectedNodeIds={selectedNodeIds} ownerId={currentProject?.ownerId || ""} readOnly={readOnly} onFocusNode={focusNode} onPreviewNode={setPreviewNodeId} onInsertAsset={handleAssetInsert} />
            <section className="relative min-w-0 flex-1 overflow-hidden">
                <CanvasTopBar
                    title={currentProject?.title || "未命名画布"}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={() => setTitleEditing(false)}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    onHome={() => navigate("/")}
                    onProjects={() => navigate("/canvas")}
                    onCreateProject={createAndOpenProject}
                    onDeleteProject={deleteCurrentProject}
                    onExportProject={exportCurrentProject}
                    onImportImage={() => handleUploadRequest()}
                    onOpenPlugins={() => setPluginManagerOpen(true)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    readOnly={readOnly}
                    leaseState={leaseState}
                    onTakeover={() => void takeOverCanvas()}
                    canTakeover={currentProject?.accessLevel === "edit" && !["blocked", "acquiring"].includes(leaseState?.status || "")}
                />

                <InfiniteCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    backgroundMode={backgroundMode}
                    onViewportChange={(next) => {
                        setViewport(next);
                        setContextMenu(null);
                    }}
                    onCanvasMouseDown={handleCanvasMouseDown}
                    onCanvasDeselect={deselectCanvas}
                    onCanvasDoubleClick={(event) => {
                        setContextMenu(null);
                        setNodeCreatePosition(screenToCanvas(event.clientX, event.clientY));
                    }}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                    readOnly={readOnly}
                >
                    <svg className="absolute left-0 top-0 h-[10000px] w-[10000px] overflow-visible" style={{ pointerEvents: "none", transform: "translateZ(0)", zIndex: 0 }}>
                        {connections
                            .filter((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                return Boolean(from && to && !isHiddenBatchConnectionEndpoint(from, nodes) && !isHiddenBatchConnectionEndpoint(to, nodes));
                            })
                            .map((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                if (!from || !to) return null;

                                return (
                                    <ConnectionPath
                                        key={connection.id}
                                        connection={connection}
                                        from={from}
                                        to={to}
                                        active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                        onSelect={() => {
                                            setSelectedConnectionId(connection.id);
                                            setSelectedNodeIds(new Set());
                                            setContextMenu(null);
                                        }}
                                        onContextMenu={(event) => {
                                            setSelectedConnectionId(connection.id);
                                            setSelectedNodeIds(new Set());
                                            setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId: connection.id });
                                        }}
                                    />
                                );
                            })}
                        {connectingParams ? <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined} /> : null}
                    </svg>

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            readOnly={readOnly}
                            scale={viewport.k}
                            getViewportFrame={getCanvasViewportFrame}
                            isSelected={selectedNodeIds.has(node.id)}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            editRequestNonce={editingNodeId === node.id ? editRequestNonce : 0}
                            showPanel={dialogNodeId === node.id && !selectionBox && !getNodeDefinition(node.type)?.hidePanel}
                            batchCount={batchChildCountById.get(node.id) || 0}
                            groupChildCount={groupChildCountById.get(node.id) || 0}
                            isGroupDropTarget={dropTargetGroupId === node.id}
                            batchExpanded={Boolean(node.metadata?.imageBatchExpanded)}
                            batchClosing={Boolean(node.metadata?.batchRootId && collapsingBatchIds.has(node.metadata.batchRootId))}
                            batchOpening={openingBatchIds.has(node.id)}
                            batchRecovering={collapsingBatchIds.has(node.id)}
                            batchMotion={batchMotionById.get(node.id)}
                            showImageInfo={showImageInfo}
                            mentionReferences={mentionReferencesByNodeId.get(node.id) || EMPTY_REFERENCES}
                            pluginHost={pluginHost}
                            registryVersion={nodeRegistryVersion}
                            renderPanel={renderNodePanel}
                            renderNodeContent={renderNodeContentPanel}
                            onMouseDown={handleNodeMouseDown}
                            onSelectCapture={handleNodeSelectCapture}
                            onHoverStart={handleNodeHoverStart}
                            onHoverEnd={handleNodeHoverEnd}
                            onConnectStart={handleConnectStart}
                            onResize={handleNodeResize}
                            onContentChange={handleNodeContentChange}
                            onContentEditingChange={handleContentEditingChange}
                            onTitleChange={handleNodeTitleChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onRetry={handleNodeRetry}
                            onGenerateImage={generateImageFromTextNode}
                            onViewImage={handleNodeViewImage}
                            onContextMenu={handleNodeContextMenu}
                        />
                    ))}

                    {selectionBox ? (
                        <div
                            className="pointer-events-none absolute z-[100] border"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                                borderColor: theme.canvas.selectionStroke,
                                background: theme.canvas.selectionFill,
                            }}
                        />
                    ) : null}
                    {!readOnly && pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {!readOnly && nodeCreatePosition ? (
                        <NodeCreateMenu
                            position={nodeCreatePosition}
                            onCreate={(type) => {
                                createNode(type, nodeCreatePosition);
                                setNodeCreatePosition(null);
                            }}
                            onClose={() => setNodeCreatePosition(null)}
                        />
                    ) : null}
                </InfiniteCanvas>

                {!readOnly ? <CanvasNodeHoverToolbar
                    node={isNodeDragging || nodeImageSettingsOpen || editingNodeId ? null : toolbarNode}
                    viewport={viewport}
                    extraTools={toolbarNode ? buildNodeToolbarItems(toolbarNode) : undefined}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onEditText={openTextEditor}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onDownload={downloadNodeImage}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onViewImage={(node) => setPreviewNodeId(node.id)}
                    onReversePrompt={createImageReversePromptNodes}
                    onRetry={(node) => void handleRetryNode(node)}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                /> : null}

                {!readOnly ? <CanvasToolbar
                    selectedCount={selectedNodeIds.size}
                    canUndo={historyState.canUndo}
                    canRedo={historyState.canRedo}
                    backgroundMode={backgroundMode}
                    showImageInfo={showImageInfo}
                    onAddImage={() => createNode(CanvasNodeType.Image)}
                    onAddVideo={() => createNode(CanvasNodeType.Video)}
                    onAddAudio={() => createNode(CanvasNodeType.Audio)}
                    onAddText={() => createNode(CanvasNodeType.Text)}
                    onAddConfig={() => createNode(CanvasNodeType.Config)}
                    onAddGroup={() => createNode(CanvasNodeType.Group)}
                    onAddExtensionNode={(type) => createNode(type)}
                    onUndo={undoCanvas}
                    onRedo={redoCanvas}
                    onUpload={() => handleUploadRequest()}
                    onDelete={() => deleteNodes(new Set(selectedNodeIds))}
                    onClear={() => setClearConfirmOpen(true)}
                    onDeselect={deselectCanvas}
                    onBackgroundModeChange={setBackgroundMode}
                    onShowImageInfoChange={setShowImageInfo}
                /> : null}

                {isMiniMapOpen ? <Minimap nodes={nodes} viewport={viewport} viewportSize={size} onViewportChange={setViewport} /> : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={() => setIsMiniMapOpen((value) => !value)} />

                {!readOnly && contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        nodeType={contextMenu.type === "node" ? nodeById.get(contextMenu.nodeId)?.type : undefined}
                        onClose={() => setContextMenu(null)}
                        onStartCompetitorReplication={(nodeId) => {
                            const node = nodeById.get(nodeId);
                            setContextMenu(null);
                            if (!node?.metadata?.content) {
                                message.warning("当前图片节点为空，无法开始竞品视觉复刻");
                                return;
                            }
                            setCompetitorReplicationNodeId(nodeId);
                        }}
                        onStartDetailPageReplication={startDetailPageReplication}
                        onStartMainImageReplication={startMainImageReplication}
                        onPlaceholder={(label) => {
                            setContextMenu(null);
                            message.info(`${label}功能暂未开放`);
                        }}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDelete={() => {
                            if (contextMenu.type === "node") {
                                deleteNodes(new Set([contextMenu.nodeId]));
                            } else {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />

                <CanvasNodeInfoModal node={infoNode} open={Boolean(infoNode)} onClose={() => setInfoNodeId(null)} />
                <CanvasPluginManagerModal open={pluginManagerOpen} onClose={() => setPluginManagerOpen(false)} />

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {maskEditNode?.metadata?.content ? (
                    <CanvasNodeMaskEditDialog dataUrl={maskEditNode.metadata.content} open={Boolean(maskEditNode)} onClose={() => setMaskEditNodeId(null)} onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)} />
                ) : null}

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {upscaleNode?.metadata?.content ? (
                    <CanvasNodeUpscaleDialog dataUrl={upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} />
                ) : null}

                <Modal title="AI 超分" open={Boolean(superResolveNode?.metadata?.content)} centered footer={null} onCancel={() => setSuperResolveNodeId(null)}>
                    <div className="py-8 text-center text-base font-medium">暂未实现</div>
                </Modal>

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                {competitorReplicationNode?.metadata?.content ? (
                    <CanvasCompetitorReplicationDialog
                        open={Boolean(competitorReplicationNode)}
                        sourceNodeId={competitorReplicationNode.id}
                        sourceImageUrl={imageThumbnailUrl(competitorReplicationNode.metadata.storageKey, competitorReplicationNode.metadata.thumbnail || competitorReplicationNode.metadata.content)}
                        ownerId={currentProject?.ownerId || ""}
                        onClose={() => setCompetitorReplicationNodeId(null)}
                        onConfirm={startCompetitorReplication}
                    />
                ) : null}

                <CanvasProductPickerModal
                    open={Boolean(detailPageSourceNodeId)}
                    ownerId={currentProject?.ownerId || ""}
                    productId={detailPageSourceNodeId ? nodesRef.current.find((node) => node.id === detailPageSourceNodeId)?.metadata?.productId : undefined}
                    onClose={() => setDetailPageSourceNodeId(null)}
                    onSelect={continueDetailPageReplication}
                />
                <CanvasProductPickerModal
                    open={Boolean(mainImageSourceNodeId)}
                    ownerId={currentProject?.ownerId || ""}
                    productId={mainImageSourceNodeId ? nodesRef.current.find((node) => node.id === mainImageSourceNodeId)?.metadata?.productId : undefined}
                    onClose={() => setMainImageSourceNodeId(null)}
                    onSelect={continueMainImageReplication}
                />

                <Modal
                    title={previewNode?.type === CanvasNodeType.Video ? "视频预览" : "图片详情"}
                    open={Boolean(previewNode?.metadata?.content)}
                    centered
                    onCancel={() => setPreviewNodeId(null)}
                    footer={null}
                    width="auto"
                    styles={{ body: { padding: 0, display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "80vh" } }}
                >
                    {previewNode?.metadata?.content
                        ? previewNode.type === CanvasNodeType.Video
                            ? <video src={previewNode.metadata.content} controls autoPlay playsInline className="max-h-[80vh] max-w-full" />
                            : <img src={previewNode.metadata.content} alt={previewNode.title || "图片"} style={{ maxWidth: "100%", maxHeight: "80vh", objectFit: "contain" }} />
                        : null}
                </Modal>

                <Modal
                    title="清空画布？"
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>取消</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                清空
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">这会删除当前画布上的所有节点和连线。</p>
                </Modal>

                <AssetPickerModal open={assetPickerOpen} onInsert={handleAssetInsert} onClose={() => setAssetPickerOpen(false)} />
            </section>
        </main>
    );
}
