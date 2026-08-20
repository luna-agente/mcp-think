# mcp-think

A remote MCP server for structured sequential thinking, built for Cloudflare Workers.

## Architecture

- **Cloudflare Worker** exposes `/mcp` over Streamable HTTP.
- **MCP SDK v2** defines the tools.
- **Durable Objects + SQLite** persist each sequence.
- A sequence is addressed by an explicit `sequenceId`; MCP protocol sessions do not carry application state.

This design follows the current Cloudflare guidance: new MCP servers use the v2/stateless handler, while application state for multi-step workflows lives behind an explicit Durable Object boundary. `McpAgent` is deprecated and is intentionally not used here.

## Tools

### `start_sequence`
Creates a sequence and returns a `sequenceId`.

### `add_step`
Adds a structured step. Use this for summaries, assumptions, evidence, hypotheses, or decisions. The server is not intended to expose or store hidden chain-of-thought.

### `revise_step`
Creates a new revision of a previous step while preserving the original record.

### `get_sequence`
Returns the sequence metadata and all stored steps.

### `finish_sequence`
Stores the final conclusion and marks the sequence as completed.

### `reset_sequence`
Deletes the stored sequence data.

## Local development

```bash
npm install
npm run typecheck
npm run dev
```

The local MCP endpoint is:

```text
http://localhost:8787/mcp
```

Health check:

```text
http://localhost:8787/health
```

## Deploy

Authenticate Wrangler with your Cloudflare account and run:

```bash
npm run deploy
```

Cloudflare will provision the SQLite-backed Durable Object from the migration in `wrangler.jsonc`.

## Example flow

```text
start_sequence(goal)
      ↓
sequenceId
      ↓
add_step(sequenceId, ...)
      ↓
add_step(sequenceId, ...)
      ↓
revise_step(sequenceId, stepId, ...)
      ↓
get_sequence(sequenceId)
      ↓
finish_sequence(sequenceId, conclusion)
```

## Security roadmap

The MVP intentionally has no authentication. Before exposing the endpoint publicly, add OAuth or another authentication layer and bind sequence ownership to the authenticated principal. Cloudflare's MCP guidance also recommends explicit Host/Origin validation and authentication rather than treating CORS as an auth mechanism.
