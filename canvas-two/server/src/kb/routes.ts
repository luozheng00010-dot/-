import { Prisma } from "@prisma/client";
import type { User } from "@prisma/client";
import { Router, type Response } from "express";
import { z } from "zod";
import { requireAdmin, requireReadyUser } from "../access.js";
import { prisma } from "../db.js";
import { removeMediaFiles } from "../media.js";
import { enqueuePostIndexing, removePostIndex } from "./indexer.js";
import { chatOnce, createEmbeddings, resolveKbModel, streamChat } from "./llm.js";
import { hybridSearch } from "./search.js";

/**
 * 公司知识库 API：论坛（帖子/评论/分类）+ AI 对话（混合检索 + SSE 流式）+ 管理端。
 * 权限：全员可浏览/发帖/评论/提问；分类管理、官方标记、模型配置、统计仅管理员。
 */

const router = Router();
router.use(requireReadyUser);

const POST_TYPES = ["insight", "workflow", "qa"] as const;
const routeParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;

const MEDIA_REF = /\/api\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(?:content|thumbnail)/g;
function extractMediaIds(content: string): string[] {
    return [...new Set([...content.matchAll(MEDIA_REF)].map((match) => match[1]))];
}

/** 帖子中被移除且未被其他帖子引用的知识库贴图，从服务器（MinIO + 数据库）删除 */
async function cleanupRemovedMedia(postId: string, previousContent: string, nextContent: string) {
    const removed = extractMediaIds(previousContent).filter((mediaId) => !extractMediaIds(nextContent).includes(mediaId));
    if (!removed.length) return;
    const deletable: string[] = [];
    for (const mediaId of removed) {
        const stillReferenced = await prisma.kbPost.count({ where: { id: { not: postId }, content: { contains: mediaId } } });
        if (stillReferenced) continue;
        const media = await prisma.mediaFile.findUnique({ where: { id: mediaId }, select: { id: true, origin: true } });
        if (media?.origin === "kb") deletable.push(media.id);
    }
    if (deletable.length) await removeMediaFiles(deletable);
}

const postInput = z.object({
    title: z.string().trim().min(1, "请输入标题").max(120),
    type: z.enum(POST_TYPES).default("insight"),
    categoryId: z.string().uuid().nullish(),
    tags: z.array(z.string().trim().min(1).max(30)).max(10).default([]),
    content: z.string().trim().min(1, "请输入正文").max(100_000),
    status: z.enum(["draft", "published"]).default("published"),
});

async function usernamesOf(authorIds: string[]) {
    const users = await prisma.user.findMany({ where: { id: { in: [...new Set(authorIds)] } }, select: { id: true, username: true } });
    return new Map(users.map((user) => [user.id, user.username]));
}

function postCard(post: any, username?: string) {
    return {
        id: post.id,
        title: post.title,
        type: post.type,
        tags: post.tags,
        status: post.status,
        official: post.official,
        viewCount: post.viewCount,
        indexStatus: post.indexStatus,
        excerpt: post.content.replace(/!\[[^\]]*\]\([^)]*\)/g, " [图片] ").replace(/[#>*`\-\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 160),
        commentCount: post._count?.comments ?? 0,
        category: post.category ? { id: post.category.id, name: post.category.name } : null,
        author: { id: post.authorId, username: username ?? post.authorId },
        createdAt: post.createdAt,
        updatedAt: post.updatedAt,
    };
}

// ===== 分类 =====

router.get("/categories", async (req, res) => {
    const categories = await prisma.kbCategory.findMany({ orderBy: [{ sort: "asc" }, { createdAt: "asc" }], include: { _count: { select: { posts: { where: { status: "published" } } } } } });
    res.json({ categories: categories.map((item) => ({ id: item.id, name: item.name, sort: item.sort, postCount: item._count.posts })) });
});

const categoryInput = z.object({ name: z.string().trim().min(1).max(30), sort: z.number().int().default(0) });
router.post("/admin/categories", requireAdmin, async (req, res) => {
    const input = categoryInput.parse(req.body);
    const category = await prisma.kbCategory.create({ data: input });
    res.status(201).json({ category });
});
router.patch("/admin/categories/:id", requireAdmin, async (req, res) => {
    const input = categoryInput.partial().parse(req.body);
    const category = await prisma.kbCategory.update({ where: { id: routeParam(req.params.id) }, data: input });
    res.json({ category });
});
router.delete("/admin/categories/:id", requireAdmin, async (req, res) => {
    await prisma.kbCategory.delete({ where: { id: routeParam(req.params.id) } });
    res.json({ ok: true });
});

// ===== 帖子 =====

router.get("/posts", async (req, res) => {
    const query = z.object({
        scope: z.enum(["all", "mine"]).default("all"),
        category: z.string().uuid().optional(),
        tag: z.string().trim().max(30).optional(),
        keyword: z.string().trim().max(100).optional(),
        type: z.enum(POST_TYPES).optional(),
        sort: z.enum(["latest", "hottest"]).default("latest"),
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(50).default(12),
    }).parse(req.query);
    const where = {
        ...(query.scope === "mine" ? { authorId: req.user!.id } : { status: "published" }),
        ...(query.category ? { categoryId: query.category } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.tag ? { tags: { has: query.tag } } : {}),
        ...(query.keyword ? { OR: [{ title: { contains: query.keyword, mode: "insensitive" as const } }, { content: { contains: query.keyword, mode: "insensitive" as const } }] } : {}),
    };
    const [total, posts] = await Promise.all([
        prisma.kbPost.count({ where }),
        prisma.kbPost.findMany({
            where,
            include: { category: true, _count: { select: { comments: true } } },
            orderBy: query.sort === "hottest" ? [{ viewCount: "desc" }, { updatedAt: "desc" }] : [{ updatedAt: "desc" }],
            skip: (query.page - 1) * query.pageSize,
            take: query.pageSize,
        }),
    ]);
    const names = await usernamesOf(posts.map((post) => post.authorId));
    res.json({ total, items: posts.map((post) => postCard(post, names.get(post.authorId))) });
});

router.post("/posts", async (req, res) => {
    const input = postInput.parse(req.body);
    if (input.categoryId) await prisma.kbCategory.findUniqueOrThrow({ where: { id: input.categoryId } });
    const post = await prisma.kbPost.create({ data: { authorId: req.user!.id, title: input.title, type: input.type, categoryId: input.categoryId || null, tags: [...new Set(input.tags)], content: input.content, status: input.status } });
    if (post.status === "published") await enqueuePostIndexing(post.id);
    res.status(201).json({ post: postCard(post) });
});

router.get("/posts/:id", async (req, res) => {
    const post = await prisma.kbPost.findUniqueOrThrow({ where: { id: routeParam(req.params.id) }, include: { category: true, _count: { select: { comments: true } } } });
    if (post.status !== "published" && post.authorId !== req.user!.id && req.user!.role !== "admin") throw Object.assign(new Error("帖子不存在或未发布"), { status: 404 });
    await prisma.kbPost.updateMany({ where: { id: post.id }, data: { viewCount: { increment: 1 } } });
    const comments = await prisma.kbComment.findMany({ where: { postId: post.id }, orderBy: { createdAt: "asc" } });
    const names = await usernamesOf([post.authorId, ...comments.map((item) => item.authorId)]);
    const related = await prisma.kbPost.findMany({ where: { status: "published", id: { not: post.id }, ...(post.categoryId ? { categoryId: post.categoryId } : {}) }, orderBy: { updatedAt: "desc" }, take: 5 });
    res.json({
        post: { ...postCard(post, names.get(post.authorId)), content: post.content },
        comments: comments.map((item) => ({ ...item, author: { id: item.authorId, username: names.get(item.authorId) || item.authorId } })),
        related: related.map((item) => postCard(item, undefined)),
    });
});

function assertPostEditable(user: User, post: { authorId: string }) {
    if (user!.id !== post.authorId && user!.role !== "admin") throw Object.assign(new Error("只有作者或管理员可以操作该帖子"), { status: 403 });
}

router.patch("/posts/:id", async (req, res) => {
    const input = postInput.partial().parse(req.body);
    const current = await prisma.kbPost.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    assertPostEditable(req.user!, current);
    if (input.categoryId) await prisma.kbCategory.findUniqueOrThrow({ where: { id: input.categoryId } });
    const nextStatus = input.status || current.status;
    const contentChanged = input.content !== undefined && input.content !== current.content;
    const post = await prisma.kbPost.update({
        where: { id: current.id },
        data: {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.type ? { type: input.type } : {}),
            ...(input.categoryId !== undefined ? { categoryId: input.categoryId || null } : {}),
            ...(input.tags ? { tags: [...new Set(input.tags)] } : {}),
            ...(input.content !== undefined ? { content: input.content } : {}),
            status: nextStatus,
        },
    });
    if (nextStatus === "published" && (contentChanged || current.status !== "published")) await enqueuePostIndexing(post.id);
    if (nextStatus === "archived") await removePostIndex(post.id);
    await cleanupRemovedMedia(post.id, current.content, post.content);
    res.json({ post: postCard(post) });
});

router.delete("/posts/:id", async (req, res) => {
    const current = await prisma.kbPost.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    assertPostEditable(req.user!, current);
    await prisma.kbPost.update({ where: { id: current.id }, data: { status: "archived" } });
    await removePostIndex(current.id);
    await cleanupRemovedMedia(current.id, current.content, "");
    res.json({ ok: true });
});

const commentInput = z.object({ content: z.string().trim().min(1, "请输入评论").max(5_000), parentId: z.string().uuid().optional() });
router.post("/posts/:id/comments", async (req, res) => {
    const input = commentInput.parse(req.body);
    const post = await prisma.kbPost.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    if (post.status !== "published") throw Object.assign(new Error("帖子未发布"), { status: 400 });
    if (input.parentId) {
        const parent = await prisma.kbComment.findUnique({ where: { id: input.parentId } });
        if (!parent || parent.postId !== post.id) throw Object.assign(new Error("回复的评论不存在"), { status: 404 });
    }
    const comment = await prisma.kbComment.create({ data: { postId: post.id, authorId: req.user!.id, content: input.content, parentId: input.parentId || null } });
    res.status(201).json({ comment: { ...comment, author: { id: comment.authorId, username: req.user!.username } } });
});

// ===== AI 对话 =====

const sseWrite = (res: Response, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

router.post("/chat/conversations", async (req, res) => {
    const input = z.object({ title: z.string().trim().max(60).default("新会话") }).parse(req.body || {});
    const conversation = await prisma.kbConversation.create({ data: { userId: req.user!.id, title: input.title || "新会话" } });
    res.status(201).json({ conversation });
});

router.get("/chat/conversations", async (req, res) => {
    const conversations = await prisma.kbConversation.findMany({ where: { userId: req.user!.id }, orderBy: { updatedAt: "desc" }, take: 100 });
    res.json({ conversations });
});

router.patch("/chat/conversations/:id", async (req, res) => {
    const input = z.object({ title: z.string().trim().min(1, "标题不能为空").max(60, "标题最长 60 字") }).parse(req.body);
    const existing = await prisma.kbConversation.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    if (existing.userId !== req.user!.id) throw Object.assign(new Error("无权修改该会话"), { status: 403 });
    const conversation = await prisma.kbConversation.update({ where: { id: existing.id }, data: { title: input.title } });
    res.json({ conversation });
});

router.get("/chat/conversations/:id", async (req, res) => {
    const conversation = await prisma.kbConversation.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    if (conversation.userId !== req.user!.id) throw Object.assign(new Error("无权访问该会话"), { status: 403 });
    const messages = await prisma.kbMessage.findMany({ where: { convId: conversation.id }, orderBy: { createdAt: "asc" } });
    res.json({ conversation, messages });
});

router.delete("/chat/conversations/:id", async (req, res) => {
    await prisma.kbConversation.deleteMany({ where: { id: routeParam(req.params.id), userId: req.user!.id } });
    res.json({ ok: true });
});

const messageInput = z.object({ content: z.string().trim().min(1, "请输入问题").max(4_000) });

router.post("/chat/conversations/:id/messages", async (req, res) => {
    const input = messageInput.parse(req.body);
    const conversation = await prisma.kbConversation.findUniqueOrThrow({ where: { id: routeParam(req.params.id) } });
    if (conversation.userId !== req.user!.id) throw Object.assign(new Error("无权访问该会话"), { status: 403 });

    const settings = await prisma.kbSetting.findUnique({ where: { id: "default" } });
    const limit = settings?.dailyLimitPerUser ?? 50;
    if (limit > 0) {
        const dayStart = new Date();
        dayStart.setHours(0, 0, 0, 0);
        const asked = await prisma.kbMessage.count({ where: { role: "user", createdAt: { gte: dayStart }, conversation: { userId: req.user!.id } } });
        if (asked >= limit) throw Object.assign(new Error(`已达每日提问上限（${limit} 次），请明天再试`), { status: 429 });
    }

    // 落库用户消息并取出历史（查询改写 + 生成上下文）
    await prisma.kbMessage.create({ data: { convId: conversation.id, role: "user", content: input.content } });
    const history = await prisma.kbMessage.findMany({ where: { convId: conversation.id }, orderBy: { createdAt: "desc" }, take: 11 });
    const chronological = history.slice(1).reverse(); // 不含刚写入的当前问题
    if (conversation.title === "新会话") {
        await prisma.kbConversation.update({ where: { id: conversation.id }, data: { title: input.content.slice(0, 30) } });
    }
    await prisma.kbConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });

    // 前置检索（失败在此阶段返回 JSON 错误，SSE 头尚未发送）
    const chatConfig = await resolveKbModel("chat");
    const previousQuestion = [...chronological].reverse().find((item) => item.role === "user")?.content;
    let searchQuery = input.content;
    if (previousQuestion) {
        const rewritten = await chatOnce(chatConfig, [
            { role: "system", content: "你是检索查询改写助手。把用户的追问改写成一条独立、完整的检索语句，只输出检索语句本身，不要解释。若追问已独立完整则原样输出。" },
            { role: "user", content: `上下文问题：${previousQuestion}\n追问：${input.content}` },
        ]);
        if (rewritten) searchQuery = rewritten.slice(0, 200);
    }
    let embedding: number[] | null = null;
    try {
        const embedConfig = await resolveKbModel("embed");
        [embedding] = await createEmbeddings(embedConfig, [searchQuery]);
    } catch {
        embedding = null; // 向量不可用时退化为纯关键词检索
    }
    const { hits } = await hybridSearch(searchQuery, embedding);

    const citations = hits.map((hit) => ({
        postId: hit.postId,
        chunkId: hit.chunkId,
        title: hit.postTitle,
        heading: hit.heading,
        excerpt: `${hit.heading ? `# ${hit.heading} ` : ""}${hit.content}`.slice(0, 180),
        score: Math.round(hit.score * 1000) / 1000,
    }));

    // 进入 SSE 阶段
    res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    const abort = new AbortController();
    req.on("close", () => abort.abort());
    const saveAssistant = (content: string, cites: typeof citations | null) =>
        prisma.kbMessage.create({ data: { convId: conversation.id, role: "assistant", content, citations: cites === null ? undefined : (cites as never) } });

    if (!hits.length) {
        const answer = "知识库暂无相关内容。你可以换个问法，或到知识库发布一篇帖子补充这部分经验。";
        sseWrite(res, "delta", { delta: answer });
        const message = await saveAssistant(answer, null);
        sseWrite(res, "done", { message, citations: [] });
        return res.end();
    }

    const fragments = hits.map((hit, index) => {
        const heading = hit.heading ? `（小节：${hit.heading}）` : "";
        return `[${index + 1}] 《${hit.postTitle}》${heading}\n${hit.content}`;
    }).join("\n\n---\n\n");
    const prompt = [
        "你是公司内部知识库助手，基于给定的知识片段回答员工问题。",
        "",
        "要求：",
        "1. 综合多篇内容生成答案，不得整段照抄原文；",
        "2. 不同帖子观点冲突时列出分歧并分别标注来源；",
        "3. 每条关键结论后用 [编号] 标注引用，编号对应下方片段序号；",
        "4. 片段不足以回答时明确说“知识库暂无相关内容”，不要编造；",
        "5. 使用简洁中文，步骤类内容用有序列表。",
        "",
        `知识片段：\n${fragments}`,
        "",
        `问题：${input.content}`,
    ].join("\n");

    let full = "";
    try {
        await streamChat(chatConfig, [{ role: "user", content: prompt }], (delta) => {
            full += delta;
            sseWrite(res, "delta", { delta });
        }, abort.signal);
        const message = await saveAssistant(full, citations);
        sseWrite(res, "done", { message, citations });
        res.end();
    } catch (error) {
        if (abort.signal.aborted) {
            // 客户端断开：保留已生成部分，便于下次续看
            if (full) await saveAssistant(full, citations).catch(() => undefined);
            return res.end();
        }
        const text = error instanceof Error ? error.message : "回答生成失败";
        sseWrite(res, "error", { error: text });
        const message = await saveAssistant(`（回答生成失败：${text}）`, citations);
        sseWrite(res, "done", { message, citations });
        res.end();
    }
});

router.post("/chat/messages/:id/feedback", async (req, res) => {
    const input = z.object({ feedback: z.union([z.literal(1), z.literal(-1)]) }).parse(req.body);
    const message = await prisma.kbMessage.findUniqueOrThrow({ where: { id: routeParam(req.params.id) }, include: { conversation: true } });
    if (message.conversation.userId !== req.user!.id) throw Object.assign(new Error("无权评价该回答"), { status: 403 });
    const updated = await prisma.kbMessage.update({ where: { id: message.id }, data: { feedback: input.feedback } });
    res.json({ message: updated });
});

// ===== 管理端 =====

router.get("/admin/stats", requireAdmin, async (_req, res) => {
    const [posts, chunks, conversations, messages, feedback] = await Promise.all([
        prisma.kbPost.groupBy({ by: ["status"], _count: true }),
        prisma.kbChunk.count(),
        prisma.kbConversation.count(),
        prisma.kbMessage.count(),
        prisma.kbMessage.groupBy({ by: ["feedback"], _count: true, where: { feedback: { not: null } } }),
    ]);
    const zeroHit = await prisma.kbMessage.count({ where: { role: "assistant", citations: { equals: Prisma.DbNull } } });
    const failed = await prisma.kbPost.findMany({ where: { indexStatus: "failed" }, select: { id: true, title: true, indexError: true }, take: 10 });
    const typeGroup = await prisma.kbPost.groupBy({ by: ["type"], _count: true, where: { status: "published" } });
    res.json({
        postsByStatus: posts,
        postsByType: typeGroup,
        chunks,
        conversations,
        messages,
        feedback: { useful: feedback.find((item) => item.feedback === 1)?._count || 0, useless: feedback.find((item) => item.feedback === -1)?._count || 0 },
        zeroHitAnswers: zeroHit,
        indexFailures: failed,
    });
});

router.post("/admin/posts/:id/pin-official", requireAdmin, async (req, res) => {
    const input = z.object({ official: z.boolean() }).parse(req.body);
    const post = await prisma.kbPost.update({ where: { id: routeParam(req.params.id) }, data: { official: input.official } });
    res.json({ post: postCard(post) });
});

const settingsInput = z.object({
    chatChannelId: z.string().uuid().nullish(),
    chatModel: z.string().trim().max(120).nullish(),
    embedChannelId: z.string().uuid().nullish(),
    embedModel: z.string().trim().max(120).nullish(),
    dailyLimitPerUser: z.number().int().min(0).max(1000),
});

router.get("/admin/settings", requireAdmin, async (_req, res) => {
    const [settings, channels] = await Promise.all([
        prisma.kbSetting.findUnique({ where: { id: "default" } }),
        prisma.modelChannel.findMany({ where: { enabled: true }, include: { models: { where: { enabled: true, capability: "text" }, orderBy: { name: "asc" } } }, orderBy: { name: "asc" } }),
    ]);
    res.json({
        settings: settings || { id: "default", chatChannelId: null, chatModel: null, embedChannelId: null, embedModel: null, dailyLimitPerUser: 50 },
        channels: channels
            .filter((channel) => channel.apiFormat !== "gemini")
            .map((channel) => ({ id: channel.id, name: channel.name, apiFormat: channel.apiFormat, models: channel.models.map((model) => model.name) })),
    });
});

router.put("/admin/settings", requireAdmin, async (req, res) => {
    const input = settingsInput.parse(req.body);
    for (const [channelId, model] of [[input.chatChannelId, input.chatModel], [input.embedChannelId, input.embedModel]] as const) {
        if (!channelId) continue;
        const channel = await prisma.modelChannel.findUnique({ where: { id: channelId }, include: { models: true } });
        if (!channel) throw Object.assign(new Error("所选渠道不存在"), { status: 400 });
        if (model && !channel.models.some((item) => item.name === model)) throw Object.assign(new Error(`渠道 ${channel.name} 下不存在模型 ${model}`), { status: 400 });
    }
    const settings = await prisma.kbSetting.upsert({
        where: { id: "default" },
        create: { id: "default", ...input },
        update: input,
    });
    res.json({ settings });
});

export const kbRouter = router;
