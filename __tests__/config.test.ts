import { describe, test, expect, afterEach } from "bun:test";
import { config } from "../src/config";

describe("config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test("defaults: no API key, hosted is false, default URL", () => {
    delete process.env.EMAILENS_API_KEY;
    delete process.env.EMAILENS_API_URL;
    expect(config.apiKey).toBeNull();
    expect(config.apiUrl).toBe("https://emailens.dev");
    expect(config.isHosted).toBe(false);
  });

  test("reads EMAILENS_API_KEY from env", () => {
    process.env.EMAILENS_API_KEY = "ek_live_testkey123456789012345678";
    expect(config.apiKey).toBe("ek_live_testkey123456789012345678");
    expect(config.isHosted).toBe(true);
  });

  test("reads EMAILENS_API_URL from env", () => {
    process.env.EMAILENS_API_URL = "https://staging.emailens.dev";
    expect(config.apiUrl).toBe("https://staging.emailens.dev");
  });
});
