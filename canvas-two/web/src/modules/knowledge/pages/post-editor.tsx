import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { App, Button, Input, Segmented, Select, Spin } from "antd";
import { ArrowLeft, ImagePlus, LoaderCircle, Save, Send } from "lucide-react";
import MDEditor, { commands, type TextState } from "@uiw/react-md-editor";
import "@uiw/react-md-editor/markdown-editor.css";
import "@uiw/react-markdown-preview/markdown.css";
import { uploadImage } from "@/services/image-storage";
import { useAuthStore } from "@/stores/use-auth-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { createKbPost, getKbPost, listKbCategories, updateKbPost } from "../api";
import type { KbCategory, KbPostType } from "../types";

export default function KnowledgePostEditorPage() {
    const { id } = useParams();
    const location = useLocation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const editing = Boolean(id);
    const theme = useThemeStore((state) => state.theme);

    const [loading, setLoading] = useState(editing);
    const [saving, setSaving] = useState(false);
    const [categories, setCategories] = useState<KbCategory[]>([]);
    const [title, setTitle] = useState("");
    const [type, setType] = useState<KbPostType>("insight");
    const [categoryId, setCategoryId] = useState<string | null>(null);
    const [tags, setTags] = useState<string[]>([]);
    const [content, setContent] = useState("");
    const [status, setStatus] = useState<"draft" | "published">("published");
    const [uploading, setUploading] = useState(false);
    const user = useAuthStore((state) => state.user);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    interface EditorApi {
        setSelectionRange(selection: { start: number; end: number }): unknown;
        replaceSelection(text: string): unknown;
    }
    const editorApiRef = useRef<EditorApi | null>(null);
    const editorStateRef = useRef<TextState | null>(null);

    useEffect(() => {
        listKbCategories().then((result) => setCategories(result.categories)).catch(() => undefined);
    }, []);

    useEffect(() => {
        if (!editing) {
            const preset = (location.state || {}) as { title?: string; content?: string };
            if (preset.title) setTitle(preset.title);
            if (preset.content) setContent(preset.content);
        }
    }, [editing, location.state]);

    useEffect(() => {
        if (!editing || !id) return;
        getKbPost(id)
            .then((result) => {
                setTitle(result.post.title);
                setType(result.post.type);
                setCategoryId(result.post.category?.id || null);
                setTags(result.post.tags);
                setContent(result.post.content);
                setStatus(result.post.status === "draft" ? "draft" : "published");
            })
            .catch((error) => message.error(error instanceof Error ? error.message : "加载失败"))
            .finally(() => setLoading(false));
    }, [editing, id, message]);

    const valid = useMemo(() => title.trim().length > 0 && content.trim().length > 0, [title, content]);

    const insertImages = async (files: File[]) => {
        if (!files.length || !user) return;
        setUploading(true);
        try {
            for (const file of files) {
                const uploaded = await uploadImage(file, user.id, "public", "kb");
                const snippet = `\n![图片](${uploaded.url})\n`;
                const api = editorApiRef.current;
                const state = editorStateRef.current;
                if (api && state) {
                    api.setSelectionRange({ start: state.selection.start, end: state.selection.end });
                    api.replaceSelection(snippet);
                } else {
                    setContent((current) => `${current}${snippet}`);
                }
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : "图片上传失败");
        } finally {
            setUploading(false);
        }
    };

    const imageCommand: commands.ICommand = {
        name: "插入图片",
        keyCommand: "insert-image",
        buttonProps: { "aria-label": "插入图片", title: "插入图片（也可直接粘贴截图）" },
        icon: uploading ? <LoaderCircle className="size-4 animate-spin" /> : <ImagePlus className="size-4" />,
        execute: (state, api) => {
            editorApiRef.current = api;
            editorStateRef.current = state;
            fileInputRef.current?.click();
        },
    };

    const save = async (targetStatus: "draft" | "published") => {
        if (!valid) {
            message.warning("请填写标题和正文");
            return;
        }
        setSaving(true);
        try {
            const input = { title: title.trim(), type, categoryId: categoryId || null, tags, content: content.trim(), status: targetStatus };
            const result = editing && id ? await updateKbPost(id, input) : await createKbPost(input);
            setStatus(targetStatus);
            message.success(targetStatus === "published" ? "已发布，后台正在建立索引" : "草稿已保存");
            navigate(`/knowledge/posts/${result.post.id}`, { replace: true });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "保存失败");
        } finally {
            setSaving(false);
        }
    };

    return (
        <main className="flex h-full flex-col overflow-hidden bg-background text-foreground">
            <header className="flex flex-wrap items-center gap-3 border-b border-border px-6 py-3.5">
                <Button type="text" icon={<ArrowLeft className="size-4" />} onClick={() => navigate(-1)}>返回</Button>
                <h1 className="text-base font-semibold tracking-tight">{editing ? "编辑帖子" : "发布新帖"}</h1>
                <span className="hidden text-xs text-muted-foreground md:inline">支持 Markdown 与图片，发布后自动切分建索引供 AI 检索</span>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                    <Button icon={<Save className="size-4" />} loading={saving} disabled={!valid} onClick={() => void save("draft")}>存为草稿</Button>
                    <Button type="primary" icon={<Send className="size-4" />} loading={saving} disabled={!valid} onClick={() => void save("published")}>{status === "published" && editing ? "保存修改" : "发布"}</Button>
                </div>
            </header>

            <div className="flex-1 overflow-y-auto">
                <Spin spinning={loading}>
                    <div className="mx-auto w-full max-w-4xl px-6 py-6">
                        <Input
                            variant="borderless"
                            value={title}
                            onChange={(event) => setTitle(event.target.value)}
                            placeholder="标题：一句话说清这篇内容解决什么问题"
                            className="!px-0 text-xl font-semibold"
                            maxLength={120}
                            showCount
                        />
                        <div className="mb-5 mt-2 flex flex-wrap items-center gap-3 border-b border-border pb-5">
                            <Segmented
                                value={type}
                                options={[{ value: "insight", label: "心得" }, { value: "workflow", label: "流程" }, { value: "qa", label: "问答" }]}
                                onChange={(value) => setType(value as KbPostType)}
                            />
                            <Select
                                allowClear
                                placeholder="分类"
                                className="w-40"
                                value={categoryId}
                                options={categories.map((item) => ({ value: item.id, label: item.name }))}
                                onChange={(value) => setCategoryId(value)}
                            />
                            <Select
                                mode="tags"
                                placeholder="标签"
                                className="min-w-44 flex-1"
                                value={tags}
                                maxCount={10}
                                onChange={(value) => setTags(value as string[])}
                                tokenSeparators={[",", "，", " "]}
                            />
                        </div>

                        <div
                            data-color-mode={theme}
                            onPaste={(event) => {
                                const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
                                if (!files.length) return;
                                event.preventDefault();
                                void insertImages(files);
                            }}
                        >
                            <MDEditor
                                value={content}
                                onChange={(value) => setContent(value || "")}
                                height={540}
                                preview="live"
                                extraCommands={[imageCommand, commands.fullscreen]}
                                textareaProps={{ placeholder: "用 Markdown 记录：背景、步骤、踩坑点、结论… 支持直接粘贴截图" }}
                            />
                        </div>
                        <p className="mt-3 text-xs text-muted-foreground">图片上传到服务器后插入正文；从正文删除图片并保存后，服务器上的对应文件会自动清理。</p>
                    </div>
                </Spin>
            </div>

            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                    const files = Array.from(event.target.files || []);
                    event.target.value = "";
                    void insertImages(files);
                }}
            />
        </main>
    );
}
