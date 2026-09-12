import { lazy } from "react";
import { Library } from "lucide-react";

import { registerModule } from "../registry";

const PostsPage = lazy(() => import("./pages/posts"));
const PostDetailPage = lazy(() => import("./pages/post-detail"));
const PostEditorPage = lazy(() => import("./pages/post-editor"));
const ChatPage = lazy(() => import("./pages/chat"));
const AdminPage = lazy(() => import("./pages/admin"));

registerModule({
    id: "knowledge",
    nav: [
        {
            key: "knowledge",
            label: "公司知识库",
            icon: Library,
            path: "/knowledge",
            group: "专业工具",
            children: [
                { key: "knowledge-posts", label: "帖子", path: "/knowledge/posts" },
                { key: "knowledge-chat", label: "AI 问答", path: "/knowledge/chat" },
                { key: "knowledge-admin", label: "管理设置", path: "/knowledge/admin" },
            ],
        },
    ],
    routes: [
        { path: "/knowledge", Component: lazy(() => import("./pages/redirect")) },
        { path: "/knowledge/posts", Component: PostsPage },
        { path: "/knowledge/posts/new", Component: PostEditorPage },
        { path: "/knowledge/posts/:id", Component: PostDetailPage },
        { path: "/knowledge/posts/:id/edit", Component: PostEditorPage },
        { path: "/knowledge/chat", Component: ChatPage },
        { path: "/knowledge/chat/:id", Component: ChatPage },
        { path: "/knowledge/admin", Component: AdminPage },
    ],
    home: {
        title: "公司知识库",
        description: "公司文档沉淀、语义检索与 AI 问答",
        icon: Library,
        href: "/knowledge/posts",
        tone: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
    },
});
