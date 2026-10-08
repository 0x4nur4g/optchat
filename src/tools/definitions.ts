import type { ToolDefinition } from "../model/adapter";

/** Fixed Phase 1 tool schema. Reuse unchanged for every native turn request. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  {
    name: "zoom",
    description: "Read an aligned chat range. For n=1, return the original message; otherwise return its two summaries.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "integer", minimum: 0, description: "First message ID of the range." },
        n: { type: "integer", minimum: 1, description: "Range length, a power of two; id must be aligned to n." },
      },
      required: ["id", "n"],
      additionalProperties: false,
    },
  },
  {
    name: "date",
    description: "Read the stored local date and time of a chat message.",
    parameters: {
      type: "object",
      properties: { id: { type: "integer", minimum: 0, description: "Message ID." } },
      required: ["id"],
      additionalProperties: false,
    },
  },
]);
