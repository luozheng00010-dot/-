import { useEffect, useRef, useState } from "react";
import { Alert, Button, Space } from "antd";
import { localVideoUrl } from "@/services/local-materials";
import { planAudio, type Plan } from "../semantic-api";

/** Audio is the preview clock; source clips are sought against the saved timeline. */
export default function PlanPreview({ plan, variant, unit }: { plan: Plan; variant: number; unit?: number }) {
    const audio = useRef<HTMLAudioElement>(null), video = useRef<HTMLVideoElement>(null);
    const [error, setError] = useState(""), [caption, setCaption] = useState("");
    const doc = plan.document!;
    const start = unit === undefined ? 0 : doc.units[unit].startFrame / doc.fps;
    const end = unit === undefined ? doc.duration : doc.units[unit].endFrame / doc.fps;
    useEffect(() => {
        const a = audio.current!, v = video.current!;
        let raf = 0, previous = "";
        function sync() {
            if (a.currentTime >= end) { a.pause(); v.pause(); return; }
            const frame = Math.floor(a.currentTime * doc.fps);
            const index = doc.units.findIndex((u) => u.startFrame <= frame && u.endFrame > frame);
            const u = doc.units[index];
            if (!u) return;
            setCaption(u.text);
            let offset = u.startFrame;
            const shots = doc.variants[variant][index].shots;
            const shot = shots.find((s) => { if (frame < offset + s.frames) return true; offset += s.frames; return false; });
            if (!shot) { a.pause(); v.pause(); setError("此处缺少画面，请处理缺口后继续预览"); return; }
            const key = `${index}:${offset}:${shot.materialId}`;
            const target = shot.sourceStart + (a.currentTime - offset / doc.fps) * shot.speed;
            if (key !== previous) {
                previous = key;
                const resume = !a.paused;
                a.pause(); v.pause();
                v.src = localVideoUrl(shot.materialId);
                v.onloadedmetadata = () => { v.currentTime = target; v.playbackRate = shot.speed; };
                v.oncanplay = () => {
                    v.oncanplay = null;
                    if (resume) void v.play().then(() => a.play()).catch(() => { a.pause(); setError("浏览器无法播放该素材，请单独预览检查编码"); });
                };
            } else if (v.readyState >= 2) {
                if (Math.abs(v.currentTime-target) > .12) v.currentTime = target;
                if (!a.paused && v.paused) void v.play().catch(() => undefined);
            }
        }
        function tick() { if (!a.paused) sync(); raf = requestAnimationFrame(tick); }
        a.onseeked = sync;
        a.onpause = () => v.pause();
        a.currentTime = start;
        sync(); tick();
        return () => { cancelAnimationFrame(raf); a.pause(); v.pause(); a.onseeked = null; a.onpause = null; v.onloadedmetadata = null; v.oncanplay = null; };
    }, [doc, variant, start, end]);
    return <div className="flex flex-col gap-3">
        <Alert type="info" title="轻量预览使用已保存的旁白与镜头顺序；最终字幕样式、BGM 在出片时合成。遇到缺口会暂停。" />
        {error && <Alert type="warning" title={error} />}
        <video ref={video} muted playsInline className="mx-auto max-h-[48vh] w-full" style={{ aspectRatio: doc.options.video_aspect.replace(":", "/"), objectFit: doc.options.video_fit_mode === "cover" ? "cover" : "contain" }} onError={() => { audio.current?.pause(); setError("素材播放失败，请检查文件和浏览器编码支持"); }} />
        {doc.options.subtitle_enabled && <p className="text-center">{caption}</p>}
        <audio ref={audio} src={planAudio(plan.id)} controls className="w-full" />
        <Space><Button onClick={() => { setError(""); if (audio.current) { audio.current.currentTime = start; void audio.current.play().catch(() => setError("配音播放失败")); } }}>从{unit === undefined ? "开头" : "本句"}播放</Button><Button onClick={() => audio.current?.pause()}>暂停</Button></Space>
    </div>;
}
