"""镜头拼接转场规划：帧数守恒、尾部退化、边界情况。无 ffmpeg/模型调用。"""
import math
import unittest
from fastapi import HTTPException
from app.services import semantic


class TransitionPlanTests(unittest.TestCase):
    def shot(self, end=2.0, frames=60, speed=1.0):
        return {"fileKey": "a" * 32 + ".mp4", "sourceStart": 0.0, "sourceEnd": end, "speed": speed, "frames": frames}

    def test_none_keeps_windows_and_hard_cuts(self):
        extended, junctions = semantic.plan_transitions([self.shot(), self.shot()], [3.0, 3.0], "none")
        self.assertEqual(junctions, [None])
        self.assertEqual([s["frames"] for s in extended], [60, 60])
        self.assertEqual([s["sourceEnd"] for s in extended], [2.0, 2.0])

    def test_uniform_shots_extend_and_conserve_frames(self):
        shots = [self.shot(), self.shot(end=1.0, frames=30), self.shot()]
        extended, junctions = semantic.plan_transitions(shots, [3.0, 3.0, 3.0], "fade")
        self.assertEqual(junctions, ["fade", "fade"])
        overlap = round(semantic.TRANSITION_SECONDS * semantic.FPS)
        self.assertEqual(sum(s["frames"] for s in extended) - overlap * len(junctions), 60 + 30 + 60)
        # 末镜头不延长
        self.assertEqual(extended[2]["sourceEnd"], 2.0)
        self.assertEqual(extended[2]["frames"], 60)

    def test_single_shot_has_no_junction(self):
        extended, junctions = semantic.plan_transitions([self.shot()], [3.0], "fade")
        self.assertEqual(junctions, [])
        self.assertEqual(extended[0]["frames"], 60)

    def test_insufficient_tail_degrades_to_hard_cut(self):
        extended, junctions = semantic.plan_transitions([self.shot(end=2.99), self.shot()], [3.0, 3.0], "fade")
        self.assertEqual(junctions, [None])
        self.assertEqual(extended[0]["frames"], 60)
        self.assertEqual(extended[0]["sourceEnd"], 2.99)

    def test_speed_scales_extension_and_stays_consistent(self):
        shots = [self.shot(end=2.0, frames=75, speed=0.8), self.shot()]
        extended, junctions = semantic.plan_transitions(shots, [3.0, 3.0], "fade")
        self.assertEqual(junctions, ["fade"])
        self.assertAlmostEqual(extended[0]["sourceEnd"], 2.0 + 0.3 * 0.8)
        self.assertEqual(math.floor(extended[0]["sourceEnd"] / 0.8 * semantic.FPS + 1e-6), extended[0]["frames"])

    def test_mixed_junctions_conserve_frames(self):
        shots = [self.shot(end=2.99), self.shot(), self.shot(end=1.4, frames=42)]
        extended, junctions = semantic.plan_transitions(shots, [3.0, 3.0, 3.0], "fade")
        self.assertEqual(junctions, [None, "fade"])
        overlap = round(semantic.TRANSITION_SECONDS * semantic.FPS)
        self.assertEqual(sum(s["frames"] for s in extended) - overlap * sum(1 for j in junctions if j), 60 + 60 + 42)

    def test_window_beyond_clip_fails(self):
        with self.assertRaises(HTTPException):
            semantic.plan_transitions([self.shot(end=5.0)], [3.0], "none")

    def test_invalid_transition_fails(self):
        with self.assertRaises(HTTPException):
            semantic.plan_transitions([self.shot()], [3.0], "glitch")

    def test_shuffle_picks_concrete_effects(self):
        _, junctions = semantic.plan_transitions([self.shot(), self.shot(), self.shot()], [3.0, 3.0, 3.0], "shuffle")
        self.assertTrue(all(j in semantic.XFADE_EFFECTS.values() for j in junctions))

    def test_shot_override_enables_effect_under_none_default(self):
        shots = [self.shot(), {**self.shot(), "transition": "fade"}, self.shot()]
        extended, junctions = semantic.plan_transitions(shots, [3.0, 3.0, 3.0], "none")
        self.assertEqual(junctions, ["fade", None])
        overlap = round(semantic.TRANSITION_SECONDS * semantic.FPS)
        # 帧数守恒：仅被延长镜头多取 overlap 帧
        self.assertEqual(sum(s["frames"] for s in extended), 60 + 60 + 60 + overlap)
        # transition 描述"该镜头入场"的接缝，前一个镜头为此多取尾部帧
        self.assertAlmostEqual(extended[0]["sourceEnd"], 2.0 + semantic.TRANSITION_SECONDS)
        self.assertEqual(extended[1]["sourceEnd"], 2.0)

    def test_shot_override_forces_hard_cut_under_fade_default(self):
        shots = [self.shot(), {**self.shot(), "transition": "none"}, self.shot()]
        extended, junctions = semantic.plan_transitions(shots, [3.0, 3.0, 3.0], "fade")
        self.assertEqual(junctions, [None, "fade"])
        self.assertEqual([s["sourceEnd"] for s in extended], [2.0, 2.0 + semantic.TRANSITION_SECONDS, 2.0])

    def test_shot_override_invalid_fails(self):
        with self.assertRaises(HTTPException):
            semantic.plan_transitions([self.shot(), {**self.shot(), "transition": "glitch"}], [3.0, 3.0], "none")

    def test_shot_override_none_under_shuffle_stays_hard_cut(self):
        _, junctions = semantic.plan_transitions([self.shot(), {**self.shot(), "transition": "none"}, self.shot()], [3.0, 3.0, 3.0], "shuffle")
        self.assertEqual(junctions, [None, junctions[1]])
        self.assertIsNotNone(junctions[1])


if __name__ == "__main__":
    unittest.main()
