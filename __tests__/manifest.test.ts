import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The version is written down in four places, and they have to agree.
 *
 * `package.json` is what npm publishes. `server.json` carries it twice: once
 * for the registry entry and once for the npm package it points at, which the
 * registry rejects if it is not a real published version. And the server
 * announces its own version over stdio in `initialize`, which is what a client
 * displays.
 *
 * They have drifted before: the server reported `0.4.0` for three releases and
 * `server.json` sat at `0.4.1` while npm was on `0.6.0`. Nothing noticed,
 * because nothing was looking.
 */

const read = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "..", name), "utf-8"));
const pkg = read("package.json");
const server = read("server.json");
const source = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf-8");

describe("the version, in every place it is written", () => {
  test("server.json matches package.json, in both fields", () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
  });

  test("the server announces the version it actually is", () => {
    // What a client shows in its server list. It said 0.4.0 for three releases.
    const announced = /new McpServer\(\{[^}]*version:\s*"([^"]+)"/s.exec(source)?.[1];
    expect(announced).toBe(pkg.version);
  });

  test("the registry name matches the one npm will see", () => {
    // The registry checks the published package's `mcpName` against the name
    // in server.json and refuses the publish if they differ.
    expect(pkg.mcpName).toBe(server.name);
    expect(server.name).toMatch(/^io\.github\.[a-z0-9-]+\/[a-z0-9-]+$/);
  });

  test("server.json points at this package", () => {
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].registryType).toBe("npm");
  });

  test("the registry description says what the tools actually cover", () => {
    // It advertised 15 clients through four releases while the engine had 21,
    // and named none of the template languages.
    const { description } = server;
    expect(description).not.toMatch(/\b15 (email )?clients\b/);
    expect(description).toMatch(/\b21 (email )?clients\b/);
    for (const framework of ["MJML", "Maizzle", "React Email"]) {
      expect([framework, description.includes(framework)]).toEqual([framework, true]);
    }
    // 100 characters, hard. The registry rejects the publish with a 422 over
    // it, which is how this was found: a 139-character description passed
    // OIDC login and then bounced off validation. Guessing the limit was
    // generous is why the test did not catch it first.
    expect(description.length).toBeLessThanOrEqual(100);
  });
});
