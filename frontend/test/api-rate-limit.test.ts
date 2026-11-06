import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiPost, DEMO_PAUSED_EVENT, liveAiFallback, RATE_LIMIT_EVENT } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

function stubResponse(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
}

describe("shared API helper", () => {
  it("calls the configured backend base directly", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/v1/demo", {});
    expect(String(fetchMock.mock.calls[0][0])).toBe("http://localhost:8000/v1/demo");
  });

  it("broadcasts 429 with queries_used for the CTA modal", async () => {
    stubResponse(429, { detail: { message: "Rate limit exceeded.", queries_used: 5 } });
    const listener = vi.fn();
    window.addEventListener(RATE_LIMIT_EVENT, listener);
    const error = await apiPost<never>("/v1/inference/generate", { prompt: "x" }).catch((reason) => reason as ApiError);
    window.removeEventListener(RATE_LIMIT_EVENT, listener);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(429);
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ queriesUsed: 5 });
    expect(liveAiFallback(error)).toMatch(/quota/i);
  });

  it("broadcasts the kill-switch 503 as a paused notice, not the CTA", async () => {
    stubResponse(503, { detail: { message: "This demo is temporarily paused. Check back soon." } });
    const paused = vi.fn();
    const limited = vi.fn();
    window.addEventListener(DEMO_PAUSED_EVENT, paused);
    window.addEventListener(RATE_LIMIT_EVENT, limited);
    const error = await apiPost<never>("/v1/inference/generate", { prompt: "x" }).catch((reason) => reason as ApiError);
    window.removeEventListener(DEMO_PAUSED_EVENT, paused);
    window.removeEventListener(RATE_LIMIT_EVENT, limited);
    expect(error.message).toMatch(/paused/);
    expect((paused.mock.calls[0][0] as CustomEvent).detail.message).toMatch(/paused/);
    expect(limited).not.toHaveBeenCalled();
  });

  it("treats 501 as live AI not configured", async () => {
    stubResponse(501, { detail: "Live AI is not configured on this server. Use Manual AI Mode." });
    const error = await apiPost<never>("/v1/inference/generate", { prompt: "x" }).catch((reason) => reason as ApiError);
    expect(liveAiFallback(error)).toMatch(/not configured/i);
  });
});
