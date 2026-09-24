from typing import Literal, Optional
from uuid import UUID
from fastapi import Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from app.controllers import base
from app.controllers.v1.base import new_router
from app.services import jianying, semantic

router = new_router(dependencies=[Depends(base.verify_token)])

class Probe(BaseModel):
    fileKey: str = Field(max_length=100)

class Audio(BaseModel):
    requestId: UUID
    script: str = Field(min_length=1, max_length=20000)
    units: list[str] = Field(min_length=1, max_length=300)
    voiceName: str = Field(min_length=1, max_length=200)
    voiceRate: float = Field(ge=.5, le=2)
    previousAudioKey: UUID | None = None

class Shot(BaseModel):
    fileKey: str
    sourceStart: float = Field(ge=0, allow_inf_nan=False)
    sourceEnd: float = Field(gt=0, allow_inf_nan=False)
    speed: float = Field(ge=.8, le=1)
    frames: int = Field(gt=0)
    # 该镜头与前一个镜头之间接缝的转场；None 跟随方案级 video_transition。
    transition: Optional[Literal["none", "fade", "slide_left", "slide_right", "slide_up", "wipe_left", "circle_open", "radial", "pixelize", "hblur", "shuffle"]] = None

class Unit(BaseModel):
    text: str
    startFrame: int = Field(ge=0)
    endFrame: int = Field(gt=0)

class RenderOptions(BaseModel):
    video_aspect: Literal["9:16", "16:9", "1:1"] = "9:16"
    video_fit_mode: Literal["cover", "contain"] = "cover"
    video_transition: Literal["none", "fade", "slide_left", "slide_right", "slide_up", "wipe_left", "circle_open", "radial", "pixelize", "hblur", "shuffle"] = "none"
    subtitle_enabled: bool = True
    subtitle_position: Literal["top", "bottom", "center", "custom", "two_thirds_bottom"] = "bottom"
    font_name: str = Field(default="MicrosoftYaHeiBold.ttc", max_length=255)
    font_size: int = Field(default=60, ge=24, le=120)
    text_fore_color: str = Field(default="#FFFFFF", pattern=r"^#[a-fA-F0-9]{6}$")
    stroke_color: str = Field(default="#000000", pattern=r"^#[a-fA-F0-9]{6}$")
    stroke_width: float = Field(default=1.5, ge=0, le=4)
    custom_position: float = Field(default=70, ge=0, le=100)
    voice_volume: float = Field(default=1, ge=0, le=2)
    bgm_type: Literal["none", "random", "custom"] = "none"
    bgm_file: str = Field(default="", max_length=255)
    bgm_volume: float = Field(default=.2, ge=0, le=1)

class Render(BaseModel):
    requestId: UUID
    audioKey: UUID
    shots: list[Shot] = Field(min_length=1, max_length=10000)
    units: list[Unit] = Field(min_length=1, max_length=300)
    options: RenderOptions

class JianYingEntry(BaseModel):
    type: Literal["shot", "gap"]
    startFrame: int = Field(ge=0)
    frames: int = Field(gt=0)
    fileKey: Optional[str] = None
    sourceStart: float = 0
    sourceEnd: float = 0

class JianYingExport(BaseModel):
    requestId: UUID
    audioKey: UUID
    entries: list[JianYingEntry] = Field(min_length=1)
    units: list[Unit]
    options: RenderOptions
    name: str = Field(min_length=1, max_length=80)
    folder: str = Field(min_length=1, max_length=300)
    pack_materials: bool = True

@router.post("/semantic/probe")
def probe(body: Probe):
    return semantic.probe(body.fileKey)

@router.post("/semantic/audio")
def audio(body: Audio):
    return semantic.audio(body.model_dump(mode="json"))

@router.post("/semantic/render")
def render(body: Render):
    return semantic.render(body.model_dump(mode="json"))

@router.post("/semantic/jianying")
def export_jianying(body: JianYingExport):
    return jianying.export_draft(body.model_dump(mode="json"))

@router.get("/semantic/artifacts/{key}/{name}")
def artifact(key: UUID, name: Literal["audio.wav", "output.mp4"]):
    path = semantic.directory(str(key)) / name
    if not path.is_file():
        semantic.fail("产物尚未生成或不存在")
    return FileResponse(path, media_type="audio/wav" if name == "audio.wav" else "video/mp4")
