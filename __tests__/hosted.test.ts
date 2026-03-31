import { describe, test, expect, mock, beforeEach } from "bun:test";

const mockFetch = mock(() => Promise.resolve(new Response()));

describe("apiRequest", () => {
  beforeEach(() => {
    mockFetch.mockClear();
    globalThis.fetch = mockFetch as any;
  });

  test("sets Authorization header from API key", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const { apiRequest } = await import("../src/hosted");
    await apiRequest("/api/usage", { apiKey: "ek_live_abc123", apiUrl: "https://emailens.dev" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://emailens.dev/api/usage");
    expect(opts.headers).toHaveProperty("Authorization", "Bearer ek_live_abc123");
  });

  test("maps 401 to invalid key error", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }));
    const { apiRequest } = await import("../src/hosted");
    const result = await apiRequest("/api/preview", { apiKey: "ek_live_bad", apiUrl: "https://emailens.dev" });
    expect(result.isError).toBe(true);
    expect(result.error).toContain("Invalid or revoked API key");
    expect(result.error).toContain("ref=mcp");
  });

  test("maps 403 to plan upgrade error", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Forbidden", upgrade: true }), { status: 403 }));
    const { apiRequest } = await import("../src/hosted");
    const result = await apiRequest("/api/share", { apiKey: "ek_live_abc123", apiUrl: "https://emailens.dev" });
    expect(result.isError).toBe(true);
    expect(result.error).toContain("upgrade");
    expect(result.error).toContain("ref=mcp");
  });

  test("maps 429 to quota exceeded error", async () => {
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: "Rate limit", limit: 30, remaining: 0 }), { status: 429 }));
    const { apiRequest } = await import("../src/hosted");
    const result = await apiRequest("/api/preview", { apiKey: "ek_live_abc123", apiUrl: "https://emailens.dev" });
    expect(result.isError).toBe(true);
    expect(result.error).toContain("quota");
    expect(result.error).toContain("ref=mcp");
  });

  test("returns parsed JSON on 200", async () => {
    const body = { id: "abc123", status: "complete" };
    mockFetch.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 200 }));
    const { apiRequest } = await import("../src/hosted");
    const result = await apiRequest("/api/preview", { apiKey: "ek_live_abc123", apiUrl: "https://emailens.dev" });
    expect(result.isError).toBeUndefined();
    expect(result.data).toEqual(body);
  });
});
