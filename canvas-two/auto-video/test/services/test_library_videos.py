import asyncio
import io
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image
from app.controllers.v1 import video
from app.models.exception import HttpException
from app.services import material_upload


class TestLibraryVideos(unittest.TestCase):
    def test_images_and_disguised_images_are_rejected(self):
        request = SimpleNamespace(headers={"x-task-id": "library-test"})
        stream = io.BytesIO()
        Image.new("RGB", (8, 8)).save(stream, format="PNG")
        with tempfile.TemporaryDirectory() as directory, patch.object(material_upload, "uploaded_material_dir", return_value=directory):
            for name in ("image.png", "image.mp4"):
                stream.seek(0)
                with self.subTest(name=name), self.assertRaises(HttpException) as error:
                    video.upload_library_video(request, SimpleNamespace(filename=name, file=stream))
                self.assertEqual(error.exception.status_code, 400)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_preview_range_and_path_validation(self):
        key = "a" * 32 + ".mp4"
        # 预览读取走 material_search_dirs（自定义位置优先、默认目录兜底），
        # 这里直接给出临时检索目录，与存储位置配置解耦。
        with tempfile.TemporaryDirectory() as directory, patch.object(material_upload, "material_search_dirs", return_value=[directory]):
            Path(directory, key).write_bytes(b"0123456789")
            request = SimpleNamespace(headers={"x-task-id": "library-test", "Range": "bytes=2-5"})
            response = video.preview_library_video(request, key)
            self.assertEqual(response.status_code, 206)
            self.assertEqual(response.headers["content-range"], "bytes 2-5/10")

            async def read_body():
                return b"".join([chunk async for chunk in response.body_iterator])

            self.assertEqual(asyncio.run(read_body()), b"2345")
            with self.assertRaises(HttpException):
                video.preview_library_video(request, "../" + key)
            request.headers["Range"] = "bytes=20-30"
            with self.assertRaises(HttpException) as error:
                video.preview_library_video(request, key)
            self.assertEqual(error.exception.status_code, 416)

    def test_oversized_upload_leaves_no_file(self):
        request = SimpleNamespace(headers={"x-task-id": "library-test"})
        with tempfile.TemporaryDirectory() as directory, patch.object(material_upload, "uploaded_material_dir", return_value=directory), patch.object(material_upload, "MAX_VIDEO_MATERIAL_UPLOAD_BYTES", 16):
            with self.assertRaises(HttpException) as error:
                video.upload_library_video(request, SimpleNamespace(filename="clip.mp4", file=io.BytesIO(b"x" * 17)))
            self.assertEqual(error.exception.status_code, 400)
            self.assertEqual(list(Path(directory).iterdir()), [])
