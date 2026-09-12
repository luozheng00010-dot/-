/**
 * 无限画布 Windows 客户端壳（Electron 主进程）。
 *
 * 职责：
 * 1. 拉起后端 server 进程（端口 3001，需 PostgreSQL + MinIO 可用）；
 * 2. 开发模式拉起 / 复用 Vite 前端（端口 3000），生产模式用内置静态服务器（/api 代理到后端）；
 * 3. 创建客户端窗口并加载前端；应用退出时回收所有子进程。
 *
 * 用法：
 *   cd electron && npm install
 *   npm run dev        # 开发：自动拉起 web + server，打开客户端窗口（热更新）
 *   npm start          # 运行（等价）
 *   npm run dist       # 打包安装包（需先构建 web 与 server）
 */
const path = require("node:path");
const net = require("node:net");
const fs = require("node:fs");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { app, BrowserWindow, shell } = require("electron");

const IS_DEV = !app.isPackaged;
// 打包后资源在 resources/ 下；开发时就是仓库内的 electron/.. 目录
const ROOT = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, "..");
const SERVER_DIR = path.join(ROOT, "server");
const WEB_DIR = path.join(ROOT, "web");
const WEB_DIST = path.join(WEB_DIR, "dist");

const BACKEND_PORT = 3001;
const WORKER_PORT = 3002;
const WEB_PORT = 3000;
const STATIC_PORT = 41300;

const childProcesses = [];

function spawnManaged(command, args, options) {
    const child = spawn(command, args, { stdio: "inherit", windowsHide: true, ...options });
    childProcesses.push(child);
    return child;
}

function killChildren() {
    for (const child of childProcesses) {
        try {
            child.kill();
        } catch {
            // 进程可能已退出
        }
    }
}

function isPortOpen(port, host = "127.0.0.1") {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host }, () => {
            socket.end();
            resolve(true);
        });
        socket.on("error", () => resolve(false));
    });
}

async function waitForPort(port, { timeoutMs = 60000, intervalMs = 500 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await isPortOpen(port)) return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}

async function ensureBackend() {
    await ensureDatabaseServices();
    if (await isPortOpen(BACKEND_PORT)) {
        console.log(`[shell] 后端已在运行（:${BACKEND_PORT}），复用现有进程`);
        return;
    }
    const distEntry = path.join(SERVER_DIR, "dist", "index.js");
    if (fs.existsSync(distEntry)) {
        console.log("[shell] 启动后端（server/dist）");
        spawnManaged(process.execPath, ["--env-file-if-exists=.env", "dist/index.js"], { cwd: SERVER_DIR });
    } else {
        console.log("[shell] 未找到 server/dist，改用 tsx 启动后端源码");
        spawnManaged(process.execPath, ["--import", "tsx", "--watch", "src/index.ts"], { cwd: SERVER_DIR });
    }
    const ready = await waitForPort(BACKEND_PORT, { timeoutMs: 60000 });
    if (!ready) {
        console.warn("[shell] 后端 60 秒内未就绪，请确认 PostgreSQL 与 MinIO 已启动（docker compose up -d postgres minio）");
    }
    await startWorker();
}

/** 后台任务进程（图片生成 + 知识库索引），复用后端构建产物或 tsx */
async function startWorker() {
    if (await isPortOpen(WORKER_PORT)) return;
    const distEntry = path.join(SERVER_DIR, "dist", "worker.js");
    if (fs.existsSync(distEntry)) {
        console.log("[shell] 启动后台任务进程（server/dist/worker.js）");
        spawnManaged(process.execPath, ["--env-file-if-exists=.env", "dist/worker.js"], { cwd: SERVER_DIR });
    } else {
        console.log("[shell] 未找到 server/dist，改用 tsx 启动后台任务进程");
        spawnManaged(process.execPath, ["--import", "tsx", "src/worker.ts"], { cwd: SERVER_DIR });
    }
}

/** 后端依赖的 PostgreSQL / MinIO 未运行时，尝试用仓库自带 docker compose 拉起 */
async function ensureDatabaseServices() {
    if (await isPortOpen(5432)) return;
    const composeFile = path.join(ROOT, "docker-compose.yml");
    if (!fs.existsSync(composeFile)) return;
    console.log("[shell] PostgreSQL 未运行，尝试通过 docker compose 启动 postgres 与 minio");
    const npmBin = process.platform === "win32" ? "docker.exe" : "docker";
    const child = spawnManaged(npmBin, ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.local.yml", "up", "-d", "postgres", "minio"], { cwd: ROOT });
    await new Promise((resolve) => child.once("exit", resolve));
    const ready = await waitForPort(5432, { timeoutMs: 120000, intervalMs: 1000 });
    if (!ready) {
        console.warn("[shell] PostgreSQL 120 秒内未就绪，请检查 docker 状态");
    }
}

async function resolveWebUrl() {
    if (process.env.ELECTRON_WEB_URL) return process.env.ELECTRON_WEB_URL;
    if (await isPortOpen(WEB_PORT)) {
        console.log(`[shell] 前端开发服务已在运行（:${WEB_PORT}），直接复用`);
        return `http://localhost:${WEB_PORT}`;
    }
    console.log("[shell] 启动前端开发服务（Vite）");
    const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
    // Windows 下 spawn .cmd 需要 shell:true（Node 安全修复后的要求）
    spawnManaged(npmBin, ["run", "dev"], { cwd: WEB_DIR, shell: process.platform === "win32" });
    const ready = await waitForPort(WEB_PORT, { timeoutMs: 60000 });
    if (!ready) {
        throw new Error(`前端开发服务 60 秒内未就绪（: ${WEB_PORT}）`);
    }
    return `http://localhost:${WEB_PORT}`;
}

/** 生产模式：静态资源 + /api 反代，避免 file:// 下 BrowserRouter 失效 */
function startStaticServer() {
    const mimeTypes = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".gif": "image/gif",
        ".ico": "image/x-icon",
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mp3": "audio/mpeg",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${STATIC_PORT}`);

        if (url.pathname.startsWith("/api/")) {
            const upstream = http.request(
                { host: "127.0.0.1", port: BACKEND_PORT, path: url.pathname + url.search, method: req.method, headers: req.headers },
                (proxyRes) => {
                    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
                    proxyRes.pipe(res);
                },
            );
            upstream.on("error", () => {
                res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
                res.end("后端服务未就绪");
            });
            req.pipe(upstream);
            return;
        }

        let filePath = path.normalize(path.join(WEB_DIST, decodeURIComponent(url.pathname)));
        if (!filePath.startsWith(WEB_DIST)) {
            res.writeHead(403);
            return res.end();
        }
        if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
            filePath = path.join(WEB_DIST, "index.html");
        }
        if (!fs.existsSync(filePath)) {
            res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
            return res.end("未找到构建产物 web/dist，请先执行 npm run build");
        }
        const contentType = mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": contentType });
        fs.createReadStream(filePath).pipe(res);
    });

    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(STATIC_PORT, "127.0.0.1", () => resolve(server));
    });
}

async function createMainWindow() {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1200,
        minHeight: 720,
        autoHideMenuBar: true,
        backgroundColor: "#ffffff",
        title: "创作工作台",
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // 外部链接交给系统浏览器
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//.test(url)) {
            shell.openExternal(url);
            return { action: "deny" };
        }
        return { action: "allow" };
    });

    let target;
    if (IS_DEV) {
        target = await resolveWebUrl();
    } else {
        await startStaticServer();
        target = `http://127.0.0.1:${STATIC_PORT}`;
    }
    await win.loadURL(target);

    if (IS_DEV) {
        win.webContents.openDevTools({ mode: "right" });
    }
    return win;
}

app.whenReady().then(async () => {
    await ensureBackend();
    await createMainWindow();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
    killChildren();
});
