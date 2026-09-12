import localforage from "localforage";

import type { ApiAgentSession } from "@/types/api-agent";

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "api_agent_sessions" });
const INDEX_KEY = "sessions";
const sessionKey = (id: string) => `session:${id}`;

export async function listApiAgentSessions() {
    const ids = (await store.getItem<string[]>(INDEX_KEY)) || [];
    const sessions = await Promise.all(ids.map((id) => store.getItem<ApiAgentSession>(sessionKey(id))));
    return sessions.filter((item): item is ApiAgentSession => Boolean(item)).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function readApiAgentSession(id: string) {
    return store.getItem<ApiAgentSession>(sessionKey(id));
}

export async function saveApiAgentSession(session: ApiAgentSession) {
    await store.setItem(sessionKey(session.id), session);
    const ids = (await store.getItem<string[]>(INDEX_KEY)) || [];
    await store.setItem(INDEX_KEY, [session.id, ...ids.filter((id) => id !== session.id)]);
    return session;
}

export async function deleteApiAgentSessions(ids: string[]) {
    const deleted = new Set(ids);
    await Promise.all(ids.map((id) => store.removeItem(sessionKey(id))));
    const current = (await store.getItem<string[]>(INDEX_KEY)) || [];
    await store.setItem(INDEX_KEY, current.filter((id) => !deleted.has(id)));
}
