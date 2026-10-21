"""Project adapter over the shared rate-limit engine.

The engine (`rate_limit_engine.py`) is vendored unmodified from
`shared/rate-limit/engine/fastapi/`. This adapter only supplies the project slug
and its single LLM bucket; the engine handles X-Forwarded-For, central config,
event mode, the kill switch (503), and fail-open behaviour.
"""

from __future__ import annotations

import os

from fastapi import Request

from app.rate_limit_engine import RateLimiter


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, "").strip() or default)
    except ValueError:
        return default


limiter = RateLimiter(
    # Slug = full project folder name (matches the central control sheet rows).
    project="ail-ay2627-s1-jon-ai-investment-analyst",
    buckets={"gen": _env_int("RATE_LIMIT_GEN_MAX", 5)},
    redis_url=os.getenv("UPSTASH_REDIS_REST_URL") or os.getenv("UPSTASH_REDIS_URL", ""),
    redis_token=os.getenv("UPSTASH_REDIS_REST_TOKEN") or os.getenv("UPSTASH_REDIS_TOKEN", ""),
    default_window=_env_int("RATE_LIMIT_WINDOW_SECONDS", 432000),
)


def check_rate_limit(request: Request, bucket: str) -> None:
    limiter.enforce(request, bucket)
