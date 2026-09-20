import os
import pathlib
import re
from fastapi import Depends, Request, UploadFile
from fastapi.params import File
from fastapi.responses import StreamingResponse
from loguru import logger

from app.controllers import base
from app.controllers.v1.base import new_router
from app.models.exception import HttpException
from app.models.schema import (
    BgmRetrieveResponse,
    BgmUploadResponse,
    MaterialStorageSettingsResponse,
    MaterialStorageUpdateRequest,
    VideoMaterialUploadResponse,
)
from app.services import bgm as bgm_service
from app.services import material_upload as material_upload_service
from app.utils import utils

# 语义剪辑引擎只暴露素材库与 BGM 两类资源端点：主服务端的上传入库、
# 预览播放与自定义配乐都走这里；旧的任务流水线（远程素材源/生成/拼接）
# 已随本地语义剪辑方案整体移除。
router = new_router(dependencies=[Depends(base.verify_token)])


def _sanitize_upload_filename(filename: str, request_id: str) -> str:
    # 浏览器或客户端有时会附带目录信息，甚至可能夹带 ../ 这类穿越片段。
    # 这里只保留纯文件名，避免上传接口把文件写到目标目录之外。
    normalized_name = (filename or "").replace("\\", "/").split("/")[-1].strip()
    if not normalized_name or normalized_name in {".", ".."}:
        raise HttpException(
            task_id=request_id,
            status_code=400,
            message=f"{request_id}: invalid filename",
        )
    return normalized_name


def _parse_byte_range(
    range_header: str | None, file_size: int, request_id: str
) -> tuple[int, int]:
    """解析单段 HTTP Range，并把无效或越界请求稳定转换成 416。"""
    if file_size <= 0:
        raise HttpException(
            task_id=request_id,
            status_code=416,
            message=f"{request_id}: requested range is not satisfiable",
        )

    if not range_header:
        return 0, file_size - 1

    try:
        # 视频播放器这里只需要单段 bytes range。拒绝多段请求可以避免返回体
        # 与 Content-Range 不一致，也避免异常字符串落入 int() 产生 500。
        if not range_header.startswith("bytes=") or "," in range_header:
            raise ValueError("unsupported range format")
        start_text, end_text = range_header[6:].split("-", 1)
        if not start_text and not end_text:
            raise ValueError("empty range")

        if not start_text:
            suffix_length = int(end_text)
            if suffix_length <= 0:
                raise ValueError("invalid suffix length")
            start = max(file_size - suffix_length, 0)
            end = file_size - 1
        else:
            start = int(start_text)
            end = int(end_text) if end_text else file_size - 1
            if start < 0 or start >= file_size or end < start:
                raise ValueError("range outside file")
            end = min(end, file_size - 1)
    except (TypeError, ValueError) as exc:
        logger.warning(
            f"reject invalid video range, request_id: {request_id}, "
            f"range: {range_header}, file_size: {file_size}, error: {str(exc)}"
        )
        raise HttpException(
            task_id=request_id,
            status_code=416,
            message=f"{request_id}: requested range is not satisfiable",
        ) from exc

    return start, end


@router.get(
    "/musics", response_model=BgmRetrieveResponse, summary="Retrieve local BGM files"
)
def get_bgm_list(request: Request):
    bgm_list = []
    for file in bgm_service.list_bgm_files():
        filename = os.path.basename(file)
        bgm_list.append(
            {
                "name": filename,
                "size": os.path.getsize(file),
                # 只返回文件名，避免把服务器绝对路径暴露给调用方。服务端会
                # 在 storage/bgm 和 resource/songs 两个白名单目录中重新解析。
                "file": filename,
            }
        )
    response = {"files": bgm_list}
    return utils.get_response(200, response)


@router.post(
    "/musics",
    response_model=BgmUploadResponse,
    summary="Upload a background music file",
)
def upload_bgm_file(request: Request, file: UploadFile = File(...)):
    request_id = base.get_task_id(request)
    try:
        safe_filename = bgm_service.save_bgm_upload(file.filename, file.file)
    except bgm_service.BgmUploadError as exc:
        # 上传失败通常可以由用户更换文件后恢复，因此记录 request_id 和明确原因，
        # 但不输出文件内容或绝对路径，避免日志泄露用户数据。
        logger.warning(
            f"background music upload rejected: request_id={request_id}, error: {str(exc)}"
        )
        raise HttpException(
            task_id=request_id,
            status_code=400,
            message=f"{request_id}: {str(exc)}",
        )
    except bgm_service.BgmServiceError as exc:
        # 工具链或存储故障属于服务端问题，不能伪装成用户文件错误。日志保留
        # request_id 和内部原因，HTTP 响应只返回稳定文案，避免暴露服务器路径。
        logger.error(
            f"background music upload failed: request_id={request_id}, error: {str(exc)}"
        )
        raise HttpException(
            task_id=request_id,
            status_code=500,
            message=f"{request_id}: background music validation is unavailable",
        )

    response = {"file": safe_filename}
    return utils.get_response(200, response)


@router.post("/library-videos", response_model=VideoMaterialUploadResponse)
def upload_library_video(request: Request, file: UploadFile = File(...)):
    if pathlib.Path(file.filename or "").suffix.lower() not in material_upload_service.SUPPORTED_VIDEO_EXTENSIONS:
        raise HttpException(task_id=base.get_task_id(request), status_code=400, message="本地素材库仅支持视频")
    request_id = base.get_task_id(request)
    try:
        safe_filename = _sanitize_upload_filename(file.filename, request_id)
        stored_filename = material_upload_service.save_material_upload(
            safe_filename, file.file
        )
    except material_upload_service.MaterialUploadError as exc:
        logger.warning(
            f"local material upload rejected: request_id={request_id}, "
            f"error: {str(exc)}"
        )
        raise HttpException(
            task_id=request_id,
            status_code=400,
            message=f"{request_id}: {str(exc)}",
        )
    except material_upload_service.MaterialServiceError as exc:
        logger.error(
            f"local material upload failed: request_id={request_id}, "
            f"error: {str(exc)}"
        )
        raise HttpException(
            task_id=request_id,
            status_code=500,
            message=f"{request_id}: local material validation is unavailable",
        )
    return utils.get_response(200, {"file": stored_filename})


def _library_video_path(request: Request, file_key: str) -> str:
    if not re.fullmatch(r"[0-9a-f]{32}\.(mp4|mov|avi|flv|mkv|webm)", file_key):
        raise HttpException(task_id=base.get_task_id(request), status_code=400, message="无效的视频文件键")
    # 自定义存储位置优先、默认目录兜底：更换位置后历史素材仍要可预览/删除。
    path = material_upload_service.find_material_file(file_key)
    if not path:
        raise HttpException(task_id=base.get_task_id(request), status_code=404, message="素材文件不存在")
    return path


@router.get("/storage", response_model=MaterialStorageSettingsResponse)
def get_material_storage(request: Request):
    return utils.get_response(200, material_upload_service.storage_settings())


@router.put("/storage", response_model=MaterialStorageSettingsResponse)
def update_material_storage(request: Request, payload: MaterialStorageUpdateRequest):
    request_id = base.get_task_id(request)
    try:
        settings = material_upload_service.update_storage_dir(payload.dir)
    except material_upload_service.MaterialUploadError as exc:
        raise HttpException(task_id=request_id, status_code=400, message=f"{request_id}: {str(exc)}")
    except material_upload_service.MaterialServiceError as exc:
        logger.error(f"material storage update failed: request_id={request_id}, error: {str(exc)}")
        raise HttpException(task_id=request_id, status_code=500, message=f"{request_id}: 素材存储位置不可用")
    return utils.get_response(200, settings)


@router.delete("/library-videos/{file_key}")
def remove_library_upload(request: Request, file_key: str):
    # 仅供主服务入库失败时补偿删除；素材库正常删除不调用此接口。
    os.remove(_library_video_path(request, file_key))
    return utils.get_response(200)


@router.get("/library-videos/{file_key}")
def preview_library_video(request: Request, file_key: str):
    video_path = _library_video_path(request, file_key)
    size = os.path.getsize(video_path)
    range_header = request.headers.get("Range")
    start, end = _parse_byte_range(range_header, size, base.get_task_id(request))

    def chunks():
        with open(video_path, "rb") as stream:
            stream.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = stream.read(min(65536, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    types = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".flv": "video/x-flv"}
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(end - start + 1)}
    if range_header:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(chunks(), status_code=206 if range_header else 200,
                             media_type=types[pathlib.Path(file_key).suffix], headers=headers)
