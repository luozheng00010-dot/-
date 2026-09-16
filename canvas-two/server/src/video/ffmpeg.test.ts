import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { locateFfmpeg, locateFfprobe } from "./ffmpeg.js";

// 仓库根 tools/ 目录（若开发者放了二进制，PATH/报错分支的断言会失效，需跳过）
const repoToolsDir = join(fileURLToPath(new URL("../../../", import.meta.url)), "tools");
const toolsHasBinary = ["ffmpeg", "ffmpeg.exe", "ffprobe", "ffprobe.exe"].some((name) => existsSync(join(repoToolsDir, name)));

const exeName = (base: string) => (process.platform === "win32" ? `${base}.exe` : base);

let tempDirs: string[] = [];

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ffmpeg-locate-"));
    tempDirs.push(dir);
    return dir;
}

describe("ffmpeg binary locate", () => {
    beforeEach(() => {
        vi.stubEnv("FFMPEG_PATH", "");
        vi.stubEnv("FFPROBE_PATH", "");
        vi.stubEnv("PATH", makeTempDir());
    });
    afterEach(() => {
        vi.unstubAllEnvs();
        for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
        tempDirs = [];
    });

    it("prefers the FFMPEG_PATH/FFPROBE_PATH environment variables when the files exist", () => {
        const dir = makeTempDir();
        const ffmpegPath = join(dir, "custom-ffmpeg");
        const ffprobePath = join(dir, "custom-ffprobe");
        writeFileSync(ffmpegPath, "");
        writeFileSync(ffprobePath, "");
        vi.stubEnv("FFMPEG_PATH", ffmpegPath);
        vi.stubEnv("FFPROBE_PATH", ffprobePath);
        expect(locateFfmpeg()).toBe(ffmpegPath);
        expect(locateFfprobe()).toBe(ffprobePath);
    });

    // tools/ 放了二进制时按定位优先级会先命中 tools/，PATH 分支无法覆盖
    it.skipIf(toolsHasBinary)("ignores an environment variable that points to a missing file", () => {
        const dir = makeTempDir();
        const onPath = join(dir, exeName("ffmpeg"));
        writeFileSync(onPath, "");
        vi.stubEnv("FFMPEG_PATH", join(dir, "does-not-exist"));
        vi.stubEnv("PATH", dir);
        expect(locateFfmpeg()).toBe(onPath);
    });

    it.skipIf(toolsHasBinary)("falls back to scanning PATH for the binary", () => {
        const dir = makeTempDir();
        const binary = join(dir, exeName("ffprobe"));
        writeFileSync(binary, "");
        vi.stubEnv("PATH", `${makeTempDir()}${process.platform === "win32" ? ";" : ":"}${dir}`);
        expect(locateFfprobe()).toBe(binary);
    });

    it.skipIf(toolsHasBinary)("throws a descriptive error when nothing is found", () => {
        expect(() => locateFfmpeg()).toThrow(/FFMPEG_PATH/);
        expect(() => locateFfmpeg()).toThrow(/tools/);
        expect(() => locateFfprobe()).toThrow(/FFPROBE_PATH/);
    });
});
