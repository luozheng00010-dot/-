import type { NavigateFunction } from "react-router-dom";

import { toolName } from "@/components/agent/agent-event-formatters";
import { isSiteTool, runSiteTool } from "@/lib/agent/agent-site-tools";
import type { CanvasAgentOp, CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { imageMetadata } from "@/lib/canvas/canvas-node-factory";
import { fitNodeSize } from "@/lib/canvas/canvas-node-size";
import { uploadImage } from "@/services/image-storage";
import { useAgentStore, type AgentAttachment } from "@/stores/use-agent-store";
import type { CanvasNodeData, CanvasNodeMetadata, CanvasNodeTypeId, ViewportTransform } from "@/types/canvas";

export type ApiAgentToolDefinition = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties: boolean };
    };
};

const stringSchema = { type: "string" };
const numberSchema = { type: "number" };
const booleanSchema = { type: "boolean" };
const stringArraySchema = { type: "array", items: stringSchema };
const objectSchema = { type: "object", additionalProperties: true };
const objectArraySchema = { type: "array", items: objectSchema };
const generationModeSchema = { type: "string", enum: ["text", "image", "video", "audio"] };
const viewportSchema = { type: "object", properties: { x: numberSchema, y: numberSchema, k: numberSchema }, required: ["x", "y", "k"], additionalProperties: false };

function define(name: string, description: string, properties: Record<string, unknown> = {}, required?: string[]): ApiAgentToolDefinition {
    return {
        type: "function",
        function: {
            name,
            description,
            parameters: { type: "object", properties, ...(required?.length ? { required } : {}), additionalProperties: true },
        },
    };
}

export const API_AGENT_TOOLS: ApiAgentToolDefinition[] = [
    define("site_navigate", "跳转站内页面。path 支持 /、/canvas、/canvas/:id、/image、/video、/products、/prompts、/assets、/config。", { path: stringSchema }, ["path"]),
    define("canvas_list_projects", "分页列出用户画布，可按 keyword 搜索。", { keyword: stringSchema, page: numberSchema, pageSize: numberSchema }),
    define("canvas_get_state", "读取当前画布的精简节点、连线、选区和视口。"),
    define("canvas_get_selection", "读取当前画布选中的节点。"),
    define("canvas_export_snapshot", "导出当前画布精简快照。"),
    define("canvas_apply_ops", "批量执行画布操作，支持 add_node、update_node、delete_node、delete_connections、connect_nodes、set_viewport、select_nodes、run_generation。", { ops: objectArraySchema }, ["ops"]),
    define("canvas_create_node", "创建 text、image、config、video 或 audio 节点。", { nodeType: { type: "string", enum: ["text", "image", "config", "video", "audio"] }, title: stringSchema, x: numberSchema, y: numberSchema, width: numberSchema, height: numberSchema, metadata: objectSchema }, ["nodeType"]),
    define("canvas_create_attachment_nodes", "把当前用户消息中的图片附件添加为真实图片节点。", { attachmentIds: stringArraySchema, x: numberSchema, y: numberSchema, gap: numberSchema, direction: { type: "string", enum: ["row", "column"] } }, ["attachmentIds"]),
    define("canvas_create_text_node", "创建单个文本节点。", { text: stringSchema, title: stringSchema, x: numberSchema, y: numberSchema, width: numberSchema, height: numberSchema }),
    define("canvas_create_text_nodes", "批量创建文本节点。", { items: objectArraySchema, x: numberSchema, y: numberSchema, gap: numberSchema, direction: { type: "string", enum: ["row", "column"] } }, ["items"]),
    define("canvas_create_config_node", "创建文本、图片、视频或音频生成配置节点，可用 autoRun 立即生成。", generationProperties()),
    define("canvas_create_image_prompt_flow", "创建提示词文本节点和图片生成配置节点，自动连接，可立即生图。", generationProperties({ prompt: stringSchema, referenceNodeIds: stringArraySchema }), ["prompt"]),
    define("canvas_create_generation_flow", "创建通用生成流程，包括提示词、配置节点和参考节点连线。", generationProperties({ prompt: stringSchema, referenceNodeIds: stringArraySchema }), ["prompt"]),
    define("canvas_generate_text", "创建文本生成流程并立即运行。", generationProperties({ prompt: stringSchema, referenceNodeIds: stringArraySchema }), ["prompt"]),
    define("canvas_generate_image", "创建图片生成流程并立即运行。", generationProperties({ prompt: stringSchema, referenceNodeIds: stringArraySchema }), ["prompt"]),
    define("canvas_generate_video", "创建视频生成流程并立即运行。", generationProperties({ prompt: stringSchema, referenceNodeIds: stringArraySchema }), ["prompt"]),
    define("canvas_generate_audio", "创建音频生成流程并立即运行。", generationProperties({ prompt: stringSchema, referenceNodeIds: stringArraySchema }), ["prompt"]),
    define("canvas_update_node", "更新节点基础字段或 metadata。", { id: stringSchema, patch: objectSchema, metadata: objectSchema }, ["id"]),
    define("canvas_update_node_text", "更新文本节点内容和标题。", { id: stringSchema, text: stringSchema, title: stringSchema }, ["id", "text"]),
    define("canvas_move_nodes", "批量移动节点，支持绝对 x/y 或相对 dx/dy。", { items: objectArraySchema }, ["items"]),
    define("canvas_resize_node", "调整节点尺寸。", { id: stringSchema, width: numberSchema, height: numberSchema, freeResize: booleanSchema }, ["id", "width", "height"]),
    define("canvas_delete_nodes", "删除节点及相关连线。", { ids: stringArraySchema }, ["ids"]),
    define("canvas_connect_nodes", "批量连接节点。", { connections: objectArraySchema }, ["connections"]),
    define("canvas_select_nodes", "设置当前选中节点。", { ids: stringArraySchema }, ["ids"]),
    define("canvas_set_viewport", "设置画布视口。", { viewport: viewportSchema }, ["viewport"]),
    define("canvas_run_generation", "触发指定节点的文本、图片、视频或音频生成。", { nodeId: stringSchema, mode: generationModeSchema, prompt: stringSchema }, ["nodeId"]),
    define("generation_get_status", "查询画布、生图工作台或视频工作台任务状态。", { scope: { type: "string", enum: ["all", "canvas", "image", "video"] }, taskId: stringSchema, nodeIds: stringArraySchema, limit: numberSchema }),
    define("workbench_image_get_config", "读取生图工作台当前配置。"),
    define("workbench_image_generate", "打开生图工作台、填入参数并可立即生成。", { prompt: stringSchema, model: stringSchema, quality: stringSchema, size: stringSchema, count: numberSchema, run: booleanSchema }, ["prompt"]),
    define("workbench_video_get_config", "读取视频创作台当前配置。"),
    define("workbench_video_generate", "打开视频创作台、填入参数并可立即生成。", { prompt: stringSchema, model: stringSchema, size: stringSchema, seconds: stringSchema, resolution: stringSchema, generateAudio: booleanSchema, watermark: booleanSchema, run: booleanSchema }, ["prompt"]),
    define("prompts_search", "搜索提示词库。", { keyword: stringSchema, category: stringSchema, tags: stringArraySchema, page: numberSchema, pageSize: numberSchema }),
    define("assets_list", "搜索和分页读取我的素材。", { kind: { type: "string", enum: ["all", "text", "image", "video"] }, keyword: stringSchema, page: numberSchema, pageSize: numberSchema }),
    define("assets_add", "添加文本或图片素材。", { kind: { type: "string", enum: ["text", "image"] }, title: stringSchema, content: stringSchema, imageUrl: stringSchema, tags: stringArraySchema, source: stringSchema, note: stringSchema }, ["kind", "title"]),
];

const READ_TOOLS = new Set(["canvas_get_state", "canvas_get_selection", "canvas_export_snapshot", "canvas_list_projects", "generation_get_status", "workbench_image_get_config", "workbench_video_get_config", "prompts_search", "assets_list"]);

export function isApiAgentWriteTool(name: string) {
    return name !== "site_navigate" && !READ_TOOLS.has(name);
}

export function isApiAgentCanvasWriteTool(name: string) {
    return name.startsWith("canvas_") && !READ_TOOLS.has(name);
}

export async function executeApiAgentTool(name: string, input: Record<string, unknown>, navigate: NavigateFunction, attachments: AgentAttachment[]) {
    const context = useAgentStore.getState().canvasContext;
    if (name === "site_navigate") {
        const path = text(input.path) || "/canvas";
        navigate(path);
        return { ok: true, path };
    }
    if (isSiteTool(name)) return runSiteTool(name, input, navigate, { canvasSnapshot: context?.snapshot || null });
    if (!context) throw new Error("当前没有已打开的画布，请先打开一个画布");
    if (name === "canvas_get_state" || name === "canvas_export_snapshot") return compactSnapshot(context.snapshot);
    if (name === "canvas_get_selection") {
        const selected = new Set(context.snapshot.selectedNodeIds);
        return { nodes: context.snapshot.nodes.filter((node) => selected.has(node.id)).map(compactNode) };
    }
    if (context.readOnly) throw new Error("当前画布为只读，不能执行写操作");

    const ops = name === "canvas_create_attachment_nodes" ? await attachmentOps(input, attachments, context.snapshot) : buildOps(name, input, context.snapshot);
    if (!ops) throw new Error(`不支持的工具：${toolName(name)}`);
    const next = context.applyOps(ops);
    const createdNodeIds = ops.flatMap((op) => op.type === "add_node" && op.id ? [op.id] : []);
    return { ok: true, appliedOps: ops.length, ...(createdNodeIds.length ? { createdNodeIds } : {}), state: compactSnapshot(next) };
}

function buildOps(name: string, input: Record<string, unknown>, state: CanvasAgentSnapshot): CanvasAgentOp[] | null {
    if (name === "canvas_apply_ops") return canvasOps(input.ops);
    if (name === "canvas_create_node") {
        const type = nodeType(input.nodeType);
        return [{ type: "add_node", id: `${type}-${crypto.randomUUID()}`, nodeType: type, title: optionalText(input.title), position: { x: num(input.x, nextCanvasX(state)), y: num(input.y, 0) }, width: optionalNumber(input.width), height: optionalNumber(input.height), metadata: metadata(input.metadata) }];
    }
    if (name === "canvas_create_text_node") return [textNode(input, num(input.x, nextCanvasX(state)), num(input.y, 0))];
    if (name === "canvas_create_text_nodes") {
        const x = num(input.x, nextCanvasX(state));
        const y = num(input.y, 0);
        const gap = num(input.gap, 40);
        const direction = input.direction === "row" ? "row" : "column";
        return arrayRecords(input.items).map((item, index) => textNode(item, num(item.x, direction === "row" ? x + index * (340 + gap) : x), num(item.y, direction === "row" ? y : y + index * (240 + gap))));
    }
    if (name === "canvas_create_image_prompt_flow") return generationFlow({ ...input, mode: "image" }, state);
    if (name === "canvas_create_config_node") {
        const id = `config-${crypto.randomUUID()}`;
        const mode = generationMode(input.mode);
        return [configNode(id, input, num(input.x, nextCanvasX(state)), num(input.y, 0)), ...(input.autoRun ? [runGeneration(id, mode, optionalText(input.prompt))] : [])];
    }
    if (name === "canvas_create_generation_flow") return generationFlow(input, state);
    if (["canvas_generate_text", "canvas_generate_image", "canvas_generate_video", "canvas_generate_audio"].includes(name)) return generationFlow({ ...input, mode: name.replace("canvas_generate_", ""), autoRun: true }, state);
    if (name === "canvas_update_node") return [{ type: "update_node", id: text(input.id), patch: nodePatch(input.patch), metadata: metadata(input.metadata) }];
    if (name === "canvas_update_node_text") return [{ type: "update_node", id: text(input.id), patch: optionalText(input.title) ? { title: text(input.title) } : {}, metadata: { content: text(input.text), status: "success" } }];
    if (name === "canvas_move_nodes") {
        return arrayRecords(input.items).map<CanvasAgentOp>((item) => {
            const current = state.nodes.find((node) => node.id === item.id);
            return { type: "update_node", id: text(item.id), patch: { position: { x: num(item.x, (current?.position.x || 0) + num(item.dx, 0)), y: num(item.y, (current?.position.y || 0) + num(item.dy, 0)) } } };
        });
    }
    if (name === "canvas_resize_node") return [{ type: "update_node", id: text(input.id), patch: { width: num(input.width, 320), height: num(input.height, 240) }, metadata: typeof input.freeResize === "boolean" ? { freeResize: input.freeResize } : undefined }];
    if (name === "canvas_delete_nodes") return [{ type: "delete_node", ids: stringArray(input.ids) }];
    if (name === "canvas_connect_nodes") return arrayRecords(input.connections).map<CanvasAgentOp>((item) => ({ type: "connect_nodes", fromNodeId: text(item.fromNodeId), toNodeId: text(item.toNodeId) }));
    if (name === "canvas_select_nodes") return [{ type: "select_nodes", ids: stringArray(input.ids) }];
    if (name === "canvas_set_viewport") return [{ type: "set_viewport", viewport: viewport(input.viewport) }];
    if (name === "canvas_run_generation") return [runGeneration(text(input.nodeId), generationMode(input.mode), optionalText(input.prompt))];
    return null;
}

async function attachmentOps(input: Record<string, unknown>, attachments: AgentAttachment[], state: CanvasAgentSnapshot): Promise<CanvasAgentOp[]> {
    const ids = stringArray(input.attachmentIds);
    const selected = ids.map((id) => attachments.find((item) => item.id === id)).filter((item): item is AgentAttachment => Boolean(item));
    if (!selected.length) throw new Error("没有找到本轮图片附件");
    const uploaded = await Promise.all(selected.map(async (attachment) => {
        const upload = await uploadImage(attachment.dataUrl);
        return { attachment, upload, size: fitNodeSize(upload.width, upload.height) };
    }));
    const x = num(input.x, nextCanvasX(state));
    const y = num(input.y, 0);
    const gap = num(input.gap, 40);
    const direction = input.direction === "column" ? "column" : "row";
    let offset = 0;
    return uploaded.map(({ attachment, upload, size }) => {
        const op: CanvasAgentOp = { type: "add_node", id: `image-${crypto.randomUUID()}`, nodeType: "image", title: attachment.name, position: { x: direction === "row" ? x + offset : x, y: direction === "column" ? y + offset : y }, ...size, metadata: imageMetadata(upload) };
        offset += (direction === "row" ? size.width : size.height) + gap;
        return op;
    });
}

function generationFlow(input: Record<string, unknown>, state: CanvasAgentSnapshot): CanvasAgentOp[] {
    const mode = generationMode(input.mode);
    const prompt = text(input.prompt);
    const x = num(input.x, nextCanvasX(state));
    const y = num(input.y, 0);
    const textId = `text-${crypto.randomUUID()}`;
    const configId = `config-${crypto.randomUUID()}`;
    const references = stringArray(input.referenceNodeIds);
    const tokens = [`@[node:${textId}]`, ...references.map((id) => `@[node:${id}]`)];
    return [
        textNode({ id: textId, text: prompt, title: optionalText(input.title) || "提示词" }, x, y),
        configNode(configId, { ...input, prompt: tokens.join("\n") }, x + 420, y),
        { type: "connect_nodes", fromNodeId: textId, toNodeId: configId },
        ...references.map<CanvasAgentOp>((fromNodeId) => ({ type: "connect_nodes", fromNodeId, toNodeId: configId })),
        { type: "select_nodes", ids: [configId] },
        ...(input.autoRun ? [runGeneration(configId, mode, tokens.join("\n"))] : []),
    ];
}

function textNode(input: Record<string, unknown>, x: number, y: number): CanvasAgentOp {
    return { type: "add_node", id: optionalText(input.id) || `text-${crypto.randomUUID()}`, nodeType: "text", title: optionalText(input.title), position: { x, y }, width: optionalNumber(input.width), height: optionalNumber(input.height), metadata: { content: text(input.text), status: "success", fontSize: 14 } };
}

function configNode(id: string, input: Record<string, unknown>, x: number, y: number): CanvasAgentOp {
    const mode = generationMode(input.mode);
    const prompt = text(input.prompt);
    return {
        type: "add_node",
        id,
        nodeType: "config",
        title: optionalText(input.title) || generationTitle(mode),
        position: { x, y },
        width: optionalNumber(input.width),
        height: optionalNumber(input.height),
        metadata: cleanMetadata({ generationMode: mode, composerContent: prompt, prompt, status: "idle", model: input.model, size: input.size, quality: input.quality, count: input.count, seconds: input.seconds, vquality: input.vquality, generateAudio: input.generateAudio, watermark: input.watermark, audioVoice: input.audioVoice, audioFormat: input.audioFormat, audioSpeed: input.audioSpeed, audioInstructions: input.audioInstructions }),
    };
}

function runGeneration(nodeId: string, mode: "text" | "image" | "video" | "audio", prompt?: string): CanvasAgentOp {
    return { type: "run_generation", nodeId, mode, prompt };
}

function generationProperties(extra: Record<string, unknown> = {}) {
    return { mode: generationModeSchema, prompt: stringSchema, title: stringSchema, x: numberSchema, y: numberSchema, width: numberSchema, height: numberSchema, model: stringSchema, size: stringSchema, quality: stringSchema, count: numberSchema, seconds: stringSchema, vquality: stringSchema, generateAudio: stringSchema, watermark: stringSchema, audioVoice: stringSchema, audioFormat: stringSchema, audioSpeed: stringSchema, audioInstructions: stringSchema, autoRun: booleanSchema, ...extra };
}

function compactSnapshot(state: CanvasAgentSnapshot) {
    return { projectId: state.projectId, title: state.title, nodes: state.nodes.map(compactNode), connections: state.connections, selectedNodeIds: state.selectedNodeIds, viewport: state.viewport };
}

function compactNode(node: CanvasAgentSnapshot["nodes"][number]) {
    const data = node.metadata || {};
    return { id: node.id, type: node.type, title: node.title, position: node.position, width: node.width, height: node.height, metadata: cleanRecord({ content: compactContent(data.content), prompt: data.prompt, composerContent: data.composerContent, generationMode: data.generationMode, model: data.model, status: data.status }) };
}

function canvasOps(value: unknown): CanvasAgentOp[] {
    return Array.isArray(value) ? value.filter((item): item is CanvasAgentOp => Boolean(item) && typeof item === "object" && typeof (item as { type?: unknown }).type === "string") : [];
}
function nextCanvasX(state: CanvasAgentSnapshot) { return Math.max(0, ...state.nodes.map((node) => node.position.x + node.width)) + 80; }
function generationMode(value: unknown): "text" | "image" | "video" | "audio" { return value === "text" || value === "video" || value === "audio" ? value : "image"; }
function generationTitle(mode: string) { return mode === "text" ? "文本生成" : mode === "video" ? "视频生成" : mode === "audio" ? "音频生成" : "图片生成"; }
function nodeType(value: unknown): CanvasNodeTypeId { return value === "image" || value === "config" || value === "video" || value === "audio" ? value : "text"; }
function metadata(value: unknown) { return record(value) as unknown as CanvasNodeMetadata | undefined; }
function nodePatch(value: unknown) { return record(value) as unknown as Partial<CanvasNodeData> | undefined; }
function viewport(value: unknown): ViewportTransform { const data = record(value); return { x: num(data?.x, 0), y: num(data?.y, 0), k: num(data?.k, 1) }; }
function record(value: unknown) { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function arrayRecords(value: unknown) { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : []; }
function stringArray(value: unknown) { return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []; }
function text(value: unknown) { return typeof value === "string" ? value : value == null ? "" : String(value); }
function optionalText(value: unknown) { const result = text(value).trim(); return result || undefined; }
function num(value: unknown, fallback: number) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function optionalNumber(value: unknown) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; }
function compactContent(value: unknown) { const content = typeof value === "string" ? value : undefined; return content?.startsWith("data:") ? "[媒体内容已省略]" : content; }
function cleanRecord(value: Record<string, unknown>) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")); }
function cleanMetadata(value: Record<string, unknown>) { return cleanRecord(value) as unknown as CanvasNodeMetadata; }
