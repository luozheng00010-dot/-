"""素材探测抽帧：按时长自适应帧数、ffmpeg 缩放抽取、JPEG 有效性。真实 FFmpeg，无模型调用。"""
import base64
import io
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException
from PIL import Image

from app.services import semantic
from app.utils import utils


def _make_video(path: Path, duration: float, size: str = "320x240") -> None:
    subprocess.run(
        [
            utils.get_ffmpeg_binary(),
            "-nostdin",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc2=size={size}:rate=30",
            "-t",
            str(duration),
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
        timeout=120,
    )


def _decode_frame(data_url: str) -> Image.Image:
    assert data_url.startswith("data:image/jpeg;base64,")
    return Image.open(io.BytesIO(base64.b64decode(data_url.split(",", 1)[1])))


class SemanticProbeTests(unittest.TestCase):
    def test_frame_stamps_follow_duration_buckets(self):
        self.assertEqual(len(semantic.annotation_frame_stamps(0.5)), 2)
        self.assertEqual(len(semantic.annotation_frame_stamps(1.0)), 2)
        self.assertEqual(len(semantic.annotation_frame_stamps(1.5)), 3)
        self.assertEqual(len(semantic.annotation_frame_stamps(2.0)), 3)
        self.assertEqual(len(semantic.annotation_frame_stamps(3.5)), 4)
        self.assertEqual(len(semantic.annotation_frame_stamps(5.0)), 5)

    def test_probe_extracts_jpeg_frames_capped_at_640(self):
        with tempfile.TemporaryDirectory() as root:
            video = Path(root, "clip.mp4")
            _make_video(video, duration=1.5, size="1280x720")
            with patch.object(semantic, "source", return_value=video):
                result = semantic.probe("key")
            self.assertEqual(result["width"], 1280)
            self.assertEqual(result["height"], 720)
            self.assertAlmostEqual(result["duration"], 1.5, places=1)
            # 1.5 秒素材只需 3 帧，不再抽满 5 帧。
            self.assertEqual(len(result["frames"]), 3)
            self.assertEqual(result["thumbnail"], result["frames"][1])
            for data_url in result["frames"]:
                with _decode_frame(data_url) as image:
                    self.assertEqual(image.format, "JPEG")
                    self.assertLessEqual(max(image.size), semantic.ANNOTATION_FRAME_MAX_EDGE)

    def test_short_clip_yields_minimal_frames(self):
        with tempfile.TemporaryDirectory() as root:
            video = Path(root, "short.mp4")
            _make_video(video, duration=0.8)
            with patch.object(semantic, "source", return_value=video):
                result = semantic.probe("key")
            self.assertEqual(len(result["frames"]), 2)

    def test_corrupt_video_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            bogus = Path(root, "bad.mp4")
            bogus.write_bytes(b"not a video")
            with patch.object(semantic, "source", return_value=bogus):
                with self.assertRaises(HTTPException) as error:
                    semantic.probe("key")
            self.assertEqual(error.exception.status_code, 422)


if __name__ == "__main__":
    unittest.main()
