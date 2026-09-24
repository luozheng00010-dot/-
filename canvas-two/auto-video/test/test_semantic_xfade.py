"""xfade 转场拼接集成回归：真实 ffmpeg 校验输出时长与帧数守恒预期一致。"""
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from app.services import semantic

FFMPEG = semantic.utils.get_ffmpeg_binary()
W, H, FPS = 320, 568, 30


def _duration(path: Path) -> float:
    probe = subprocess.run([FFMPEG, "-i", str(path)], capture_output=True, text=True)
    match = re.search(r"Duration: (\d+):(\d+):([\d.]+)", probe.stderr)
    return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))


class XfadeConcatTests(unittest.TestCase):
    def test_chained_xfade_and_mixed_junctions_conserve_duration(self):
        with tempfile.TemporaryDirectory() as root:
            folder = Path(root)
            rendered = []
            for i, (color, frames) in enumerate([("red", 69), ("green", 69), ("blue", 60)]):
                src = folder / f"clip-{i}.mp4"
                subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                                f"color=c={color}:s={W}x{H}:r={FPS}:d=3.0", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(src)], check=True)
                out = folder / f"shot-{i}.mp4"
                subprocess.run([FFMPEG, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src), "-an",
                                "-vf", f"fps={FPS},setsar=1", "-frames:v", str(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", str(out)], check=True)
                rendered.append(out)
            # 全 xfade 链：69+69+60 - 2*9 = 180 帧 = 6.0s
            chained = folder / "chained.mp4"
            semantic.concat_with_transitions(rendered, [69, 69, 60], ["fade", "fade"], chained)
            self.assertLessEqual(abs(_duration(chained) - 6.0), 1 / FPS + 0.001)
            # 混合接缝（硬切 + xfade）同图拼接
            mixed = folder / "mixed.mp4"
            semantic.concat_with_transitions(rendered, [60, 69, 60], [None, "slideleft"], mixed)
            self.assertLessEqual(abs(_duration(mixed) - (60 + 69 + 60 - 9) / FPS), 1 / FPS + 0.001)
            # 单镜头直接流拷贝
            single = folder / "single.mp4"
            semantic.concat_with_transitions([rendered[0]], [69], [], single)
            self.assertLessEqual(abs(_duration(single) - 69 / FPS), 1 / FPS + 0.001)


if __name__ == "__main__":
    unittest.main()
