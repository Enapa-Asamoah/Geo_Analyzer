"""Storage helpers for resolving backend data from local disk or S3."""

from __future__ import annotations

import os
from functools import lru_cache
from typing import Iterable, Optional


def _normalize_prefix(prefix: str | None) -> str:
    return (prefix or "").strip("/")


def _join_key(*parts: str) -> str:
    return "/".join(part.strip("/") for part in parts if part and part.strip("/"))


def _relpath_from_root(local_path: str, data_root: str) -> Optional[str]:
    try:
        rel = os.path.relpath(local_path, data_root)
    except ValueError:
        return None
    if rel.startswith(".."):
        return None
    return rel.replace(os.sep, "/")


def local_path_from_s3_key(data_root: str, key: str, s3_prefix: str | None = None) -> str:
    prefix = _normalize_prefix(s3_prefix)
    relative_key = key.lstrip("/")
    if prefix and relative_key.startswith(prefix + "/"):
        relative_key = relative_key[len(prefix) + 1 :]
    return os.path.join(data_root, *relative_key.split("/"))


def s3_key_for_local_path(local_path: str, data_root: str, s3_prefix: str | None = None) -> Optional[str]:
    rel = _relpath_from_root(local_path, data_root)
    if rel is None:
        return None
    return _join_key(_normalize_prefix(s3_prefix), rel)


@lru_cache(maxsize=1)
def _s3_client():
    try:
        import boto3
    except ImportError as exc:  # pragma: no cover - exercised only when S3 is enabled.
        raise RuntimeError("boto3 is required for S3-backed data loading") from exc

    region_name = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION")
    return boto3.client("s3", region_name=region_name)


def _s3_bucket() -> str:
    return os.environ.get("S3_BUCKET", "").strip()


def _s3_prefix() -> str:
    return _normalize_prefix(os.environ.get("S3_DATA_PREFIX", "data"))


def s3_enabled() -> bool:
    return bool(_s3_bucket())


def ensure_local_file(local_path: str, data_root: str) -> str:
    """Return a local file path, downloading from S3 if configured and missing."""
    if os.path.exists(local_path):
        return local_path

    bucket = _s3_bucket()
    if not bucket:
        return local_path

    key = s3_key_for_local_path(local_path, data_root, _s3_prefix())
    if not key:
        return local_path

    os.makedirs(os.path.dirname(local_path), exist_ok=True)
    try:
        _s3_client().download_file(bucket, key, local_path)
    except Exception:
        # Leave the path unresolved; the caller will surface a missing-file error.
        return local_path

    return local_path


def list_s3_common_prefixes(prefix: str) -> list[str]:
    bucket = _s3_bucket()
    if not bucket:
        return []

    client = _s3_client()
    paginator = client.get_paginator("list_objects_v2")
    prefixes: list[str] = []

    for page in paginator.paginate(Bucket=bucket, Prefix=_normalize_prefix(prefix), Delimiter="/"):
        for entry in page.get("CommonPrefixes", []):
            value = entry.get("Prefix")
            if value:
                prefixes.append(value)

    return prefixes


def list_s3_keys(prefix: str) -> list[str]:
    bucket = _s3_bucket()
    if not bucket:
        return []

    client = _s3_client()
    paginator = client.get_paginator("list_objects_v2")
    keys: list[str] = []

    for page in paginator.paginate(Bucket=bucket, Prefix=_normalize_prefix(prefix)):
        for item in page.get("Contents", []):
            key = item.get("Key")
            if key:
                keys.append(key)

    return keys
