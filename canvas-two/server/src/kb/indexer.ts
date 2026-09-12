import { randomUUID } from "node:crypto";
import { chunkMarkdown } from "./chunking.js";
import { createEmbeddings, resolveKbModel } from "./llm.js";
import { prisma } from "../db.js";

/**
 * 知识库入库管线（跑在 worker 进程）：帖子发布后异步
 * 清洗 -> 切分 -> embedding -> 向量入库；编辑后整篇重切分。
 */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let stopping = false;

export function stopKbIndexer() {
    stopping = true;
}

/** 标记帖子待重建索引（发帖/编辑后调用） */
export async function enqueuePostIndexing(postId: string) {
    await prisma.kbPost.updateMany({ where: { id: postId }, data: { indexStatus: "pending", indexError: null } });
}

/** 归档/删除时立即清空向量，避免检索命中失效内容 */
export async function removePostIndex(postId: string) {
    await prisma.$transaction([
        prisma.kbChunk.deleteMany({ where: { postId } }),
        prisma.kbPost.updateMany({ where: { id: postId }, data: { indexStatus: "indexed", indexError: null, indexedAt: new Date() } }),
    ]);
}

async function claimPost() {
    return prisma.$transaction(async (tx) => {
        const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM kb_posts WHERE index_status = 'pending' ORDER BY updated_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`;
        if (!rows[0]) return null;
        return tx.kbPost.update({ where: { id: rows[0].id }, data: { indexStatus: "indexing" } });
    });
}

/**
 * embedding 列不带固定维度（兼容不同模型），空表无法预建 HNSW 索引，
 * 在首批向量入库后惰性创建；失败仅降级为顺序扫描，不影响功能。
 */
async function ensureVectorIndex() {
    await prisma.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "kb_chunks_embedding_idx" ON "kb_chunks" USING HNSW ("embedding" vector_cosine_ops)`).catch(() => undefined);
}

async function indexPost(postId: string) {
    const post = await prisma.kbPost.findUnique({ where: { id: postId } });
    if (!post) return;
    if (post.status !== "published") {
        await removePostIndex(post.id);
        return;
    }
    const chunks = chunkMarkdown(post.content);
    if (!chunks.length) {
        await prisma.$transaction([
            prisma.kbChunk.deleteMany({ where: { postId: post.id } }),
            prisma.kbPost.update({ where: { id: post.id }, data: { indexStatus: "indexed", indexError: null, indexedAt: new Date() } }),
        ]);
        return;
    }
    // 向量是尽力而为：渠道不可用时仍写入纯文本切片，保证关键词检索可用
    let vectors: number[][] | null = null;
    let embedNote: string | null = null;
    try {
        const embedConfig = await resolveKbModel("embed");
        vectors = await createEmbeddings(embedConfig, chunks.map((chunk) => `${chunk.heading ? `# ${chunk.heading}\n\n` : ""}${chunk.content}`));
    } catch (error) {
        embedNote = error instanceof Error ? error.message : "向量生成失败，已退回关键词检索";
        console.warn("[kb-indexer] embedding unavailable, storing text-only chunks", post.id, embedNote);
    }
    const now = new Date();
    await prisma.$transaction(async (tx) => {
        await tx.kbChunk.deleteMany({ where: { postId: post.id } });
        for (const [index, chunk] of chunks.entries()) {
            const id = randomUUID();
            if (vectors) {
                const literal = `[${vectors[index].join(",")}]`;
                await tx.$executeRaw`INSERT INTO "kb_chunks" ("id", "post_id", "ord", "heading", "content", "embedding", "updated_at")
                    VALUES (${id}, ${post.id}, ${chunk.ord}, ${chunk.heading}, ${chunk.content}, ${literal}::vector, ${now})`;
            } else {
                await tx.kbChunk.create({ data: { id, postId: post.id, ord: chunk.ord, heading: chunk.heading, content: chunk.content, updatedAt: now } });
            }
        }
        await tx.kbPost.update({ where: { id: post.id }, data: { indexStatus: "indexed", indexError: embedNote, indexedAt: now } });
    });
    if (vectors) await ensureVectorIndex();
}

export async function startKbIndexer() {
    console.log("[kb-indexer] started");
    // 崩溃恢复：上一次中断时留在 indexing 状态的帖子重新入队
    await prisma.kbPost.updateMany({ where: { indexStatus: "indexing" }, data: { indexStatus: "pending" } }).catch(() => undefined);
    while (!stopping) {
        const post = await claimPost().catch((error) => {
            console.error("[kb-indexer] claim failed", error);
            return null;
        });
        if (!post) {
            await sleep(1_500);
            continue;
        }
        try {
            await indexPost(post.id);
            console.log(`[kb-indexer] indexed post ${post.id}`);
        } catch (error) {
            const message = error instanceof Error ? error.message : "索引失败";
            console.error("[kb-indexer] index failed", post.id, error);
            await prisma.kbPost.update({ where: { id: post.id }, data: { indexStatus: "failed", indexError: message.slice(0, 500) } }).catch(() => undefined);
        }
    }
}
