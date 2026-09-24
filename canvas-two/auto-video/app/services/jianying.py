"""剪映专业版草稿导出：把时间线写成 draft_content.json + draft_meta_info.json。

画面轨道放素材片段与黑场缺口，旁白单独放音频轨道，字幕单独放文本轨道，
符合"声音和画面分开"的剪辑习惯。基于社区库 pyJianYingDraft 生成格式。
默认把用到的素材复制进草稿目录（引用仍写绝对路径——剪映不支持草稿内
相对路径，写成相对路径会被当成云端资源报"素材下载失败"）。
"""
import shutil
import wave
from pathlib import Path

from fastapi import HTTPException
from PIL import Image
from pyJianYingDraft import (
    AudioSegment,
    DraftFolder,
    TextBorder,
    TextSegment,
    TextStyle,
    Timerange,
    TrackSpec,
    TrackType,
    VideoMaterial,
    VideoSegment,
)

from .semantic import FPS, directory, source

ASPECTS = {"9:16": (1080, 1920), "16:9": (1920, 1080), "1:1": (1080, 1080)}
US = 1_000_000


def fail(message):
    raise HTTPException(422, message)


def _sanitize_name(name: str) -> str:
    cleaned = "".join(c if c not in '\\/:*?"<>|' else "_" for c in name).strip()
    return cleaned[:80] or "自动剪辑方案"


def export_draft(body: dict) -> dict:
    options = dict(body["options"])
    aspect = options.get("video_aspect", "9:16")
    if aspect not in ASPECTS:
        fail("输出画幅无效")
    width, height = ASPECTS[aspect]
    root = Path(body["folder"])
    if not root.is_dir():
        fail("剪映草稿目录不存在")
    name = _sanitize_name(body["name"])

    draft = DraftFolder(str(root)).create_draft(name, width, height, fps=FPS)
    draft_path = root / name
    # 黑场占位图与旁白音频都放进草稿目录，避免外部产物被清理后草稿失声/缺图。
    black = draft_path / "black.png"
    Image.new("RGB", (width, height), (0, 0, 0)).save(black)
    audio_src = directory(body["audioKey"]) / "audio.wav"
    if not audio_src.is_file():
        fail("已确认配音产物不存在，请重新匹配")
    audio_dst = draft_path / "voice.wav"
    shutil.copyfile(audio_src, audio_dst)
    with wave.open(str(audio_dst)) as wav:
        audio_us = round(wav.getnframes() / wav.getframerate() * US)

    # 打包素材：把每条镜头引用的源视频复制进草稿目录 media/，同名文件自动加序号避让。
    pack = bool(body.get("pack_materials", True))
    media_dir = draft_path / "media"
    packed: dict[str, Path] = {}
    used_names: set[str] = set()

    def material_path(key: str) -> Path:
        if key in packed:
            return packed[key]
        src = source(key)
        if pack:
            if not src.is_file():
                fail(f"素材文件缺失，无法打包：{src.name}")
            media_dir.mkdir(exist_ok=True)
            stem, suffix = src.stem, src.suffix
            name, counter = src.name, 1
            while name.lower() in used_names:
                name = f"{stem}-{counter}{suffix}"
                counter += 1
            used_names.add(name.lower())
            target = media_dir / name
            shutil.copyfile(src, target)
        else:
            target = src
        packed[key] = target
        return target

    video_track = draft.append_track(TrackSpec(TrackType.video, name="画面", mute=False))
    for entry in body["entries"]:
        target = Timerange(round(entry["startFrame"] / FPS * US), round(entry["frames"] / FPS * US))
        if entry["type"] == "gap":
            draft.add_segment(VideoSegment(str(black), target), video_track)
            continue
        key = entry["fileKey"]
        source_range = Timerange(round(entry["sourceStart"] * US), round((entry["sourceEnd"] - entry["sourceStart"]) * US))
        draft.add_segment(VideoSegment(VideoMaterial(str(material_path(key))), target, source_timerange=source_range, volume=0.0), video_track)

    voice_track = draft.append_track(TrackSpec(TrackType.audio, name="旁白", mute=False))
    draft.add_segment(
        AudioSegment(str(audio_dst), Timerange(0, audio_us), volume=float(options.get("voice_volume", 1))),
        voice_track,
    )

    if options.get("subtitle_enabled", True):
        font_size = float(options.get("font_size", 60))
        style = TextStyle(size=max(2.0, min(20.0, font_size / height * 100)), align=1)
        border = TextBorder(width=min(100.0, float(options.get("stroke_width", 1.5)) * 20))
        text_track = draft.append_track(TrackSpec(TrackType.text, name="字幕", mute=False))
        for unit in body["units"]:
            target = Timerange(round(unit["startFrame"] / FPS * US), round((unit["endFrame"] - unit["startFrame"]) / FPS * US))
            draft.add_segment(TextSegment(unit["text"], target, style=style, border=border), text_track)

    draft.save()
    return {"name": name, "path": str(draft_path)}
