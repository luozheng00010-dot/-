import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ffmpeg / ffprobe 二进制定位与 spawn 封装（不引入 fluent-ffmpeg）。
 * 解析顺序：环境变量 FFMPEG_PATH/FFPROBE_PATH → 仓库根 tools/ffmpeg(.exe) → 系统 PATH。
 */

const STDERR_TAIL_LINES = 15;

/** 仓库根目录（src/video 与 dist/video 都在其下三层） */
function repoRoot(): string {
    return resolve(fileURLToPath(new URL("../../../", import.meta.url)));
}

function toolCandidates(name: "ffmpeg" | "ffprobe"): string[] {
    return process.platform === "win32" ? [`${name}.exe`, name] : [name];
}

function findOnPath(name: "ffmpeg" | "ffprobe"): string | null {
    const pathDirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
    for (const dir of pathDirs) {
        for (const candidate of toolCandidates(name)) {
            const full = join(dir, candidate);
            if (existsSync(full)) return full;
        }
    }
    return null;
}

function locateBinary(name: "ffmpeg" | "ffprobe"): string {
    const envKey = name === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
    const fromEnv = process.env[envKey];
    if (fromEnv && fromEnv.trim() && existsSync(fromEnv.trim())) {
        const trimmed = fromEnv.trim();
        return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
    }
    const toolsDir = join(repoRoot(), "tools");
    for (const candidate of toolCandidates(name)) {
        const full = join(toolsDir, candidate);
        if (existsSync(full)) return full;
    }
    const onPath = findOnPath(name);
    if (onPath) return onPath;
    throw new Error(`未找到可执行文件 ${name}。请把 ${name}${process.platform === "win32" ? ".exe" : ""} 放到仓库根目录 tools/ 下，或设置环境变量 ${envKey} 指向其完整路径，或确认其已加入系统 PATH`);
}

export function locateFfmpeg(): string {
    return locateBinary("ffmpeg");
}

export function locateFfprobe(): string {
    return locateBinary("ffprobe");
}

interface SpawnResult {
    code: number | null;
    stdout: string;
    stderrTail: string[];
}

/** spawn 封装：windowsHide、无 shell；按行回调 stdout/stderr，供上层解析进度 */
function spawnTool(bin: string, args: string[], onLine?: (line: string, source: "stdout" | "stderr") => void, cwd?: string): Promise<SpawnResult> {
    return new Promise((resolvePromise, rejectPromise) => {
        let child;
        try {
            child = spawn(bin, args, { windowsHide: true, shell: false, ...(cwd ? { cwd } : {}) });
        } catch (error) {
            rejectPromise(new Error(`无法启动 ${bin}：${error instanceof Error ? error.message : String(error)}`));
            return;
        }
        let stdout = "";
        const stderrTail: string[] = [];
        const makeHandler = (source: "stdout" | "stderr") => {
            let buffer = "";
            return (chunk: Buffer) => {
                buffer += chunk.toString("utf8");
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() || "";
                for (const line of lines) {
                    if (source === "stdout") stdout += `${line}\n`;
                    else {
                        stderrTail.push(line);
                        if (stderrTail.length > STDERR_TAIL_LINES) stderrTail.shift();
                    }
                    onLine?.(line, source);
                }
            };
        };
        child.stdout?.on("data", makeHandler("stdout"));
        child.stderr?.on("data", makeHandler("stderr"));
        child.on("error", (error) => {
            rejectPromise(error instanceof Error && error.message.includes("ENOENT")
                ? new Error(`无法启动 ${bin}，文件不存在或无执行权限`)
                : new Error(`无法启动 ${bin}：${error.message}`));
        });
        child.on("close", (code) => resolvePromise({ code, stdout, stderrTail }));
    });
}

/** 运行 ffmpeg：成功 resolve；失败把 stderr 末尾若干行并进错误消息；onProgress 接收输出行（供后续解析进度） */
export async function runFfmpeg(args: string[], onProgress?: (line: string) => void, options?: { cwd?: string }): Promise<void> {
    const bin = locateFfmpeg();
    const { code, stderrTail } = await spawnTool(bin, args, onProgress ? (line) => onProgress(line) : undefined, options?.cwd);
    if (code !== 0) {
        const tail = stderrTail.join("\n").trim();
        throw new Error(`ffmpeg 执行失败（退出码 ${code ?? "unknown"}）${tail ? `：${tail}` : ""}`);
    }
}

export interface MediaProbe {
    duration: number;
    width: number | null;
    height: number | null;
}

/** ffprobe 读取媒体信息：时长（秒）与首个视频流的宽高 */
export async function probeMedia(filePath: string): Promise<MediaProbe> {
    const bin = locateFfprobe();
    const { code, stdout, stderrTail } = await spawnTool(bin, ["-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", filePath]);
    if (code !== 0) {
        const tail = stderrTail.join("\n").trim();
        throw new Error(`ffprobe 读取媒体信息失败（退出码 ${code ?? "unknown"}）${tail ? `：${tail}` : ""}`);
    }
    let payload: any;
    try {
        payload = JSON.parse(stdout);
    } catch {
        throw new Error("ffprobe 返回了无法解析的数据");
    }
    const streams = Array.isArray(payload?.streams) ? payload.streams : [];
    const videoStream = streams.find((stream: any) => stream?.codec_type === "video");
    const duration = Number(payload?.format?.duration ?? videoStream?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("ffprobe 未读取到有效的视频时长");
    return {
        duration,
        width: Number.isFinite(Number(videoStream?.width)) ? Number(videoStream.width) : null,
        height: Number.isFinite(Number(videoStream?.height)) ? Number(videoStream.height) : null,
    };
}

/** 抽取指定时间点（通常为时长一半）的一帧存为 jpg */
export async function extractMidFrame(filePath: string, outPath: string, midSeconds: number): Promise<void> {
    await runFfmpeg(["-y", "-ss", String(midSeconds), "-i", filePath, "-frames:v", "1", "-q:v", "3", outPath]);
}
