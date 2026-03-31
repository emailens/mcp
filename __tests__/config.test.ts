import { describe, test, expect, beforeEach, afterEach } from "bun:test";

describe("config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("defaults: no API key, hosted is false, default URL", async () => {
    delete process.env.EMAILENS_API_KEY;
    delete process.env.EMAILENS_API_URL;
    const { config } = await import("../src/config");
    expect(config.apiKey).toBeNull();
    expect(config.apiUrl).toBe("https://emailens.dev");
    expect(config.isHosted).toBe(false);
  });

  test("reads EMAILENS_API_KEY from env", async () => {
    process.env.EMAILENS_API_KEY = "ek_live_testkey123456789012345678";
    const mod = await import("../src/config?t=" + Date.now());
    expect(mod.config.apiKey).toBe("ek_live_testkey123456789012345678");
    expect(mod.config.isHosted).toBe(true);
  });

  test("reads EMAILENS_API_URL from env", async () => {
    process.env.EMAILENS_API_URL = "https://staging.emailens.dev";
    const mod = await import("../src/config?t=" + Date.now());
    expect(mod.config.apiUrl).toBe("https://staging.emailens.dev");
  });
});
