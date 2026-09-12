import { create } from "zustand";
import { serverApi, ApiError } from "@/services/server-api";
import { acquireCanvasEditLease, getCanvasClientId, getCanvasRevision, heartbeatCanvasEditLease, releaseCanvasEditLease, type CanvasEditLease } from "@/services/canvas-edit-lease";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";
import { selectedOwnerId, useOwnerScopeStore, type AccessLevel, type OwnerScope } from "@/stores/use-owner-scope-store";
import { useAuthStore } from "@/stores/use-auth-store";

export type CanvasProject = {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo?: boolean;
    viewport: ViewportTransform;
    ownerId: string;
    ownerUsername: string;
    createdByUsername: string;
    revision: number;
    accessLevel?: AccessLevel;
};

export type CanvasSaveStatus = "idle" | "dirty" | "saving" | "saved" | "error" | "conflict";
export type CanvasSaveState = { status: CanvasSaveStatus; error?: string; serverRevision?: number };
export type CanvasConflictAction = "overwrite" | "reload";
export type CanvasLeaseStatus = "idle" | "acquiring" | "held" | "blocked" | "lost" | "error";
export type CanvasLeaseState = { status: CanvasLeaseStatus; lease?: CanvasEditLease; error?: string };

type ProjectPatch = Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport">>;
type CanvasStore = {
    hydrated: boolean;
    loading: boolean;
    projects: CanvasProject[];
    syncError: string;
    saveStates: Record<string, CanvasSaveState>;
    leaseStates: Record<string, CanvasLeaseState>;
    loadProjects: (scope?: OwnerScope) => Promise<void>;
    loadProject: (id: string) => Promise<CanvasProject | null>;
    createProject: (title?: string) => Promise<string>;
    importProject: (project: Partial<CanvasProject>) => Promise<string>;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => Promise<boolean>;
    deleteProjects: (ids: string[]) => Promise<void>;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: ProjectPatch, options?: { immediate?: boolean }) => void;
    flushProject: (id: string) => Promise<boolean>;
    retryProjectSave: (id: string) => Promise<boolean>;
    resolveProjectConflict: (id: string, action: CanvasConflictAction) => Promise<boolean>;
    acquireEditLease: (id: string, takeover?: boolean) => Promise<boolean>;
    heartbeatEditLease: (id: string) => Promise<boolean>;
    releaseEditLease: (id: string) => Promise<void>;
    checkProjectRevision: (id: string) => Promise<{ revision: number; updatedAt: string } | null>;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const activeSaves = new Map<string, Promise<boolean>>();
const pending = new Set<string>();
const changes = new Map<string, number>();

function projectPayload(project: CanvasProject) {
    return { nodes: project.nodes, connections: project.connections, chatSessions: project.chatSessions, activeChatId: project.activeChatId, backgroundMode: project.backgroundMode, showImageInfo: project.showImageInfo || false, viewport: project.viewport };
}

function accessForOwner(ownerId: string): AccessLevel {
    const { members } = useOwnerScopeStore.getState();
    const user = useAuthStore.getState().user;
    if (user?.role === "admin" || user?.id === ownerId) return "edit";
    return members.find((item) => item.id === ownerId)?.accessLevel || "view";
}

function saveStatesFor(projects: CanvasProject[]) {
    return Object.fromEntries(projects.map((project) => [project.id, { status: "saved" } satisfies CanvasSaveState]));
}

function setSaveState(id: string, value: CanvasSaveState) {
    useCanvasStore.setState((state) => ({ saveStates: { ...state.saveStates, [id]: value } }));
}

function clearScheduledSave(id: string) {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
}

async function latestServerRevision(id: string) {
    return (await getCanvasRevision(id)).revision;
}

async function performProjectFlush(id: string, revisionOverride?: number) {
    const project = useCanvasStore.getState().projects.find((item) => item.id === id);
    if (!project) return false;
    const leaseState = useCanvasStore.getState().leaseStates[id];
    if (project.accessLevel === "view" || leaseState?.status !== "held") {
        const error = leaseState?.error || "当前画布为只读，请先接管编辑";
        setSaveState(id, { status: "error", error });
        return false;
    }
    const localVersion = changes.get(id) || 0;
    setSaveState(id, { status: "saving" });
    try {
        const { item } = await serverApi<{ item: CanvasProject }>(`/api/canvases/${id}`, { method: "PATCH", body: JSON.stringify({ clientId: getCanvasClientId(), revision: revisionOverride ?? project.revision, title: project.title, payload: projectPayload(project) }) });
        const changed = (changes.get(id) || 0) !== localVersion;
        useCanvasStore.setState((state) => ({
            projects: state.projects.map((current) => current.id === id ? (changed ? { ...current, revision: item.revision, updatedAt: item.updatedAt } : { ...item, accessLevel: current.accessLevel }) : current),
            saveStates: { ...state.saveStates, [id]: { status: changed ? "dirty" : "saved" } },
            syncError: "",
        }));
        return true;
    } catch (error) {
        const message = error instanceof Error ? error.message : "画布保存失败";
        if (error instanceof ApiError && error.status === 409) {
            let serverRevision: number | undefined;
            try { serverRevision = await latestServerRevision(id); } catch { /* 保留原始冲突信息 */ }
            useCanvasStore.setState((state) => ({ saveStates: { ...state.saveStates, [id]: { status: "conflict", error: "画布已在其他标签页更新", serverRevision } }, syncError: message }));
        } else {
            if (error instanceof ApiError && error.status === 423) {
                useCanvasStore.setState((state) => ({ leaseStates: { ...state.leaseStates, [id]: { status: error.code === "CANVAS_EDIT_LOCKED" ? "blocked" : "lost", error: message, lease: state.leaseStates[id]?.lease } } }));
            }
            useCanvasStore.setState((state) => ({ saveStates: { ...state.saveStates, [id]: { status: "error", error: message } }, syncError: message }));
        }
        return false;
    }
}

async function requestProjectFlush(id: string, revisionOverride?: number): Promise<boolean> {
    clearScheduledSave(id);
    const active = activeSaves.get(id);
    if (active) {
        pending.add(id);
        await active;
        if (useCanvasStore.getState().saveStates[id]?.status === "conflict") { pending.delete(id); return false; }
        return pending.delete(id) ? requestProjectFlush(id, revisionOverride) : true;
    }

    const task = performProjectFlush(id, revisionOverride);
    activeSaves.set(id, task);
    const result = await task;
    activeSaves.delete(id);
    if (pending.delete(id) && useCanvasStore.getState().saveStates[id]?.status !== "conflict") return requestProjectFlush(id);
    return result;
}

function scheduleSave(id: string, immediate = false) {
    changes.set(id, (changes.get(id) || 0) + 1);
    const current = useCanvasStore.getState().saveStates[id];
    if (current?.status !== "conflict") setSaveState(id, { status: "dirty" });
    clearScheduledSave(id);
    if (current?.status === "conflict") return;
    if (immediate) void requestProjectFlush(id);
    else timers.set(id, setTimeout(() => void requestProjectFlush(id), 600));
}

export const useCanvasStore = create<CanvasStore>((set, get) => ({
    hydrated: false,
    loading: false,
    projects: [],
    syncError: "",
    saveStates: {},
    leaseStates: {},
    loadProjects: async (scope = useOwnerScopeStore.getState().scope) => {
        set({ loading: true });
        try {
            const { items } = await serverApi<{ items: CanvasProject[] }>(`/api/canvases?owner=${encodeURIComponent(scope)}`);
            const projects = items.map((item) => ({ ...item, accessLevel: accessForOwner(item.ownerId) }));
            set({ projects, saveStates: saveStatesFor(projects), hydrated: true, loading: false, syncError: "" });
        } catch (error) {
            set({ projects: [], saveStates: {}, hydrated: true, loading: false, syncError: error instanceof Error ? error.message : "画布读取失败" });
        }
    },
    loadProject: async (id) => {
        try {
            const { item, accessLevel } = await serverApi<{ item: CanvasProject; accessLevel: AccessLevel }>(`/api/canvases/${id}`);
            const project = { ...item, accessLevel };
            clearScheduledSave(id);
            pending.delete(id);
            changes.delete(id);
            set((state) => ({ projects: [project, ...state.projects.filter((current) => current.id !== id)], saveStates: { ...state.saveStates, [id]: { status: "saved" } }, hydrated: true, syncError: "" }));
            return project;
        } catch (error) {
            set({ hydrated: true, syncError: error instanceof Error ? error.message : "画布读取失败" });
            return null;
        }
    },
    createProject: async (title = "未命名画布") => {
        const payload = { nodes: [], connections: [], chatSessions: [], activeChatId: null, backgroundMode: "lines", showImageInfo: false, viewport: initialViewport };
        const { item } = await serverApi<{ item: CanvasProject }>("/api/canvases", { method: "POST", body: JSON.stringify({ ownerId: selectedOwnerId(), title, payload }) });
        set((state) => ({ projects: [{ ...item, accessLevel: "edit" }, ...state.projects], saveStates: { ...state.saveStates, [item.id]: { status: "saved" } } }));
        return item.id;
    },
    importProject: async (source) => {
        const payload = { nodes: source.nodes || [], connections: source.connections || [], chatSessions: source.chatSessions || [], activeChatId: source.activeChatId || null, backgroundMode: source.backgroundMode || "lines", showImageInfo: source.showImageInfo || false, viewport: source.viewport || initialViewport };
        const { item } = await serverApi<{ item: CanvasProject }>("/api/canvases", { method: "POST", body: JSON.stringify({ ownerId: selectedOwnerId(), title: source.title || "导入画布", payload }) });
        set((state) => ({ projects: [{ ...item, accessLevel: "edit" }, ...state.projects], saveStates: { ...state.saveStates, [item.id]: { status: "saved" } } }));
        return item.id;
    },
    openProject: (id) => get().projects.find((item) => item.id === id) || null,
    renameProject: async (id, title) => {
        const project = get().projects.find((item) => item.id === id);
        if (!project || project.accessLevel === "view") return false;
        const previousTitle = project.title;
        const held = get().leaseStates[id]?.status === "held";
        let temporary = false;
        if (!held) {
            const acquired = await get().acquireEditLease(id);
            if (!acquired) return false;
            temporary = true;
        }
        set((state) => ({ projects: state.projects.map((current) => current.id === id ? { ...current, title: title.trim() || current.title } : current) }));
        try {
            if (temporary) {
                const saved = await requestProjectFlush(id);
                if (!saved) set((state) => ({ projects: state.projects.map((current) => current.id === id ? { ...current, title: previousTitle } : current) }));
                return saved;
            }
            scheduleSave(id);
            return true;
        } finally {
            if (temporary) await get().releaseEditLease(id);
        }
    },
    deleteProjects: async (ids) => {
        const editableIds = ids.filter((id) => {
            const project = get().projects.find((item) => item.id === id);
            return project && project.accessLevel !== "view";
        });
        const deletedIds: string[] = [];
        const failures: string[] = [];
        await Promise.all(editableIds.map(async (id) => {
            const held = get().leaseStates[id]?.status === "held";
            let temporary = false;
            if (!held) {
                if (!await get().acquireEditLease(id)) {
                    failures.push(`画布「${get().projects.find((item) => item.id === id)?.title || id}」正在由其他用户编辑`);
                    return;
                }
                temporary = true;
            }
            try {
                await serverApi(`/api/canvases/${id}`, { method: "DELETE", body: JSON.stringify({ clientId: getCanvasClientId() }) });
                deletedIds.push(id);
            } catch (error) {
                failures.push(error instanceof Error ? error.message : "删除画布失败");
            } finally {
                if (temporary) await get().releaseEditLease(id);
            }
        }));
        deletedIds.forEach((id) => { clearScheduledSave(id); activeSaves.delete(id); pending.delete(id); changes.delete(id); });
        set((state) => ({ projects: state.projects.filter((project) => !deletedIds.includes(project.id)), saveStates: Object.fromEntries(Object.entries(state.saveStates).filter(([id]) => !deletedIds.includes(id))), leaseStates: Object.fromEntries(Object.entries(state.leaseStates).filter(([id]) => !deletedIds.includes(id))) }));
        if (failures.length) throw new Error(failures[0]);
    },
    replaceProjects: (projects) => set({ projects, saveStates: saveStatesFor(projects), hydrated: true }),
    updateProject: (id, patch, options) => {
        if (get().projects.find((item) => item.id === id)?.accessLevel === "view") return;
        set((state) => ({ projects: state.projects.map((project) => project.id === id ? { ...project, ...patch } : project) }));
        if (get().leaseStates[id]?.status === "held") scheduleSave(id, options?.immediate);
        else setSaveState(id, { status: "dirty", error: get().leaseStates[id]?.error || "当前画布为只读，请先接管编辑" });
    },
    flushProject: (id) => requestProjectFlush(id),
    retryProjectSave: async (id) => {
        if (get().saveStates[id]?.status === "conflict") return false;
        return requestProjectFlush(id);
    },
    resolveProjectConflict: async (id, action) => {
        if (action === "reload") return Boolean(await get().loadProject(id));
        let revision = get().saveStates[id]?.serverRevision;
        try { revision ??= await latestServerRevision(id); }
        catch (error) {
            const message = error instanceof Error ? error.message : "读取服务器版本失败";
            set((state) => ({ saveStates: { ...state.saveStates, [id]: { status: "conflict", error: message } }, syncError: message }));
            return false;
        }
        setSaveState(id, { status: "dirty" });
        return requestProjectFlush(id, revision);
    },
    acquireEditLease: async (id, takeover = false) => {
        const project = get().projects.find((item) => item.id === id);
        if (!project || project.accessLevel === "view") {
            set((state) => ({ leaseStates: { ...state.leaseStates, [id]: { status: "idle" } } }));
            return false;
        }
        set((state) => ({ leaseStates: { ...state.leaseStates, [id]: { status: "acquiring" } } }));
        try {
            const result = await acquireCanvasEditLease(id, takeover);
            set((state) => ({ leaseStates: { ...state.leaseStates, [id]: result.acquired ? { status: "held", lease: result.lease } : { status: "blocked", lease: result.lease, error: result.lease ? `当前由 ${result.lease.holderUsername} 编辑` : "当前画布正在被其他用户编辑" } } }));
            if (result.acquired && get().saveStates[id]?.status === "dirty") void requestProjectFlush(id);
            return result.acquired;
        } catch (error) {
            const message = error instanceof Error ? error.message : "获取画布编辑权限失败";
            set((state) => ({ leaseStates: { ...state.leaseStates, [id]: { status: "error", error: message } } }));
            setSaveState(id, { status: "error", error: message });
            return false;
        }
    },
    heartbeatEditLease: async (id) => {
        if (get().leaseStates[id]?.status !== "held") return false;
        try {
            const result = await heartbeatCanvasEditLease(id);
            set((state) => ({ leaseStates: { ...state.leaseStates, [id]: result.acquired ? { status: "held", lease: result.lease } : { status: "lost", lease: result.lease, error: "画布编辑租约已失效，请重新接管编辑" } } }));
            return result.acquired;
        } catch (error) {
            const message = error instanceof Error ? error.message : "画布编辑租约已失效，请重新接管编辑";
            set((state) => ({ leaseStates: { ...state.leaseStates, [id]: { status: "lost", lease: state.leaseStates[id]?.lease, error: message } } }));
            return false;
        }
    },
    releaseEditLease: async (id) => {
        await releaseCanvasEditLease(id).catch(() => undefined);
        set((state) => ({ leaseStates: { ...state.leaseStates, [id]: { status: "idle" } } }));
    },
    checkProjectRevision: async (id) => {
        try {
            const result = await getCanvasRevision(id);
            if (result.lease && result.lease.clientId === getCanvasClientId() && result.accessLevel === "edit") {
                set((state) => ({ leaseStates: { ...state.leaseStates, [id]: { status: "held", lease: result.lease } } }));
            } else if (result.lease) {
                const lease = result.lease;
                set((state) => ({ leaseStates: { ...state.leaseStates, [id]: { status: "blocked", lease, error: `当前由 ${lease.holderUsername} 编辑` } } }));
            } else {
                set((state) => ({ leaseStates: { ...state.leaseStates, [id]: { status: "idle" } } }));
            }
            return { revision: result.revision, updatedAt: result.updatedAt };
        } catch {
            return null;
        }
    },
}));
