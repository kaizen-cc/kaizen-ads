import type { Staff } from "@/lib/auth";

/**
 * A tool Kaizen AI (or any screen) can call: a name, what it does, the JSON schema of its input, and run(user, input).
 * run checks the person's own rights; it never trusts the caller to have done so.
 */
export type AiTool = {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  run: (user: Staff, input: Record<string, unknown>) => Promise<unknown>;
};
