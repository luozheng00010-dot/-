export type KbPostType = "insight" | "workflow" | "qa";
export type KbPostStatus = "draft" | "published" | "archived";

export interface KbAuthor {
    id: string;
    username: string;
}

export interface KbCategory {
    id: string;
    name: string;
    sort: number;
    postCount?: number;
}

export interface KbPostCard {
    id: string;
    title: string;
    type: KbPostType;
    tags: string[];
    status: KbPostStatus;
    official: boolean;
    viewCount: number;
    indexStatus: "pending" | "indexing" | "indexed" | "failed";
    excerpt: string;
    commentCount: number;
    category: { id: string; name: string } | null;
    author: KbAuthor;
    createdAt: string;
    updatedAt: string;
}

export interface KbPostDetail extends KbPostCard {
    content: string;
}

export interface KbComment {
    id: string;
    postId: string;
    authorId: string;
    content: string;
    parentId: string | null;
    createdAt: string;
    author: KbAuthor;
}

export interface KbCitation {
    postId: string;
    chunkId: string;
    title: string;
    heading: string | null;
    excerpt: string;
    score: number;
}

export interface KbMessage {
    id: string;
    convId: string;
    role: "user" | "assistant";
    content: string;
    citations: KbCitation[] | null;
    feedback: 1 | -1 | null;
    createdAt: string;
}

export interface KbConversation {
    id: string;
    userId: string;
    title: string;
    createdAt: string;
    updatedAt: string;
}

export interface KbSettings {
    id: string;
    chatChannelId: string | null;
    chatModel: string | null;
    embedChannelId: string | null;
    embedModel: string | null;
    dailyLimitPerUser: number;
}

export interface KbChannelOption {
    id: string;
    name: string;
    apiFormat: string;
    models: string[];
}

export interface KbStats {
    postsByStatus: { status: string; _count: number }[];
    postsByType: { type: string; _count: number }[];
    chunks: number;
    conversations: number;
    messages: number;
    feedback: { useful: number; useless: number };
    zeroHitAnswers: number;
    indexFailures: { id: string; title: string; indexError: string | null }[];
}
