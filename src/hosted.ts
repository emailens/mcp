export interface ApiRequestOptions {
  apiKey: string;
  apiUrl: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
}

export interface ApiResult<T = unknown> {
  data?: T;
  isError?: true;
  error?: string;
}

export async function apiRequest<T = unknown>(
  path: string,
  options: ApiRequestOptions,
): Promise<ApiResult<T>> {
  const { apiKey, apiUrl, method = "GET", body, timeoutMs = 30_000 } = options;
  const url = `${apiUrl}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: method !== "GET" ? method : body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (response.status === 401) {
      return {
        isError: true,
        error: "Invalid or revoked API key. Generate a new one at emailens.dev/settings/api-keys?ref=mcp",
      };
    }

    if (response.status === 403) {
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        isError: true,
        error: data.upgrade
          ? "This feature requires a plan upgrade. Visit emailens.dev/pricing?ref=mcp"
          : "Access denied. Check your plan at emailens.dev/pricing?ref=mcp",
      };
    }

    if (response.status === 429) {
      const data = (await response.json().catch(() => ({}))) as Record<string, number>;
      return {
        isError: true,
        error: `Daily quota exceeded${data.limit ? ` (${data.limit - (data.remaining ?? 0)}/${data.limit})` : ""}. Resets tomorrow. Upgrade at emailens.dev/pricing?ref=mcp`,
      };
    }

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return { isError: true, error: (data.error as string) ?? `API error: ${response.status}` };
    }

    const data = (await response.json()) as T;
    return { data };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { isError: true, error: `Request timed out after ${timeoutMs / 1000}s. Try again or check emailens.dev status.` };
    }
    return { isError: true, error: `Network error: ${(err as Error).message}` };
  } finally {
    clearTimeout(timer);
  }
}

export function mcpError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

export function noApiKeyError(toolName: string, extraInfo?: string) {
  const lines = [
    `${toolName} requires an Emailens API key.`,
    "",
    "1. Sign up free at emailens.dev?ref=mcp",
    "2. Create a key at emailens.dev/settings/api-keys?ref=mcp",
    "3. Add to your MCP config:",
    "",
    '   "env": { "EMAILENS_API_KEY": "ek_live_..." }',
  ];
  if (extraInfo) {
    lines.push("", extraInfo);
  } else {
    lines.push("", "Free plan includes 30 previews/day (each preview can include screenshots).");
  }
  return mcpError(lines.join("\n"));
}
