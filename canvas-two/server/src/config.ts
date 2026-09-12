import { z } from "zod";

const envSchema = z.object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(3001),
    DATABASE_URL: z.string().min(1).default("postgresql://canvas:canvas@localhost:5432/canvas?schema=public"),
    SESSION_SECRET: z.string().min(16).default("development-session-secret"),
    CHANNEL_ENCRYPTION_KEY: z.string().min(16).default("development-channel-encryption-key"),
    MINIO_ENDPOINT: z.string().default("localhost"),
    MINIO_PORT: z.coerce.number().int().positive().default(9000),
    MINIO_USE_SSL: z.enum(["true", "false"]).default("false"),
    MINIO_ACCESS_KEY: z.string().default("minioadmin"),
    MINIO_SECRET_KEY: z.string().default("minioadmin"),
    MINIO_BUCKET: z.string().default("infinite-canvas"),
    PUBLIC_BASE_PATH: z.string().default(""),
    WORKER_PORT: z.coerce.number().int().positive().default(3002),
    IMAGE_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(8),
    WORKER_PROXY_URL: z.preprocess(
        (value) => typeof value === "string" && !value.trim() ? undefined : value,
        z.string().trim().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol), "WORKER_PROXY_URL 仅支持 HTTP(S) 代理").optional(),
    ),
});

export const env = envSchema.parse(process.env);
export const isProduction = env.NODE_ENV === "production";
const configuredPublicBasePath = env.PUBLIC_BASE_PATH.trim();
export const publicBasePath = !configuredPublicBasePath || configuredPublicBasePath === "/" ? "" : `/${configuredPublicBasePath.replace(/^\/+|\/+$/g, "")}`;

if (isProduction) {
    const insecure = [
        env.SESSION_SECRET.length < 32 || /development|replace-this|replace-with/i.test(env.SESSION_SECRET),
        env.CHANNEL_ENCRYPTION_KEY.length < 32 || /development|replace-this|replace-with/i.test(env.CHANNEL_ENCRYPTION_KEY),
        /canvas-change-me|replace-with/i.test(env.DATABASE_URL),
        ["minioadmin", "canvas-minio"].includes(env.MINIO_ACCESS_KEY) || /replace-with/i.test(env.MINIO_ACCESS_KEY),
        ["minioadmin", "canvas-minio-change-me"].includes(env.MINIO_SECRET_KEY) || /replace-with/i.test(env.MINIO_SECRET_KEY),
    ];
    if (insecure.some(Boolean)) {
        throw new Error("生产环境必须配置独立的数据库、Session、渠道加密和 MinIO 凭据，不能使用示例默认值");
    }
}
