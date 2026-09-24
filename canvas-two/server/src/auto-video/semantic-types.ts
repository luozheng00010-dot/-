import { z } from "zod";

export const FPS = 30;
export const annotationInput = z.object({
    summary: z.string().trim().min(1).max(2000), parts: z.array(z.string().max(100)).max(30),
    actions: z.array(z.string().max(100)).max(30), tags: z.array(z.string().max(100)).max(40),
    shot: z.string().max(200), scene: z.string().max(300), colors: z.array(z.string().max(50)).max(15),
    warnings: z.array(z.string().max(300)).max(15), generic: z.boolean(), needsReview: z.boolean(),
    // 上传素材时填写的人工备注（产品卖点、型号、颜色等文字信息），随标注一起
    // 进入向量索引和标签召回；旧数据没有该字段时按空串处理。
    userNotes: z.string().max(500).default(""),
});
export type Annotation = z.infer<typeof annotationInput>;
// 镜头接缝转场效果。方案级 video_transition 是全局默认；镜头上单独设置则覆盖该接缝
// （"none" 表示这个接缝强制硬切），不设置则跟随全局（含 shuffle 每段随机）。
export const transitionEffect = z.enum(["none", "fade", "slide_left", "slide_right", "slide_up", "wipe_left", "circle_open", "radial", "pixelize", "hblur", "shuffle"]);
export type TransitionEffect = z.infer<typeof transitionEffect>;
// 模型偶尔把数组字段写成逗号分隔的字符串，先按常见分隔符拆回数组再进校验，
// 避免一次格式抖动直接把任务判死。支持对象和对象数组。
export function coerceStringArrays(value: unknown, keys: string[]): unknown {
    if (Array.isArray(value)) return value.map((entry) => coerceStringArrays(entry, keys));
    if (!value || typeof value !== "object") return value;
    const record = { ...(value as Record<string, unknown>) };
    for (const key of keys) {
        const field = record[key];
        if (typeof field === "string") record[key] = field.split(/[,，、;；|]/).map((entry) => entry.trim()).filter(Boolean);
    }
    return record;
}
export function normalizeAnnotation(value: unknown): unknown {
    return coerceStringArrays(value, ["parts", "actions", "tags", "colors", "warnings"]);
}
// 颜色同义词归一：视觉模型对同一颜色常造不同词（橘色/橙色/桔色、玫红/粉色），
// 检索与匹配都按归一后的标准色名进行。键做子串替换（最长优先），值去重。
const COLOR_ALIASES: [string, string][] = ([
    ["橘黄色", "橙"], ["橙黄色", "橙"], ["桔黄色", "橙"], ["橘红色", "橙"], ["桔红色", "橙"], ["橘红", "橙"], ["桔红", "橙"],
    ["橘色", "橙"], ["桔色", "橙"], ["橙色", "橙"],
    ["柠檬黄", "黄"], ["鹅黄色", "黄"], ["奶黄色", "黄"], ["明黄色", "黄"], ["土黄色", "黄"], ["鹅黄", "黄"], ["奶黄", "黄"], ["明黄", "黄"], ["土黄", "黄"], ["黄色", "黄"],
    ["桃粉色", "粉"], ["粉红色", "粉"], ["玫红色", "粉"], ["桃红色", "粉"], ["西瓜红", "红"], ["桃红", "粉"], ["玫红", "粉"], ["粉色", "粉"],
    ["天蓝色", "蓝"], ["湖蓝色", "蓝"], ["宝蓝色", "蓝"], ["藏蓝色", "蓝"], ["深蓝色", "蓝"], ["浅蓝色", "蓝"], ["淡蓝色", "蓝"],
    ["天蓝", "蓝"], ["湖蓝", "蓝"], ["宝蓝", "蓝"], ["藏青", "蓝"], ["深蓝", "蓝"], ["浅蓝", "蓝"], ["淡蓝", "蓝"], ["蓝色", "蓝"],
    ["草绿色", "绿"], ["墨绿色", "绿"], ["浅绿色", "绿"], ["草绿", "绿"], ["墨绿", "绿"], ["浅绿", "绿"], ["绿色", "绿"],
    ["淡紫色", "紫"], ["浅紫色", "紫"], ["深紫色", "紫"], ["淡紫", "紫"], ["浅紫", "紫"], ["深紫", "紫"], ["紫色", "紫"],
    ["大红色", "红"], ["深红色", "红"], ["酒红色", "红"], ["浅红色", "红"], ["橘红", "橙"], ["桔红", "橙"], ["大红", "红"], ["深红", "红"], ["酒红", "红"], ["浅红", "红"], ["红色", "红"],
    ["咖啡色", "棕"], ["卡其色", "棕"], ["褐色", "棕"], ["驼色", "棕"], ["棕色", "棕"],
    ["银灰色", "灰"], ["浅灰色", "灰"], ["深灰色", "灰"], ["银灰", "灰"], ["浅灰", "灰"], ["深灰", "灰"], ["灰色", "灰"],
    ["奶油色", "米色"], ["米白色", "米色"], ["杏色", "米色"], ["裸色", "米色"], ["米色", "米色"],
    ["肉色", "肤色"], ["象牙白", "白"], ["香槟色", "香槟"],
    ["黑色", "黑"], ["白色", "白"], ["金色", "金"], ["银色", "银"],
] as [string, string][]).sort((a, b) => b[0].length - a[0].length);

export function normalizeColors(colors: string[]): string[] {
    const out: string[] = [];
    for (const raw of colors) {
        if (typeof raw !== "string") continue;
        let value = raw;
        for (const [alias, canonical] of COLOR_ALIASES) {
            if (value.includes(alias)) value = value.split(alias).join(canonical);
        }
        if (value.trim() && !out.includes(value)) out.push(value);
    }
    return out;
}
export const renderOptions = z.object({
    video_aspect: z.enum(["9:16", "16:9", "1:1"]).default("9:16"), video_fit_mode: z.enum(["cover", "contain"]).default("cover"),
    // 镜头拼接转场：交叉融合（xfade），默认无转场（硬切，流拷贝拼接）。固定 0.3 秒。
    video_transition: transitionEffect.default("none"),
    subtitle_enabled: z.boolean().default(true), subtitle_position: z.enum(["top", "bottom", "center", "custom", "two_thirds_bottom"]).default("bottom"),
    font_name: z.string().regex(/^[^/\\:\x00]+\.(ttf|ttc|otf)$/i).default("MicrosoftYaHeiBold.ttc"), font_size: z.number().int().min(24).max(120).default(60),
    text_fore_color: z.string().regex(/^#[a-f\d]{6}$/i).default("#FFFFFF"), stroke_color: z.string().regex(/^#[a-f\d]{6}$/i).default("#000000"),
    stroke_width: z.number().min(0).max(4).default(1.5), custom_position: z.number().min(0).max(100).default(70),
    voice_volume: z.number().min(0).max(2).default(1), bgm_type: z.enum(["none", "random", "custom"]).default("none"),
    bgm_file: z.string().max(255).refine((v) => !v.includes("/") && !v.includes("\\") && !v.includes(":") && !v.includes("\0") && v !== "." && v !== "..").default(""), bgm_volume: z.number().min(0).max(1).default(0.2),
}).refine((v) => v.bgm_type !== "custom" || !!v.bgm_file, "请选择背景音乐");
export const planInput = z.object({
    script: z.string().min(1).max(20000).refine((s) => !!s.trim(), "请输入原文"),
    skuId: z.string().uuid(), categoryIds: z.array(z.string().uuid()).min(1).max(100),
    voiceName: z.string().min(1).max(200), voiceRate: z.number().min(0.5).max(2),
    count: z.number().int().min(1).max(5).default(1), options: renderOptions,
});
export type PlanInput = z.infer<typeof planInput>;
export type Candidate = { id: string; fileKey: string; fileName: string; duration: number; width: number; height: number; revision: number; annotation: Annotation; grade: "strong" | "uncertain" | "none"; relevance: number; fitScore: number; reason: string; missing: string[] };
export type Shot = { materialId: string; sourceStart: number; sourceEnd: number; speed: number; frames: number; manual: boolean; transition?: TransitionEffect };
export type Unit = { start: number; end: number; text: string; query: string; tags: string[]; evidence: string[]; generic: boolean; startFrame: number; endFrame: number; candidates: Candidate[] };
export type UnitEdit = { shots: Shot[]; confirmed: boolean; allowRepeat: boolean };
export type PlanDocument = { audioKey: string; duration: number; fps: number; units: Unit[]; variants: UnitEdit[][]; options: z.infer<typeof renderOptions>; embeddingKey: string };
export const shotInput = z.object({ materialId: z.string().uuid(), sourceStart: z.number().finite().min(0), sourceEnd: z.number().finite().positive(), speed: z.number().min(0.8).max(1), manual: z.boolean().default(true), transition: transitionEffect.optional() });
export const editInput = z.object({ variant: z.number().int().min(0).max(4), unit: z.number().int().min(0), shots: z.array(shotInput).max(200), confirmed: z.boolean(), allowRepeat: z.boolean() });
export const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });

export function validateUnits(script: string, units: Array<{ start: number; end: number }>) {
    let cursor = 0;
    for (const unit of units) {
        if (!Number.isInteger(unit.start) || !Number.isInteger(unit.end) || unit.start !== cursor || unit.end <= cursor || unit.end > script.length || !script.slice(unit.start, unit.end).trim()) throw fail("模型拆句未完整保留原文，请重新匹配", 422);
        cursor = unit.end;
    }
    if (cursor !== script.length) throw fail("模型拆句遗漏原文，请重新匹配", 422);
}

export function allocateShots(candidates: Candidate[], frames: number, used: Set<string>, batchUsage: Map<string, number>): Shot[] {
    const eligible = candidates.filter((c) => c.grade === "strong" && !c.missing.length && c.duration >= 0.5 && !used.has(c.id));
    eligible.sort((a, b) => b.relevance - a.relevance || b.fitScore - a.fitScore || (batchUsage.get(a.id) ?? 0) - (batchUsage.get(b.id) ?? 0));
    const shots: Shot[] = [];
    let left = frames;
    for (const c of eligible) {
        if (left <= 0) break;
        let take = Math.min(left, Math.floor(c.duration * FPS));
        if (take < 15) {
            const previous = shots.at(-1);
            const borrow = 15 - take;
            if (!previous || Math.floor(c.duration * FPS) < 15) continue;
            if (previous.frames - borrow < 15) {
                if (Math.floor(c.duration * FPS) < left + previous.frames) continue;
                shots.pop(); used.delete(previous.materialId);
                batchUsage.set(previous.materialId, Math.max(0, (batchUsage.get(previous.materialId) ?? 1)-1));
                left += previous.frames; take = left;
            } else {
                previous.frames -= borrow; previous.sourceEnd -= borrow / FPS;
                left += borrow; take = 15;
            }
        }
        shots.push({ materialId: c.id, sourceStart: 0, sourceEnd: take / FPS, speed: 1, frames: take, manual: false });
        used.add(c.id); batchUsage.set(c.id, (batchUsage.get(c.id) ?? 0) + 1); left -= take;
    }
    return shots;
}

export function validateVariant(doc: PlanDocument, variant: UnitEdit[], requireComplete = true) {
    if (variant.length !== doc.units.length) throw fail("方案句子数量不一致");
    const used = new Set<string>();
    variant.forEach((edit, i) => {
        const unit = doc.units[i];
        for (const shot of edit.shots) {
            const c = unit.candidates.find((item) => item.id === shot.materialId);
            if (!c || shot.sourceStart < 0 || shot.sourceEnd > c.duration + 0.0001 || shot.sourceEnd <= shot.sourceStart || shot.speed < 0.8 || shot.speed > 1 || !Number.isFinite(shot.frames) || shot.frames <= 0) throw fail("镜头引用、截取区间或速度无效");
            const expected = Math.floor((shot.sourceEnd - shot.sourceStart) / shot.speed * FPS + 1e-6);
            if (expected !== shot.frames) throw fail("镜头帧数与源区间不一致");
            if ((c.duration >= 0.5 && shot.frames < 15) || (c.duration < 0.5 && !shot.manual)) throw fail("裁剪后的镜头不能短于 0.5 秒；超短原片仅可人工指定");
            if (!shot.manual && (shot.speed !== 1 || c.grade !== "strong" || c.missing.length)) throw fail("自动匹配不能使用不确定、缺证据或慢放镜头");
            if (used.has(c.id) && c.grade === "none") throw fail("不能重复使用不相关素材");
            if (used.has(c.id) && !edit.allowRepeat) throw fail("重复使用素材需要明确允许");
            if (requireComplete && !edit.confirmed) throw fail("请逐句确认匹配画面");
            used.add(c.id);
        }
        if (requireComplete && edit.shots.reduce((sum, shot) => sum + shot.frames, 0) !== unit.endFrame - unit.startFrame) throw fail(`「${unit.text}」仍有时长缺口或超出，请调整镜头`);
    });
}
