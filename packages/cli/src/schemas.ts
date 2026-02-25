import { z } from "zod";

export const memoryReportSchema = z.object({
  type: z.enum(["correction", "user_input", "insight"]),
  lesson: z.string(),
  what_failed: z.string().optional(),
  what_worked: z.string().optional(),
  tokens_wasted: z.coerce.number().optional(),
  tools_wasted: z.coerce.number().optional(),
  source: z.enum(["user_denial", "user_correction", "user_input"]).optional(),
});

export const memoryEndTaskSchema = z.object({
  task_id: z.string(),
  tokens_used: z.coerce.number(),
  tool_calls: z.coerce.number(),
  errors: z.coerce.number(),
  user_corrections: z.coerce.number(),
  completed: z.coerce.boolean(),
  self_report: z.array(z.object({
    memory_id: z.string(),
    score: z.coerce.number().min(0).max(3),
  })).optional(),
});
