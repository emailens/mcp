# Releasing

Two publishes, not one. That is the thing worth writing down.

## The registry drifts silently

`@emailens/mcp` reached 0.6.2 on npm while
[registry.modelcontextprotocol.io](https://registry.modelcontextprotocol.io)
still listed **0.4.1**, describing a server that covered "15 clients" when the
engine had tracked 21 for four releases. `server.json` in this repo was correct
the whole time. Nothing had ever pushed it.

Nobody notices, because npm is where you look and the registry is where other
people look. So the registry publish is now a workflow
(`.github/workflows/publish-registry.yml`, on a published GitHub release or on
demand) rather than a step someone has to remember.

It needs no secrets. The registry accepts GitHub OIDC for an `io.github.*`
namespace, so there is no token to store or rotate.

## The four places the version lives

| Where | Why it matters |
|---|---|
| `package.json` `version` | what npm publishes |
| `server.json` `version` | the registry entry |
| `server.json` `packages[0].version` | the npm version the entry points at; the registry rejects one that does not exist |
| `src/index.ts` `new McpServer({ version })` | what a client shows in its server list |

All four have to agree, and they have not before: the server announced `0.4.0`
for three releases. `__tests__/manifest.test.ts` checks them against each
other, along with `mcpName` matching `server.json`'s `name`, which the registry
validates against the published package and refuses the publish over.

## Steps

```bash
bun install
bun run typecheck
bun test
bun run build
```

Then bump all four version fields (the test tells you if you missed one) and
write the changelog entry.

```bash
npm publish
```

Then cut a GitHub release for the tag. The registry workflow runs from it, and
checks the npm version exists before trying.

To publish the registry entry for a release that predates the workflow, run it
by hand from the Actions tab.

## Versions

The convention across these repos: **patch for additive, minor when existing
output moves.** 0.6.2 restored documented behaviour that had never worked
(`format: "mjml"` returned an empty report rather than compiling) and shipped
as a patch, because "no problems" for a template the server never read was not
output worth preserving.

A version that gets superseded before it reaches npm keeps its changelog entry,
with the heading marked `never published`. 0.6.1 is one. Deleting it would hide
a real change from anyone comparing the two versions either side of it.
