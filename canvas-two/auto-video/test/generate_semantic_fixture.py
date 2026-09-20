"""Manual integration fixture generator; never runs as part of application startup.

Run from auto-video: python test/generate_semantic_fixture.py <output-directory>
Synthetic silent clips test media/timeline handling; use real product footage to assess AI relevance.
"""
import json
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from moviepy import VideoClip


def main():
    target=Path(sys.argv[1]).resolve()
    target.mkdir(parents=True,exist_ok=True)
    samples=[("拉链开合演示.mp4",1.5,"zipper"), ("内部分区演示.mp4",1.8,"inside"), ("产品整体🎒.mp4",1.6,"whole"), ("低清肩带.mp4",.8,"strap")]
    records=[]
    for filename,duration,kind in samples:
        size=(320,480) if kind=="strap" else (720,1080)
        def frame(t,kind=kind,size=size,duration=duration):
            w,h=size
            image=Image.new("RGB",size,"#e5dfd1")
            draw=ImageDraw.Draw(image)
            draw.rounded_rectangle((w*.15,h*.2,w*.85,h*.85),radius=int(w*.1),fill="#426285",outline="#172d46",width=6)
            if kind=="zipper":
                draw.line((w*.2,h*.45,w*.8,h*.45),fill="#cccccc",width=8)
                x=w*(.2+.6*t/duration)
                draw.rectangle((x-8,h*.43,x+8,h*.5),fill="#e8b14f")
            elif kind=="inside":
                for x in (.35,.65):
                    draw.line((w*x,h*.25,w*x,h*.8),fill="#c0b39f",width=12)
            elif kind=="strap":
                draw.line((w*.25,h*.25,w*.65,h*.75),fill="#dc9c59",width=int(w*.15))
            else:
                draw.arc((w*.3,h*.1,w*.7,h*.35),180,360,fill="#172d46",width=12)
            return np.asarray(image)
        output=target/filename
        if output.exists():
            raise FileExistsError(f"Refusing to overwrite {output}")
        with VideoClip(frame_function=frame,duration=duration) as clip:
            clip.write_videofile(str(output),fps=30,codec="libx264",audio=False,logger=None)
        records.append(dict(file=filename,duration=duration,synthetic=True,kind=kind))
    (target/"样例清单.json").write_text(json.dumps({"sku":"SEMANTIC-DEMO","clips":records,"note":"动画示意素材，仅测试静音短片与时间轴；功能证据验收应使用真实视频。"},ensure_ascii=False,indent=2),encoding="utf-8")


if __name__=="__main__":
    main()
