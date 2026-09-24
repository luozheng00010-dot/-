"""剪映草稿导出的集成回归：真实生成 draft_content.json 并校验轨道结构。"""
import json
import subprocess
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

from app.services import jianying, semantic


def make_fixture(folder: Path) -> Path:
    clip = folder / "clip.mp4"
    subprocess.run([semantic.utils.get_ffmpeg_binary(), "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                    "color=c=red:s=320x568:r=30:d=3.0", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(clip)], check=True)
    return clip


def make_audio(folder: Path) -> Path:
    path = folder / "audio.wav"
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(48000)
        wav.writeframes(b"\0\0" * 48000)
    return path


def make_body(root_path: Path) -> dict:
    return {
        "audioKey": "audio-key",
        "folder": str(root_path),
        "name": "测试方案-1",
        "options": {"video_aspect": "9:16", "subtitle_enabled": True, "font_size": 60, "stroke_width": 1.5, "voice_volume": 1},
        "entries": [
            {"type": "shot", "startFrame": 0, "frames": 60, "fileKey": "a" * 32 + ".mp4", "sourceStart": 0.0, "sourceEnd": 2.0},
            {"type": "gap", "startFrame": 60, "frames": 30},
            {"type": "shot", "startFrame": 90, "frames": 60, "fileKey": "a" * 32 + ".mp4", "sourceStart": 1.0, "sourceEnd": 3.0},
        ],
        "units": [{"text": "拉链顺滑。", "startFrame": 0, "endFrame": 90}, {"text": "内部分区。", "startFrame": 90, "endFrame": 150}],
    }


class JianYingExportTests(unittest.TestCase):
    def test_draft_written_with_separated_tracks_and_gap(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            clip = make_fixture(root_path)
            audio_folder = root_path / "audio-key"
            audio_folder.mkdir()
            make_audio(audio_folder)
            with patch.object(jianying, "directory", return_value=audio_folder), patch.object(jianying, "source", return_value=clip):
                result = jianying.export_draft(make_body(root_path))
            draft = Path(result["path"])
            content = json.loads((draft / "draft_content.json").read_text(encoding="utf-8"))
            self.assertTrue((draft / "draft_meta_info.json").is_file())
            self.assertTrue((draft / "black.png").is_file())
            self.assertTrue((draft / "voice.wav").is_file())
            # 默认打包：源视频复制进 media/；草稿内引用必须是绝对路径——
            # 剪映不认草稿内相对路径，会当成云端资源报"素材下载失败"。
            self.assertTrue((draft / "media" / "clip.mp4").is_file())
            for material in content["materials"]["videos"]:
                self.assertIn(str(draft), material["path"].replace("/", "\\"))
            self.assertEqual(content["materials"]["audios"][0]["path"].replace("\\", "/"), str(draft / "voice.wav").replace("\\", "/"))
            # 画幅与帧率
            self.assertEqual(content["canvas_config"]["width"], 1080)
            self.assertEqual(content["canvas_config"]["height"], 1920)
            self.assertEqual(content["fps"], 30)
            # 画面/旁白/字幕三条轨道分离
            types = [(t["type"], t["name"]) for t in content["tracks"]]
            self.assertEqual(types, [("video", "画面"), ("audio", "旁白"), ("text", "字幕")])
            video_segments = content["tracks"][0]["segments"]
            self.assertEqual(len(video_segments), 3)
            self.assertEqual([s["target_timerange"]["start"] for s in video_segments], [0, 2_000_000, 3_000_000])
            self.assertEqual([s["target_timerange"]["duration"] for s in video_segments], [2_000_000, 1_000_000, 2_000_000])
            # 缺口段引用草稿目录内的 black.png
            gap_material = next(m for m in content["materials"]["videos"] if m["id"] == video_segments[1]["material_id"])
            self.assertTrue(gap_material["path"].replace("\\", "/").endswith("black.png"))
            # 旁白在独立音频轨，时长 1 秒
            audio_segments = content["tracks"][1]["segments"]
            self.assertEqual(len(audio_segments), 1)
            self.assertEqual(audio_segments[0]["target_timerange"]["duration"], 1_000_000)
            # 字幕文本轨
            text_segments = content["tracks"][2]["segments"]
            self.assertEqual([s["target_timerange"]["start"] for s in text_segments], [0, 3_000_000])

    def test_pack_disabled_keeps_absolute_source_paths(self):
        with tempfile.TemporaryDirectory() as root:
            root_path = Path(root)
            clip = make_fixture(root_path)
            audio_folder = root_path / "audio-key"
            audio_folder.mkdir()
            make_audio(audio_folder)
            body = {**make_body(root_path), "pack_materials": False}
            with patch.object(jianying, "directory", return_value=audio_folder), patch.object(jianying, "source", return_value=clip):
                result = jianying.export_draft(body)
            draft = Path(result["path"])
            content = json.loads((draft / "draft_content.json").read_text(encoding="utf-8"))
            self.assertFalse((draft / "media").exists())
            shot_material = next(m for m in content["materials"]["videos"] if m["path"].replace("\\", "/").endswith("clip.mp4"))
            self.assertEqual(shot_material["path"].replace("\\", "/"), str(clip).replace("\\", "/"))


if __name__ == "__main__":
    unittest.main()
