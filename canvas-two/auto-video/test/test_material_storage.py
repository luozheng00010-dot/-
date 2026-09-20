"""素材存储位置（管理页面可配置）的解析、校验与历史目录回退。无网络/模型调用。"""
import os
import tempfile
import unittest
from unittest.mock import patch

from app.config import config
from app.services import material_upload


class MaterialStorageTests(unittest.TestCase):
    def setUp(self):
        self._original = dict(config.storage)
        # 设置持久化会写 config.toml，测试里替换为空实现，避免污染真实配置。
        self._save = patch.object(config, "save_config", lambda: None)
        self._save.start()
        self.addCleanup(self._restore)

    def _restore(self):
        self._save.stop()
        config.storage.clear()
        config.storage.update(self._original)

    def test_relative_path_rejected(self):
        with self.assertRaises(material_upload.MaterialUploadError):
            material_upload.update_storage_dir("videos/materials")

    def test_nul_and_overlong_path_rejected(self):
        with self.assertRaises(material_upload.MaterialUploadError):
            material_upload.update_storage_dir("bad\x00path")
        with self.assertRaises(material_upload.MaterialUploadError):
            material_upload.update_storage_dir("C:\\" + "x" * 400)

    def test_custom_dir_used_for_upload_and_settings(self):
        with tempfile.TemporaryDirectory() as root:
            custom = os.path.join(root, "custom")
            settings = material_upload.update_storage_dir(custom)
            self.assertTrue(settings["custom"])
            self.assertEqual(settings["dir"], os.path.normpath(custom))
            self.assertEqual(
                material_upload.uploaded_material_dir(), os.path.normpath(custom)
            )
            self.assertTrue(os.path.isdir(custom))

    def test_empty_value_resets_to_default(self):
        with tempfile.TemporaryDirectory() as root:
            material_upload.update_storage_dir(os.path.join(root, "custom"))
            settings = material_upload.update_storage_dir("")
            self.assertFalse(settings["custom"])
            self.assertEqual(material_upload.configured_material_dir(), "")
            self.assertIn(
                "local_videos", material_upload.uploaded_material_dir(create=False)
            )

    def test_invalid_stored_value_falls_back_to_default(self):
        config.storage["local_videos_dir"] = "relative/path"
        self.assertEqual(material_upload.configured_material_dir(), "")
        config.storage["local_videos_dir"] = ""
        self.assertEqual(material_upload.configured_material_dir(), "")

    def test_search_prefers_custom_dir_and_falls_back_for_legacy_files(self):
        with tempfile.TemporaryDirectory() as root:
            custom = os.path.join(root, "custom")
            os.makedirs(custom)
            material_upload.update_storage_dir(custom)
            key = "a" * 32 + ".mp4"

            # 自定义目录与默认目录都有同名文件时，自定义目录优先。
            custom_path = os.path.join(custom, key)
            default_dir = material_upload.utils.storage_dir(
                "local_videos", create=True
            )
            legacy_path = os.path.join(default_dir, key)
            for path in (custom_path, legacy_path):
                with open(path, "wb") as handle:
                    handle.write(b"x")
            try:
                self.assertEqual(material_upload.find_material_file(key), custom_path)
                # 删除自定义目录的文件后，仍能读到默认目录里的历史素材。
                os.remove(custom_path)
                self.assertEqual(material_upload.find_material_file(key), legacy_path)
            finally:
                os.remove(legacy_path)
            self.assertEqual(material_upload.find_material_file(key), "")

    def test_find_material_file_rejects_traversal(self):
        self.assertEqual(material_upload.find_material_file("../x.mp4"), "")
        self.assertEqual(material_upload.find_material_file(""), "")


if __name__ == "__main__":
    unittest.main()
