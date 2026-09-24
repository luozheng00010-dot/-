#!/usr/bin/env node
/**
 * 一键启动开发环境：web(3000) + server(3001) + 自动剪辑引擎 auto-video(API 8080) + 客户端窗口(Electron)。
 * 主界面「自动剪辑」页为原生 React 工作台，通过 server 代理调用引擎，无需 Streamlit。
 * 用法：在 canvas-two 根目录执行 `npm run dev`；`npm run dev:auto-video` 只启动自动剪辑引擎；
 *       `npm run dev -- --no-client` 启动全部服务但不弹客户端窗口。
 * 前置：server/web 需先 `npm run install:all` 装依赖；auto-video 由 uv 自动管理虚拟环境；
 *       本机需已安装 ffmpeg 并加入 PATH；客户端需先 `npm --prefix electron install`。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const autoOnly = process.argv.includes("--auto-only");
const noClient = process.argv.includes("--no-client");

// 各服务监听端口：已运行则复用，避免重复启动抢端口；也避免对运行中的服务重复 prisma generate（Windows 下引擎 DLL 被占用会 EPERM）
const SERVICE_PORTS = { server: 3001, worker: 3002, web: 3000, "auto-video": 8080 };

function isPortOpen(port, host = "127.0.0.1") {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host }, () => {
            socket.end();
            resolve(true);
        });
        socket.on("error", () => resolve(false));
    });
}

const tasks = [];

if (!autoOnly) {
    if (await isPortOpen(SERVICE_PORTS.server)) {
        console.log(`[dev] 后端已在运行（:${SERVICE_PORTS.server}），跳过数据库准备`);
    } else {
        // Prepare once before either process imports Prisma Client. This runs only when the user starts dev.
        await new Promise((resolve, reject) => {
            const prepare = spawn("npm run dev:prepare", { cwd: path.join(root, "server"), shell: true, stdio: "inherit" });
            prepare.on("error", reject);
            prepare.on("exit", (code) => code === 0 ? resolve() : reject(new Error("数据库准备失败，请查看上方日志")));
        });
    }
    tasks.push({ name: "server", cwd: "server", command: "npm run dev:api" });
    tasks.push({ name: "worker", cwd: "server", command: "npm run dev:worker" });
    tasks.push({ name: "web", cwd: "web", command: "npm run dev" });
}
tasks.push({ name: "auto-video", cwd: "auto-video", command: "uv run main.py" });

if (!autoOnly && !noClient) {
    // Electron 壳检测到 3000/3001 已有服务会直接复用，这里只需把客户端窗口拉起来
    const electronBin = path.join(root, "electron", "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
    if (existsSync(electronBin)) {
        tasks.push({ name: "client", cwd: "electron", command: "npm run dev" });
    } else {
        console.warn("未找到 electron 依赖，跳过客户端窗口；如需客户端请先执行 npm --prefix electron install");
    }
}

// 已有实例在跑时只补缺失的服务，重复执行 npm run dev 不会抢占端口或重复拉起整套进程
for (let i = tasks.length - 1; i >= 0; i--) {
    const port = SERVICE_PORTS[tasks[i].name];
    if (port && await isPortOpen(port)) {
        console.log(`[dev] ${tasks[i].name} 已在运行（:${port}），复用现有进程`);
        tasks.splice(i, 1);
    }
}

const colors = ["\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[32m"];
const children = [];

function prefixColor(name) {
    return colors[children.length % colors.length];
}

function spawnTask(task) {
    const color = prefixColor(task.name);
    const child = spawn(task.command, {
        cwd: path.join(root, task.cwd),
        shell: true,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
    });
    const tag = `${color}[${task.name}]\x1b[0m`;
    child.stdout.on("data", (data) => process.stdout.write(String(data).split("\n").filter(Boolean).map((line) => `${tag} ${line}\n`).join("")));
    child.stderr.on("data", (data) => process.stderr.write(String(data).split("\n").filter(Boolean).map((line) => `${tag} ${line}\n`).join("")));
    child.on("exit", (code) => {
        console.log(`${tag} exited with code ${code}`);
    });
    children.push(child);
    return child;
}

for (const task of tasks) {
    if (task.name === "client") continue;
    spawnTask(task);
}

// 客户端等服务就绪后再拉起：electron 检测到 3001/3002/3000 已有进程会直接复用，
// 不会自己再跑 prisma generate 或另起 Vite，避免启动竞态（Windows 下 Prisma 引擎 DLL 被占用导致 EPERM）。
const clientTask = tasks.find((task) => task.name === "client");
if (clientTask) {
    const deadline = Date.now() + 120000;
    const pending = new Map([[3001, "后端"], [3002, "后台任务"], [3000, "前端"]]);
    while (pending.size && Date.now() < deadline) {
        for (const [port, label] of [...pending]) {
            if (await isPortOpen(port)) pending.delete(port);
        }
        if (pending.size) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (pending.size) {
        console.warn(`[dev] 等待超时：${[...pending.values()].join("、")} 服务未就绪，仍尝试启动客户端`);
    }
    spawnTask(clientTask);
}

function killChild(child) {
    try {
        if (process.platform === "win32" && child.pid && child.exitCode === null && child.signalCode === null) {
            // Windows 下 child.kill() 只杀直接子进程（npm.cmd 外壳），孙进程（electron）会残留，需按进程树终止
            spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        } else {
            child.kill();
        }
    } catch {
        // 进程可能已退出
    }
}

function shutdown() {
    for (const child of children) {
        killChild(child);
    }
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
