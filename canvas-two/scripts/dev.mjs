#!/usr/bin/env node
/**
 * 一键启动开发环境：web(3000) + server(3001) + 自动剪辑引擎 auto-video(API 8080)。
 * 主界面「自动剪辑」页为原生 React 工作台，通过 server 代理调用引擎，无需 Streamlit。
 * 用法：在 canvas-two 根目录执行 `npm run dev`；`npm run dev:auto-video` 只启动自动剪辑引擎。
 * 前置：server/web 需先 `npm run install:all` 装依赖；auto-video 由 uv 自动管理虚拟环境；
 *       本机需已安装 ffmpeg 并加入 PATH。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const autoOnly = process.argv.includes("--auto-only");

const tasks = [];

if (!autoOnly) {
    // Prepare once before either process imports Prisma Client. This runs only when the user starts dev.
    await new Promise((resolve, reject) => {
        const prepare = spawn("npm run dev:prepare", { cwd: path.join(root, "server"), shell: true, stdio: "inherit" });
        prepare.on("error", reject);
        prepare.on("exit", (code) => code === 0 ? resolve() : reject(new Error("数据库准备失败，请查看上方日志")));
    });
    tasks.push({ name: "server", cwd: "server", command: "npm run dev:api" });
    tasks.push({ name: "worker", cwd: "server", command: "npm run dev:worker" });
    tasks.push({ name: "web", cwd: "web", command: "npm run dev" });
}
tasks.push({ name: "auto-video", cwd: "auto-video", command: "uv run main.py" });

const colors = ["\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[32m"];
const children = [];

function prefixColor(name) {
    return colors[children.length % colors.length];
}

for (const task of tasks) {
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
}

function shutdown() {
    for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
