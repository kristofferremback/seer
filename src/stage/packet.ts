import { normalize, validate, validateInline } from "../overseer/markdown";

export const BUILDER_INTENT_MAX = 1_200;
export const BUILDER_CONTEXT_MAX = 4_000;
export const BUILDER_LABEL_MAX = 80;

export interface StageBuilderPacket {
  intent: string;
  context: string;
  agent: { name: string; model: string };
}

export class StagePacketError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "StagePacketError";
  }
}

function plain(field: string, value: unknown, cap: number, required: boolean): string {
  if (typeof value !== "string") throw new StagePacketError(field, "must be plain text");
  if (required && value.trim() === "") throw new StagePacketError(field, "is required");
  const text = normalize(value).trim();
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(text)) {
    throw new StagePacketError(field, "must be one line with no control characters");
  }
  if (text.length > cap) throw new StagePacketError(field, `is over budget: ${text.length} of at most ${cap} characters`);
  const inline = validateInline(text);
  if (!inline.ok) throw new StagePacketError(field, "must be plain one-line text with inline code only");
  return text;
}

function markdown(field: string, value: unknown, cap: number, required: boolean): string {
  if (typeof value !== "string") throw new StagePacketError(field, "must be constrained markdown");
  const text = normalize(value);
  if (required && text.trim() === "") throw new StagePacketError(field, "is required");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0085\u2028\u2029]/.test(text)) {
    throw new StagePacketError(field, "carries control characters");
  }
  if (text.length > cap) throw new StagePacketError(field, `is over budget: ${text.length} of at most ${cap} characters`);
  const result = validate(text);
  if (!result.ok) throw new StagePacketError(field, result.message);
  return text;
}

export function normalizeBuilderPacket(value: unknown): StageBuilderPacket {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StagePacketError("builder", "is required and must be an object");
  }
  const body = value as Record<string, unknown>;
  const allowed = new Set(["intent", "context", "agent"]);
  const extra = Object.keys(body).find((key) => !allowed.has(key));
  if (extra) throw new StagePacketError(`builder.${extra}`, "is not a supported field");
  const agent = body.agent;
  if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
    throw new StagePacketError("builder.agent", "is required and must be an object");
  }
  const agentBody = agent as Record<string, unknown>;
  const agentExtra = Object.keys(agentBody).find((key) => key !== "name" && key !== "model");
  if (agentExtra) throw new StagePacketError(`builder.agent.${agentExtra}`, "is not a supported field");
  return {
    intent: markdown("builder.intent", body.intent, BUILDER_INTENT_MAX, true),
    context: markdown("builder.context", body.context, BUILDER_CONTEXT_MAX, false),
    agent: {
      name: plain("builder.agent.name", agentBody.name, BUILDER_LABEL_MAX, true),
      model: plain("builder.agent.model", agentBody.model, BUILDER_LABEL_MAX, true),
    },
  };
}
