export function mergeUpstreamUrl(baseUrl: string, suffix: string) {
    const normalizedBase = baseUrl.replace(/\/+$/, "");
    const basePath = new URL(normalizedBase).pathname.replace(/\/+$/, "").toLowerCase();
    let normalizedSuffix = `/${suffix.replace(/^\/+/, "")}`;
    for (const prefix of ["/api/plan/v3", "/api/v3", "/v1beta", "/v1"]) {
        if (basePath.endsWith(prefix) && normalizedSuffix.toLowerCase().startsWith(`${prefix}/`)) {
            normalizedSuffix = normalizedSuffix.slice(prefix.length);
            break;
        }
    }
    // base 已带版本段（如智谱 …/api/paas/v4）而 suffix 是固定 /v1 时，剥掉 suffix 的版本段，
    // 避免拼出 …/v4/v1/embeddings 这样的错误路径。
    if (/\/v[0-9][0-9a-z.-]*$/.test(basePath) && /^\/v[0-9][0-9a-z.-]*(?=\/)/i.test(normalizedSuffix)) {
        normalizedSuffix = normalizedSuffix.replace(/^\/v[0-9][0-9a-z.-]*(?=\/)/i, "");
    }
    return new URL(`${normalizedBase}${normalizedSuffix}`);
}

export function safeUpstreamError(payload: any, text: string, status: number, apiKey: string, prefix: string) {
    const detail = payload?.error?.message || payload?.message || payload?.msg || payload?.detail || (text && !/<[a-z][\s\S]*>/i.test(text) ? text : "");
    const message = String(detail || "上游服务未返回错误原因");
    return `${prefix}（HTTP ${status}）：${(apiKey ? message.replaceAll(apiKey, "********") : message).slice(0, 500)}`;
}
