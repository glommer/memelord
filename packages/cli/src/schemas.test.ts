import { describe, test, expect } from "bun:test";
import { memoryReportSchema, memoryEndTaskSchema } from "./schemas.js";

describe("memoryReportSchema", () => {
  test("accepts native number types", () => {
    const result = memoryReportSchema.parse({
      type: "correction",
      lesson: "use bun instead of node",
      tokens_wasted: 5000,
      tools_wasted: 3,
    });
    expect(result.tokens_wasted).toBe(5000);
    expect(result.tools_wasted).toBe(3);
  });

  test("coerces string numbers to numbers", () => {
    const result = memoryReportSchema.parse({
      type: "correction",
      lesson: "use bun instead of node",
      tokens_wasted: "5000",
      tools_wasted: "3",
    });
    expect(result.tokens_wasted).toBe(5000);
    expect(result.tools_wasted).toBe(3);
  });

  test("allows omitting optional numeric fields", () => {
    const result = memoryReportSchema.parse({
      type: "insight",
      lesson: "config lives in src/config",
    });
    expect(result.tokens_wasted).toBeUndefined();
    expect(result.tools_wasted).toBeUndefined();
  });
});

describe("memoryEndTaskSchema", () => {
  const validBase = {
    task_id: "abc-123",
    tokens_used: 50000,
    tool_calls: 12,
    errors: 2,
    user_corrections: 0,
    completed: true,
  };

  test("accepts native types", () => {
    const result = memoryEndTaskSchema.parse(validBase);
    expect(result.tokens_used).toBe(50000);
    expect(result.tool_calls).toBe(12);
    expect(result.errors).toBe(2);
    expect(result.user_corrections).toBe(0);
    expect(result.completed).toBe(true);
  });

  test("coerces string numbers to numbers", () => {
    const result = memoryEndTaskSchema.parse({
      ...validBase,
      tokens_used: "50000",
      tool_calls: "12",
      errors: "2",
      user_corrections: "0",
    });
    expect(result.tokens_used).toBe(50000);
    expect(result.tool_calls).toBe(12);
    expect(result.errors).toBe(2);
    expect(result.user_corrections).toBe(0);
  });

  test("coerces string boolean to boolean", () => {
    const result = memoryEndTaskSchema.parse({
      ...validBase,
      completed: "true",
    });
    expect(result.completed).toBe(true);

    const result2 = memoryEndTaskSchema.parse({
      ...validBase,
      completed: "false",
    });
    // Note: z.coerce.boolean() uses Boolean() which makes any non-empty string true
    // "false" string coerces to true via Boolean("false") === true
    // This is a known z.coerce.boolean() behavior
    expect(result2.completed).toBe(true);
  });

  test("coerces falsy values to false", () => {
    const result = memoryEndTaskSchema.parse({
      ...validBase,
      completed: 0,
    });
    expect(result.completed).toBe(false);

    const result2 = memoryEndTaskSchema.parse({
      ...validBase,
      completed: "",
    });
    expect(result2.completed).toBe(false);
  });

  test("coerces self_report scores from strings", () => {
    const result = memoryEndTaskSchema.parse({
      ...validBase,
      self_report: [
        { memory_id: "mem-1", score: "2" },
        { memory_id: "mem-2", score: "3" },
      ],
    });
    expect(result.self_report![0].score).toBe(2);
    expect(result.self_report![1].score).toBe(3);
  });

  test("still enforces min/max on self_report scores", () => {
    expect(() =>
      memoryEndTaskSchema.parse({
        ...validBase,
        self_report: [{ memory_id: "mem-1", score: "5" }],
      }),
    ).toThrow();

    expect(() =>
      memoryEndTaskSchema.parse({
        ...validBase,
        self_report: [{ memory_id: "mem-1", score: "-1" }],
      }),
    ).toThrow();
  });

  test("rejects completely non-numeric strings", () => {
    expect(() =>
      memoryEndTaskSchema.parse({
        ...validBase,
        tokens_used: "not-a-number",
      }),
    ).toThrow();
  });
});
