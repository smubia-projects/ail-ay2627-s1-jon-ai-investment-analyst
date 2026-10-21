"""Centralised rate-limit engine — FastAPI.

Copy this file into the project alongside your app entry point (e.g.
``rate_limit_engine.py``), then add a small adapter that supplies the project
slug and its buckets:

    from rate_limit_engine import RateLimiter

    limiter = RateLimiter(
        project="my-project",
        buckets={"gen": 5, "img": 2},
        redis_url=settings.upstash_redis_url,
        redis_token=settings.upstash_redis_token,
        default_window=settings.rate_limit_window_seconds,
    )

    def check_rate_limit(request, bucket):
        limiter.enforce(request, bucket)

Call ``check_rate_limit(request, "gen")`` at the top of each AI route.

Limits and switches are read from the shared Upstash Redis DB at request time,
cached for ``cache_ttl`` seconds, with the ``buckets`` values as the fallback.
See the central rate-limit config documentation for the key schema and the
Google-Sheet control plane.
"""

from __future__ import annotations

import time
from typing import NamedTuple, Optional

ENGINE_VERSION = "1.3.0"


class RateLimitStatus(NamedTuple):
    status: str  # "ok" | "limited" | "killed"
    max: Optional[int]  # active max when "limited", else None


def client_ip(request) -> str:
    """Real client IP, honouring X-Forwarded-For (Cloud Run / HF / proxies sit in
    front of the app, so request.client.host is the proxy, not the user)."""
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()  # leftmost entry is the original client
    return request.client.host if request.client else "unknown"


class RateLimiter:
    def __init__(
        self,
        project: str,
        buckets: dict[str, int],
        *,
        redis_url: str = "",
        redis_token: str = "",
        default_window: int = 432000,
        cache_ttl: int = 90,
    ) -> None:
        self.project = project
        self.buckets = dict(buckets)  # action name -> fallback default (from env)
        self._redis_url = redis_url
        self._redis_token = redis_token
        self.default_window = default_window
        self.cache_ttl = cache_ttl
        self._redis = None
        self._cache = {
            "t": 0.0,
            "salt": "",
            "killed": False,
            "limits": dict(buckets),
            "window": default_window,
        }

    def _get_redis(self):
        if self._redis is None:
            if not self._redis_url or not self._redis_token:
                return None  # limiting disabled (e.g. local dev)
            from upstash_redis import Redis

            self._redis = Redis(url=self._redis_url, token=self._redis_token)
        return self._redis

    def _refresh(self, redis) -> None:
        """Refresh cached switches/limits at most once per cache_ttl. Fail open."""
        now = time.time()
        if now - self._cache["t"] < self.cache_ttl:
            return
        try:
            # One MGET covers globals + both modes, so we never need a second
            # round trip to resolve the active mode (MGET counts as one command).
            keys = [
                "config:kill_all",
                "config:event_mode",
                "config:ratelimit_salt",
                f"config:{self.project}:mode_override",
                f"config:{self.project}:enabled",
            ]
            for m in ("default", "demo"):
                keys.append(f"config:{self.project}:{m}:window")
                keys.extend(f"config:{self.project}:{m}:{b}" for b in self.buckets)
            data = dict(zip(keys, redis.mget(*keys)))

            killed = (
                str(data["config:kill_all"]) == "1"
                or str(data[f"config:{self.project}:enabled"]) == "0"
            )
            mode = (
                data[f"config:{self.project}:mode_override"]
                or data["config:event_mode"]
                or "default"
            )
            if mode not in ("default", "demo"):
                mode = "default"
            salt = data["config:ratelimit_salt"] or ""
            w = data[f"config:{self.project}:{mode}:window"]
            window = int(w) if w is not None else self.default_window
            limits = {}
            for bucket, env_default in self.buckets.items():
                v = data[f"config:{self.project}:{mode}:{bucket}"]
                limits[bucket] = int(v) if v is not None else env_default
            self._cache.update(
                t=now, salt=salt, killed=killed, limits=limits, window=window
            )
        except Exception:
            # Config unreachable -> keep caller defaults, stay live, never block.
            self._cache.update(
                t=now, killed=False, limits=dict(self.buckets),
                window=self.default_window,
            )

    def status(self, ip: str, bucket: str) -> RateLimitStatus:
        """Check/count a hit and return the result as a ``RateLimitStatus``.

        Returns ``RateLimitStatus("ok", None)``, ``("limited", active_max)``,
        or ``("killed", None)``.  Counts the hit only when not killed and a
        positive limit applies.  Framework-agnostic — call directly when you
        don't want ``enforce()`` (e.g. Telegram bots, CLI tools).
        """
        redis = self._get_redis()
        if redis is None:
            return RateLimitStatus("ok", None)
        self._refresh(redis)
        if self._cache["killed"]:
            return RateLimitStatus("killed", None)

        max_requests = self._cache["limits"].get(bucket, self.buckets.get(bucket, 0))
        if max_requests <= 0:
            return RateLimitStatus("ok", None)

        key = f"ratelimit:{self._cache['salt']}:{self.project}:{bucket}:{ip}"
        try:
            count = redis.incr(key)
            if count == 1:
                redis.expire(key, self._cache["window"])
        except Exception:
            return RateLimitStatus("ok", None)
        return RateLimitStatus("limited", max_requests) if count > max_requests else RateLimitStatus("ok", None)

    def enforce(self, request, bucket: str) -> None:
        """Raise HTTP 503 if the demo is paused, or 429 if over the limit.

        The 429 body carries the active max as `queries_used` so the shared
        rate-limit CTA modal shows the right number.
        """
        state, value = self.status(client_ip(request), bucket)
        if state == "killed":
            from fastapi import HTTPException

            raise HTTPException(
                status_code=503,
                detail={"message": "This demo is temporarily paused. Check back soon."},
            )
        if state == "limited":
            from fastapi import HTTPException

            raise HTTPException(
                status_code=429,
                detail={"message": "Rate limit exceeded.", "queries_used": value},
            )
