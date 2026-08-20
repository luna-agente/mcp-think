import { DurableObject } from "cloudflare:workers";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { z } from "zod";

interface Env {
  SEQUENCE: DurableObjectNamespace<SequenceState>;
}

type SequenceStatus = "active" | "completed";
type StepStatus = "proposed" | "active" | "completed" | "revised";

interface StepInput {
  title: string;
  summary: string;
  status: StepStatus;
  confidence?: number;
  branch?: string;
  parentStepId?: number;
}

function sequenceStub(env: Env, sequenceId: string) {
  return env.SEQUENCE.get(env.SEQUENCE.idFromName(sequenceId));
}

function text(data: unknown) {
  return JSON.stringify(data, null, 2);
}

function createServer(env: Env) {
  const server = new McpServer({
    name: "mcp-think",
    version: "0.1.0",
  });

  server.registerTool(
    "start_sequence",
    {
      description:
        "Start a structured sequential-thinking session. State is stored durably by sequence_id.",
      inputSchema: {
        goal: z.string().min(1),
        maxSteps: z.number().int().positive().max(100).optional(),
      },
    },
    async ({ goal, maxSteps }) => {
      const sequenceId = crypto.randomUUID();
      await sequenceStub(env, sequenceId).initialize(goal, maxSteps ?? 50);

      return {
        content: [
          {
            type: "text",
            text: text({ sequenceId, goal, maxSteps: maxSteps ?? 50, status: "active" }),
          },
        ],
      };
    },
  );

  server.registerTool(
    "add_step",
    {
      description:
        "Append one structured reasoning step to an existing sequence. Store summaries, evidence, assumptions, or decisions rather than hidden chain-of-thought.",
      inputSchema: {
        sequenceId: z.string().uuid(),
        title: z.string().min(1),
        summary: z.string().min(1),
        status: z
          .enum(["proposed", "active", "completed", "revised"])
          .default("active"),
        confidence: z.number().min(0).max(1).optional(),
        branch: z.string().max(100).optional(),
        parentStepId: z.number().int().positive().optional(),
      },
    },
    async (input) => {
      const step = await sequenceStub(env, input.sequenceId).addStep(input);
      return { content: [{ type: "text", text: text(step) }] };
    },
  );

  server.registerTool(
    "revise_step",
    {
      description: "Revise a previously stored step while preserving a revision trail.",
      inputSchema: {
        sequenceId: z.string().uuid(),
        stepId: z.number().int().positive(),
        title: z.string().min(1).optional(),
        summary: z.string().min(1).optional(),
        status: z
          .enum(["proposed", "active", "completed", "revised"])
          .optional(),
        confidence: z.number().min(0).max(1).optional(),
        branch: z.string().max(100).optional(),
      },
    },
    async ({ sequenceId, stepId, ...patch }) => {
      const step = await sequenceStub(env, sequenceId).reviseStep(stepId, patch);
      return { content: [{ type: "text", text: text(step) }] };
    },
  );

  server.registerTool(
    "get_sequence",
    {
      description: "Read the current state and structured steps of a sequence.",
      inputSchema: {
        sequenceId: z.string().uuid(),
      },
    },
    async ({ sequenceId }) => {
      const sequence = await sequenceStub(env, sequenceId).getSequence();
      return { content: [{ type: "text", text: text(sequence) }] };
    },
  );

  server.registerTool(
    "finish_sequence",
    {
      description: "Complete a sequence with a final conclusion and optional confidence.",
      inputSchema: {
        sequenceId: z.string().uuid(),
        conclusion: z.string().min(1),
        confidence: z.number().min(0).max(1).optional(),
      },
    },
    async ({ sequenceId, conclusion, confidence }) => {
      const result = await sequenceStub(env, sequenceId).finishSequence(
        conclusion,
        confidence,
      );
      return { content: [{ type: "text", text: text(result) }] };
    },
  );

  server.registerTool(
    "reset_sequence",
    {
      description: "Delete all stored data for a sequence.",
      inputSchema: {
        sequenceId: z.string().uuid(),
      },
    },
    async ({ sequenceId }) => {
      await sequenceStub(env, sequenceId).resetSequence();
      return {
        content: [{ type: "text", text: text({ sequenceId, reset: true }) }],
      };
    },
  );

  return server;
}

export class SequenceState extends DurableObject<Env> {
  private initialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();
  }

  private ensureSchema() {
    if (this.initialized) return;

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS sequence (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        goal TEXT NOT NULL,
        max_steps INTEGER NOT NULL,
        status TEXT NOT NULL,
        conclusion TEXT,
        confidence REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS step (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL,
        branch TEXT,
        parent_step_id INTEGER,
        revision_of INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY (parent_step_id) REFERENCES step(id),
        FOREIGN KEY (revision_of) REFERENCES step(id)
      )
    `);

    this.initialized = true;
  }

  async initialize(goal: string, maxSteps: number) {
    this.ensureSchema();
    const now = new Date().toISOString();

    this.ctx.storage.sql.exec("DELETE FROM step");
    this.ctx.storage.sql.exec("DELETE FROM sequence");
    this.ctx.storage.sql.exec(
      `INSERT INTO sequence (id, goal, max_steps, status, created_at, updated_at)
       VALUES (1, ?, ?, 'active', ?, ?)`,
      goal,
      maxSteps,
      now,
      now,
    );

    return { status: "active", goal, maxSteps };
  }

  async addStep(input: StepInput) {
    this.ensureSchema();
    const current = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) AS count FROM step")
      .one();

    const sequence = this.ctx.storage.sql
      .exec<{ max_steps: number; status: SequenceStatus }>(
        "SELECT max_steps, status FROM sequence WHERE id = 1",
      )
      .one();

    if (!sequence) throw new Error("Sequence not found");
    if (sequence.status === "completed") throw new Error("Sequence is already completed");
    if (current.count >= sequence.max_steps) throw new Error("Maximum number of steps reached");

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO step
        (title, summary, status, confidence, branch, parent_step_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.title,
      input.summary,
      input.status,
      input.confidence ?? null,
      input.branch ?? null,
      input.parentStepId ?? null,
      now,
    );

    this.ctx.storage.sql.exec("UPDATE sequence SET updated_at = ? WHERE id = 1", now);

    return this.ctx.storage.sql.exec(
      "SELECT * FROM step WHERE id = last_insert_rowid()",
    ).one();
  }

  async reviseStep(
    stepId: number,
    patch: Partial<Omit<StepInput, "parentStepId">>,
  ) {
    this.ensureSchema();

    const existing = this.ctx.storage.sql
      .exec<any>("SELECT * FROM step WHERE id = ?", stepId)
      .one();

    if (!existing) throw new Error(`Step ${stepId} not found`);

    const next = {
      title: patch.title ?? existing.title,
      summary: patch.summary ?? existing.summary,
      status: patch.status ?? "revised",
      confidence: patch.confidence ?? existing.confidence,
      branch: patch.branch ?? existing.branch,
    };

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO step
        (title, summary, status, confidence, branch, parent_step_id, revision_of, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      next.title,
      next.summary,
      next.status,
      next.confidence,
      next.branch,
      existing.parent_step_id ?? null,
      stepId,
      now,
    );
    this.ctx.storage.sql.exec(
      "UPDATE sequence SET updated_at = ? WHERE id = 1",
      now,
    );

    return this.ctx.storage.sql.exec(
      "SELECT * FROM step WHERE id = last_insert_rowid()",
    ).one();
  }

  async getSequence() {
    this.ensureSchema();

    const sequence = this.ctx.storage.sql.exec("SELECT * FROM sequence WHERE id = 1").one();
    if (!sequence) throw new Error("Sequence not found");

    const steps = this.ctx.storage.sql
      .exec("SELECT * FROM step ORDER BY id ASC")
      .toArray();

    return { sequence, steps };
  }

  async finishSequence(conclusion: string, confidence?: number) {
    this.ensureSchema();
    const existing = this.ctx.storage.sql.exec("SELECT * FROM sequence WHERE id = 1").one();
    if (!existing) throw new Error("Sequence not found");

    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `UPDATE sequence
       SET status = 'completed', conclusion = ?, confidence = ?, updated_at = ?
       WHERE id = 1`,
      conclusion,
      confidence ?? null,
      now,
    );

    return this.ctx.storage.sql.exec("SELECT * FROM sequence WHERE id = 1").one();
  }

  async resetSequence() {
    this.ensureSchema();
    this.ctx.storage.sql.exec("DELETE FROM step");
    this.ctx.storage.sql.exec("DELETE FROM sequence");
  }
}

export default {
  fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "mcp-think" }), {
        headers: { "content-type": "application/json" },
      });
    }

    return createMcpHandler(() => createServer(env), {
      route: "/mcp",
    })(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
