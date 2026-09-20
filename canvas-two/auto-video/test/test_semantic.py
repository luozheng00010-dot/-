"""Semantic alignment/render regressions. No remote model/TTS calls."""
import json
import tempfile
import unittest
import wave
from pathlib import Path
from unittest.mock import patch
from contextlib import nullcontext
from types import SimpleNamespace
from uuid import uuid4
from fastapi import HTTPException
from app.services import semantic


class SemanticTests(unittest.TestCase):
    def test_alignment_uses_real_events_not_character_estimates(self):
        units = ["拉链顺滑。", "内部有分区。"]
        cues = [("拉链顺滑", .1, 1.1), ("内部有分区", 1.7, 3.4)]
        self.assertEqual(semantic.align_cues(units, cues, 4*48000), [0,51,120])
        self.assertIsNone(semantic.align_cues(units, [("完全不匹配",0,4)], 4*48000))
        self.assertIsNone(semantic.align_cues(units, [("拉链顺滑内部有分区",0,4)],4*48000))

    def test_audio_fallback_concatenates_pcm_samples_and_caches(self):
        with tempfile.TemporaryDirectory() as root:
            def synth(folder, name, text, voice, rate):
                count = {"whole":96000, "unit-0":24000, "unit-1":40001}[name]
                return b"\0\0"*count, []
            body = dict(requestId=str(uuid4()), script="拉链。分区。", units=["拉链。","分区。"],voiceName="voice",voiceRate=1)
            with patch.object(semantic, "directory", return_value=Path(root)), patch.object(semantic,"synthesize",side_effect=synth) as tts:
                result = semantic.audio(body)
                self.assertEqual(result["mode"],"segments")
                self.assertEqual(result["units"],[dict(text="拉链。",startFrame=0,endFrame=15),dict(text="分区。",startFrame=15,endFrame=41)])
                with wave.open(str(Path(root)/"audio.wav")) as wav:
                    self.assertEqual(wav.getnframes(),41*1600)
                self.assertEqual(semantic.audio(body),result)
                self.assertEqual(tts.call_count,3)
                with self.assertRaises(HTTPException) as error:
                    semantic.audio({**body,"voiceRate":1.1})
                self.assertEqual(error.exception.status_code,409)

    def test_reordered_or_missing_original_text_rejected(self):
        for units in [["分区。","拉链。"],["拉链。"]]:
            with self.assertRaises(HTTPException):
                semantic.audio(dict(script="拉链。分区。",units=units))

    def test_file_key_cannot_escape_library(self):
        for key in ["../secret.mp4", "C:\\video.mp4", "http://site/video.mp4", "中文.mp4"]:
            with self.assertRaises(HTTPException):
                semantic.source(key)

    def test_renderer_rejects_modified_audio_timeline_before_encoding(self):
        with tempfile.TemporaryDirectory() as root:
            folder=Path(root)
            (folder/"audio.wav").write_bytes(b"placeholder")
            (folder/"result.json").write_text(json.dumps({"units":[dict(text="拉链",startFrame=0,endFrame=30)]}),encoding="utf-8")
            body=dict(requestId=str(uuid4()),audioKey=str(uuid4()),units=[dict(text="被改写",startFrame=0,endFrame=30)],shots=[],options={})
            with patch.object(semantic,"directory",return_value=folder), patch.object(semantic,"cached",side_effect=lambda kind, body, build:build(folder)), patch.object(semantic,"run") as run:
                with self.assertRaises(HTTPException):
                    semantic.render(body)
                run.assert_not_called()

    def test_partial_text_edit_reuses_unchanged_pcm(self):
        with tempfile.TemporaryDirectory() as root:
            original=Path(root)/"old"; original.mkdir()
            output=Path(root)/"new"; output.mkdir()
            old_id,new_id=str(uuid4()),str(uuid4())
            old_units=[dict(text="原句。",startFrame=0,endFrame=30),dict(text="保留。",startFrame=30,endFrame=60)]
            (original/"result.json").write_text(json.dumps({"units":old_units}),encoding="utf-8")
            with wave.open(str(original/"audio.wav"),"wb") as wav:
                wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(48000);wav.writeframes(b"\1\0"*96000)
            with patch.object(semantic,"directory",side_effect=lambda key:original if key==old_id else output),patch.object(semantic,"synthesize",return_value=(b"\2\0"*24000,[])) as tts:
                result=semantic.audio(dict(requestId=new_id,previousAudioKey=old_id,script="新句。保留。",units=["新句。","保留。"],voiceName="voice",voiceRate=1))
                self.assertEqual(tts.call_count,1)
                self.assertEqual(result["units"][1],dict(text="保留。",startFrame=15,endFrame=45))
                self.assertEqual(semantic.pcm(output/"audio.wav")[48000:],b"\1\0"*48000)

    def test_explicit_render_order_does_not_call_legacy_combiner(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root);audio_dir=root/"audio";audio_dir.mkdir();render_dir=root/"render";render_dir.mkdir()
            aid,rid=str(uuid4()),str(uuid4())
            units=[dict(text="中文原文。",startFrame=0,endFrame=60)]
            (audio_dir/"result.json").write_text(json.dumps({"units":units}),encoding="utf-8")
            with wave.open(str(audio_dir/"audio.wav"),"wb") as wav:
                wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(48000);wav.writeframes(b"\0\0"*96000)
            def clip(path,audio=False):
                return nullcontext(SimpleNamespace(duration=2 if str(path).endswith("output.mp4") else 1))
            body=dict(requestId=rid,audioKey=aid,units=units,options={"video_aspect":"9:16","video_fit_mode":"cover","subtitle_enabled":False,"bgm_type":"none"},shots=[dict(fileKey=k,sourceStart=0,sourceEnd=1,speed=1,frames=30) for k in ["a","b"]])
            with patch.object(semantic,"directory",side_effect=lambda key:audio_dir if key==aid else render_dir),patch.object(semantic,"source",side_effect=lambda key:root/f"{key}.mp4"),patch.object(semantic,"VideoFileClip",side_effect=clip),patch.object(semantic,"run") as run,patch.object(semantic.video,"generate_video",return_value=True) as final,patch.object(semantic.video,"combine_videos") as legacy:
                result=semantic.render(body)
                self.assertEqual(result["frames"],60)
                calls=run.call_args_list
                self.assertEqual(calls[0].args[0][1],root/"a.mp4")
                self.assertEqual(calls[1].args[0][1],root/"b.mp4")
                self.assertEqual(calls[0].args[0][calls[0].args[0].index("-frames:v")+1],30)
                self.assertEqual(final.call_args.args[1],str(audio_dir/"audio.wav"))
                self.assertEqual(final.call_args.args[2],"")
                legacy.assert_not_called()


if __name__ == "__main__":
    unittest.main()
