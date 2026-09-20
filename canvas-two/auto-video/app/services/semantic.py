"""Semantic media operations. No random selection, looping, freeze or legacy combine calls."""
import base64
import hashlib
import io
import json
import math
import re
import subprocess
import wave
from html import unescape
from pathlib import Path
from uuid import UUID

from filelock import FileLock, Timeout
from fastapi import HTTPException
from moviepy import VideoFileClip
from PIL import Image, UnidentifiedImageError
from app.services import voice, video, material_upload, bgm
from app.models.schema import VideoParams
from app.utils import utils

FPS = 30
RATE = 48000


def fail(message):
    raise HTTPException(422, message)


def directory(key):
    try:
        key = str(UUID(key))
    except (ValueError, TypeError):
        fail("产物键无效")
    path = Path(utils.storage_dir("semantic", create=True)) / key
    path.mkdir(exist_ok=True)
    return path


def source(key):
    if not isinstance(key, str) or not re.fullmatch(r"[0-9a-f]{32}\.(mp4|mov|avi|flv|mkv|webm)", key):
        fail("素材文件键无效")
    # 自定义存储位置优先、默认目录兜底，更换位置后旧素材仍可被探测与渲染。
    found = material_upload.find_material_file(key)
    if not found:
        fail("素材文件不存在")
    return Path(found).resolve()


def run(args):
    try:
        result = subprocess.run([utils.get_ffmpeg_binary(), "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], capture_output=True, timeout=1800)
    except subprocess.TimeoutExpired:
        raise HTTPException(503, "媒体处理超时")
    if result.returncode:
        fail("媒体解码或编码失败，请检查文件与 FFmpeg 配置")


def atomic_json(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)


def cached(kind, body, callback):
    folder = directory(body["requestId"])
    digest = hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    try:
        with FileLock(str(folder / "process.lock"), timeout=1):
            signature = folder / "signature.json"
            if signature.exists() and json.loads(signature.read_text()) != {"kind": kind, "digest": digest}:
                raise HTTPException(409, "请求标识已用于不同内容")
            atomic_json(signature, {"kind": kind, "digest": digest})
            result = folder / "result.json"
            if result.exists():
                return json.loads(result.read_text(encoding="utf-8"))
            value = callback(folder)
            atomic_json(result, value)
            return value
    except Timeout:
        raise HTTPException(503, "同一媒体任务仍在处理中，请稍后查询")


# 视觉标注只需看清画面内容，不需要原片分辨率。帧统一缩到 640px 以内，
# 既控制视觉模型 token，也避免 4K 素材在 Python 侧整帧解码的内存与耗时。
ANNOTATION_FRAME_MAX_EDGE = 640


def annotation_frame_stamps(duration: float) -> tuple:
    """按时长选择抽帧时间点：短素材相邻帧几乎相同，抽多了纯浪费视觉 token。"""
    if duration <= 1:
        return (0.3, 0.7)
    if duration <= 2:
        return (0.2, 0.5, 0.8)
    if duration <= 4:
        return (0.15, 0.4, 0.6, 0.85)
    return (0.1, 0.3, 0.5, 0.7, 0.9)


def _extract_annotation_frame(path, timestamp):
    """用 ffmpeg 在指定时间点抽一帧并缩放到 640px 以内，返回 JPEG 字节。"""
    scale = f"scale='min({ANNOTATION_FRAME_MAX_EDGE},iw)':-2"
    try:
        rendered = subprocess.run(
            [
                utils.get_ffmpeg_binary(),
                "-nostdin",
                "-v",
                "error",
                "-xerror",
                "-ss",
                f"{timestamp:.3f}",
                "-i",
                str(path),
                "-frames:v",
                "1",
                "-an",
                "-vf",
                scale,
                "-f",
                "image2pipe",
                "-vcodec",
                "mjpeg",
                "-q:v",
                "4",
                "pipe:1",
            ],
            capture_output=True,
            timeout=120,
            check=False,
        )
    except OSError as exc:
        raise HTTPException(503, "媒体处理工具不可用，请检查 FFmpeg 配置") from exc
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(503, "素材帧抽取超时") from exc
    if rendered.returncode != 0 or not rendered.stdout:
        fail("素材帧抽取失败，请检查视频文件是否损坏")
    try:
        with Image.open(io.BytesIO(rendered.stdout)) as image:
            image.verify()
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        fail("素材帧抽取结果无效，请检查视频文件是否损坏")
    return rendered.stdout


def probe(key):
    # 元数据仍用 moviepy 读封装头（不解码视频流，4K 也一样快）；
    # 帧抽取交给 ffmpeg 边解码边缩放，避免整帧解码进 Python。
    path = source(key)
    try:
        clip = VideoFileClip(str(path), audio=False)
    except OSError:
        fail("素材无法解析，请检查视频文件是否损坏")
    with clip:
        if not clip.duration or not math.isfinite(clip.duration) or clip.duration <= 0:
            fail("素材时长无效")
        duration, width, height, fps = clip.duration, clip.w, clip.h, clip.fps
    frames = [
        "data:image/jpeg;base64," + base64.b64encode(_extract_annotation_frame(path, duration * fraction)).decode()
        for fraction in annotation_frame_stamps(duration)
    ]
    return dict(duration=duration, width=width, height=height, fps=fps, thumbnail=frames[len(frames)//2], frames=frames)


def normalize(text):
    return "".join(c.lower() for c in unescape(text) if c.isalnum())


def align_cues(units, cues, samples):
    # Accept only actual Edge cue events. Other providers may fabricate proportional offsets.
    if not cues or "".join(normalize(c[0]) for c in cues) != "".join(normalize(t) for t in units):
        return None
    previous_end = 0
    for _, start, end in cues:
        if not all(math.isfinite(v) for v in (start,end)) or start < previous_end - .01 or end <= start or end > samples/RATE+.05:
            return None
        previous_end = end
    boundaries, cursor, cue_index = [0], 0, 0
    for text in units[:-1]:
        target = cursor + len(normalize(text))
        while cue_index < len(cues) and cursor < target:
            cursor += len(normalize(cues[cue_index][0]))
            cue_index += 1
        if cursor != target or cue_index == len(cues):
            return None
        # Place semantic boundary at the next spoken unit; retain natural pauses.
        boundaries.append(round(cues[cue_index][1] * FPS))
    boundaries.append(math.ceil(samples / RATE * FPS))
    if any(a >= b for a, b in zip(boundaries, boundaries[1:])):
        return None
    return boundaries


def pcm(path):
    with wave.open(str(path), "rb") as wav:
        if wav.getframerate() != RATE or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
            fail("配音 PCM 格式无效")
        return wav.readframes(wav.getnframes())


def synthesize(folder, name, text, voice_name, rate):
    wav = folder / f"{name}.wav"
    cues_file = folder / f"{name}.json"
    if wav.exists() and cues_file.exists():
        return pcm(wav), json.loads(cues_file.read_text(encoding="utf-8"))
    audio = folder / f"{name}.mp3"
    maker = voice.tts(text=text, voice_name=voice.parse_voice_name(voice_name), voice_rate=rate, voice_file=str(audio))
    if not audio.exists() or audio.stat().st_size == 0:
        raise HTTPException(503, "配音失败，未生成有效音频")
    run(["-i", audio, "-ar", RATE, "-ac", 1, "-c:a", "pcm_s16le", wav])
    cues = [(c.content, c.start.total_seconds(), c.end.total_seconds()) for c in getattr(maker, "cues", [])]
    atomic_json(cues_file, cues)
    data = pcm(wav)
    if not data:
        fail("配音没有有效音频样本")
    return data, cues


def audio(body):
    units, script = body["units"], body["script"]
    if not units or "".join(units) != script or any(not t.strip() for t in units):
        fail("配音语义单元未完整保留原文")
    if utils.has_pause_tags(script):
        fail("请使用普通旁白文本，语义剪辑暂不接受停顿控制标签")

    def build(folder):
        previous = None
        if body.get("previousAudioKey"):
            previous_folder = directory(body["previousAudioKey"])
            previous_result = previous_folder / "result.json"
            if not previous_result.is_file():
                fail("原配音产物不可用，请重建整个方案")
            previous = json.loads(previous_result.read_text(encoding="utf-8"))
            previous_data = pcm(previous_folder / "audio.wav")
            if len(previous["units"]) != len(units):
                fail("局部配音的语义单元数量发生变化")
            data, boundaries = b"", None
        else:
            data, cues = synthesize(folder, "whole", script, body["voiceName"], body["voiceRate"])
            boundaries = align_cues(units, cues, len(data)//2)
        mode = "whole"
        if boundaries is None:
            mode, data, sample_count, boundaries = "segments", b"", 0, [0]
            for i, text in enumerate(units):
                if previous and previous["units"][i]["text"] == text:
                    old = previous["units"][i]
                    part = previous_data[old["startFrame"]*(RATE//FPS)*2:old["endFrame"]*(RATE//FPS)*2]
                else:
                    part, _ = synthesize(folder, f"unit-{i}", text, body["voiceName"], body["voiceRate"])
                data += part
                sample_count += len(part)//2
                boundaries.append(round(sample_count / RATE * FPS))
            boundaries[-1] = math.ceil(sample_count / RATE * FPS)
        if any(a >= b for a, b in zip(boundaries, boundaries[1:])):
            fail("配音对齐失败，语义单元音频过短")
        # Only append sub-frame audio silence; footage itself never freezes or loops.
        total_samples = boundaries[-1] * (RATE // FPS)
        data += b"\0" * max(0, total_samples * 2 - len(data))
        with wave.open(str(folder / "audio.wav"), "wb") as wav:
            wav.setnchannels(1); wav.setsampwidth(2); wav.setframerate(RATE); wav.writeframes(data)
        return {"audioKey": body["requestId"], "duration": total_samples / RATE, "mode": mode,
                "units": [{"text": text, "startFrame": a, "endFrame": b} for text, a, b in zip(units, boundaries, boundaries[1:])]}
    return cached("audio", body, build)


def timestamp(frame):
    ms = round(frame / FPS * 1000)
    return f"{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}"


def render(body):
    def build(folder):
        audio_folder = directory(body["audioKey"])
        audio_path = audio_folder / "audio.wav"
        if not audio_path.is_file():
            fail("已确认配音产物不存在，请重新匹配")
        audio_result = audio_folder / "result.json"
        if not audio_result.exists() or json.loads(audio_result.read_text(encoding="utf-8"))["units"] != body["units"]:
            fail("渲染语义单元与已生成配音不一致")
        options = dict(body["options"])
        aspect = options.get("video_aspect", "9:16")
        if aspect not in ("9:16", "16:9", "1:1") or options.get("video_fit_mode", "cover") not in ("cover", "contain"):
            fail("输出画幅无效")
        for key in ("font_name", "bgm_file"):
            name = options.get(key, "")
            if any(c in name for c in ("/", "\\", ":", "\0")) or name in (".", ".."):
                fail("字体或音乐文件键无效")
        if options.get("bgm_type") == "custom":
            try:
                options["bgm_file"] = bgm.resolve_bgm_file(options["bgm_file"])
            except ValueError:
                fail("背景音乐不存在")
        elif options.get("bgm_type") == "none":
            options["bgm_type"] = ""
            options["bgm_file"] = ""
        else:
            options["bgm_file"] = ""
        width, height = {"9:16": (1080,1920), "16:9": (1920,1080), "1:1": (1080,1080)}[aspect]
        paths, total = [], 0
        for i, shot in enumerate(body["shots"]):
            start, end, speed, frames = shot["sourceStart"], shot["sourceEnd"], shot["speed"], shot["frames"]
            if not all(math.isfinite(v) for v in (start,end,speed,frames)) or not 0.8 <= speed <= 1 or start < 0 or end <= start or frames <= 0 or int(frames) != frames or math.floor((end-start)/speed*FPS+1e-6) != frames:
                fail("镜头区间、速度或帧数无效")
            path = source(shot["fileKey"])
            with VideoFileClip(str(path), audio=False) as clip:
                if end > clip.duration + .0001:
                    fail("镜头超出源素材时长")
            scale = f"scale={width}:{height}:force_original_aspect_ratio="
            fit = scale + (f"increase,crop={width}:{height}" if options.get("video_fit_mode") == "cover" else f"decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2")
            out = folder / f"shot-{i}.mp4"
            run(["-i", path, "-an", "-vf", f"trim=start={start}:end={end},setpts=(PTS-STARTPTS)/{speed},fps={FPS},{fit},setsar=1", "-frames:v", frames, "-c:v", "libx264", "-pix_fmt", "yuv420p", out])
            with VideoFileClip(str(out), audio=False) as rendered:
                if abs(round(rendered.duration*FPS)-frames) != 0:
                    fail("镜头实际输出帧数不足，禁止冻结补帧，请调整截取区间")
            paths.append(out); total += frames
        if not paths or total != round(len(pcm(audio_path))/2/RATE*FPS):
            fail("镜头时间轴没有完整覆盖配音")
        cursor = 0
        for unit in body["units"]:
            if unit["startFrame"] != cursor or unit["endFrame"] <= cursor:
                fail("字幕与语义时间轴不连续")
            cursor = unit["endFrame"]
        if cursor != total:
            fail("语义时间轴与镜头长度不一致")
        concat = folder / "concat.txt"
        concat.write_text("".join(f"file '{p.name}'\n" for p in paths), encoding="utf-8")
        combined = folder / "combined.mp4"
        run(["-f", "concat", "-safe", "1", "-i", concat, "-c", "copy", combined])
        subtitle = folder / "captions.srt"
        subtitle.write_text("\n\n".join(f"{i+1}\n{timestamp(u['startFrame'])} --> {timestamp(u['endFrame'])}\n{u['text']}" for i,u in enumerate(body["units"])), encoding="utf-8")
        params = VideoParams(video_subject="语义剪辑", **options)
        ok = video.generate_video(str(combined), str(audio_path), str(subtitle) if params.subtitle_enabled else "", str(folder / "output.mp4"), params)
        with VideoFileClip(str(folder / "output.mp4"), audio=False) as result:
            if abs(result.duration - total/FPS) > 1/FPS + .001:
                fail("最终合成时长不一致，请检查渲染配置")
        return {"artifactKey": body["requestId"], "frames": total, "warnings": [] if ok else ["背景音乐混合失败，输出仅含旁白"]}
    return cached("render", body, build)
