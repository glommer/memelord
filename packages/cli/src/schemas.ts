import { z } from "zod";

export const memoryReportSchema = z.object({
  type: z.enum(["correction", "user_input", "insight"]).describe("What kind of memory: correction (self-correction), user_input (user-provided knowledge), or insight (codebase knowledge discovered during exploration)"),
  lesson: z.string().describe("The lesson learned — what the agent should remember"),
  what_failed: z.string().optional().describe("(correction only) The approach that failed"),
  what_worked: z.string().optional().describe("(correction only) The approach that worked"),
  tokens_wasted: z.coerce.number().optional().describe("(correction only) Approximate tokens spent on the wrong approach"),
  tools_wasted: z.coerce.number().optional().describe("(correction only) Number of tool calls wasted"),
  source: z.enum(["user_denial", "user_correction", "user_input"]).optional().describe("(user_input only) How the user provided this"),
});

export const memoryEndTaskSchema = z.object({
  task_id: z.string().describe("The task_id returned by memory_start_task"),
  tokens_used: z.coerce.number().describe("Total tokens used during this task"),
  tool_calls: z.coerce.number().describe("Total tool calls made during this task"),
  errors: z.coerce.number().describe("Number of errors encountered (failed commands, test failures, etc.)"),
  user_corrections: z.coerce.number().describe("Number of times the user corrected you or denied a tool call"),
  completed: z.coerce.boolean().describe("Whether the task was completed successfully"),
  self_report: z.array(z.object({
    memory_id: z.string(),
    score: z.coerce.number().min(0).max(3),
  })).optional().describe("Rate each retrieved memory: 0=ignored, 1=glanced, 2=useful, 3=directly applied"),
});
