import { prisma } from "../db.js";

/**
 * 知识库混合检索：pgvector 余弦相似度 + 关键词 ILIKE（MVP，
 * 中文全文索引需 zhparser，二期可替换），按 RRF（倒数排名融合）合并。
 */

export interface KbSearchHit {
    chunkId: string;
    postId: string;
    ord: number;
    heading: string | null;
    content: string;
    postTitle: string;
    official: boolean;
    score: number;
}

const VECTOR_CANDIDATES = 24;
const KEYWORD_CANDIDATES = 24;
const RRF_K = 60;

function vectorLiteral(embedding: number[]) {
    return `[${embedding.join(",")}]`;
}

async function vectorSearch(embedding: number[], limit: number): Promise<KbSearchHit[]> {
    const literal = vectorLiteral(embedding);
    const rows = await prisma.$queryRaw<Array<{
        chunkId: string; postId: string; ord: number; heading: string | null; content: string;
        postTitle: string; official: boolean; distance: number;
    }>>`
        SELECT c.id AS "chunkId", c.post_id AS "postId", c.ord, c.heading, c.content,
               p.title AS "postTitle", p.official,
               c.embedding <=> ${literal}::vector AS distance
        FROM kb_chunks c
        JOIN kb_posts p ON p.id = c.post_id
        WHERE c.embedding IS NOT NULL AND p.status = 'published'
        ORDER BY c.embedding <=> ${literal}::vector
        LIMIT ${limit}`;
    return rows.map((row) => ({ ...row, score: 1 / (1 + row.distance) }));
}

function keywordTerms(query: string): string[] {
    // 中文按二元组（bigram）切词：整句 ILIKE 无法命中，bigram 兼顾命中率与噪声
    const terms: string[] = [];
    for (const match of query.matchAll(/[一-鿿]+|[A-Za-z0-9_]+/g)) {
        const token = match[0];
        if (/^[一-鿿]$/.test(token[0])) {
            if (token.length === 2) terms.push(token);
            else if (token.length > 2) for (let index = 0; index + 2 <= token.length; index += 1) terms.push(token.slice(index, index + 2));
        } else if (token.length >= 2) {
            terms.push(token.toLowerCase());
        }
    }
    return [...new Set(terms)].slice(0, 12);
}

async function keywordSearch(query: string, limit: number): Promise<KbSearchHit[]> {
    const terms = keywordTerms(query);
    if (!terms.length) return [];
    // 每个关键词一次查询（公司知识库规模下足够快），再在 JS 侧汇总打分
    const perTerm = await Promise.all(terms.map((term) => {
        const pattern = `%${term.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
        return prisma.$queryRaw<Array<{
            chunkId: string; postId: string; ord: number; heading: string | null; content: string;
            postTitle: string; official: boolean;
        }>>`
            SELECT c.id AS "chunkId", c.post_id AS "postId", c.ord, c.heading, c.content,
                   p.title AS "postTitle", p.official
            FROM kb_chunks c
            JOIN kb_posts p ON p.id = c.post_id
            WHERE p.status = 'published' AND (
                c.heading ILIKE ${pattern} ESCAPE '\\'
                OR c.content ILIKE ${pattern} ESCAPE '\\'
                OR p.title ILIKE ${pattern} ESCAPE '\\'
            )
            LIMIT ${limit * 4}`;
    }));
    const scoreByChunk = new Map<string, { hit: Omit<KbSearchHit, "score">; matched: number }>();
    for (const rows of perTerm) {
        for (const row of rows) {
            const current = scoreByChunk.get(row.chunkId);
            if (current) current.matched += 1;
            else scoreByChunk.set(row.chunkId, { hit: row, matched: 1 });
        }
    }
    const scored = [...scoreByChunk.values()].sort((a, b) => b.matched - a.matched || (b.hit.heading ? 1 : 0) - (a.hit.heading ? 1 : 0));
    return scored.slice(0, limit).map((item, index) => ({ ...item.hit, score: 1 - index / limit }));
}

export interface KbHybridResult {
    hits: KbSearchHit[]; // 平铺的片段，按融合分数降序
    postIds: string[]; // 命中的帖子，按最佳片段分数降序
}

export async function hybridSearch(query: string, embedding: number[] | null, options?: { postLimit?: number }): Promise<KbHybridResult> {
    const [vectorHits, keywordHits] = await Promise.all([
        embedding ? vectorSearch(embedding, VECTOR_CANDIDATES) : Promise.resolve([] as KbSearchHit[]),
        keywordSearch(query, KEYWORD_CANDIDATES),
    ]);
    const scoreByChunk = new Map<string, { hit: KbSearchHit; rrf: number }>();
    const accumulate = (hits: KbSearchHit[]) => {
        hits.forEach((hit, rank) => {
            const current = scoreByChunk.get(hit.chunkId);
            const rrf = 1 / (RRF_K + rank + 1);
            if (current) current.rrf += rrf;
            else scoreByChunk.set(hit.chunkId, { hit, rrf });
        });
    };
    accumulate(vectorHits);
    accumulate(keywordHits);
    const merged = [...scoreByChunk.values()].map((item) => ({ ...item.hit, score: item.rrf }));
    merged.sort((a, b) => b.score - a.score);
    const postBest = new Map<string, number>();
    for (const hit of merged) {
        const best = postBest.get(hit.postId) || 0;
        if (hit.score > best) postBest.set(hit.postId, hit.score);
    }
    const postIds = [...postBest.entries()].sort((a, b) => b[1] - a[1]).map(([postId]) => postId).slice(0, options?.postLimit ?? 5);
    const allowed = new Set(postIds);
    const hits = merged.filter((hit) => allowed.has(hit.postId)).slice(0, 8);
    return { hits, postIds };
}
