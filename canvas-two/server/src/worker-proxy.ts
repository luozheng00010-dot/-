import { ProxyAgent, setGlobalDispatcher } from "undici";

export function configureWorkerProxy(proxyUrl?: string) {
    if (!proxyUrl) {
        console.log("[image-worker] network proxy=direct");
        return;
    }
    try {
        setGlobalDispatcher(new ProxyAgent(proxyUrl));
    } catch {
        throw new Error("Worker 代理配置无效，请检查 WORKER_PROXY_URL");
    }
    console.log("[image-worker] network proxy=enabled");
}
