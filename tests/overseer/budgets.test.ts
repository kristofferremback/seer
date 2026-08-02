import { test, expect, describe } from "bun:test";
import { BUDGETS, maxStatements, maxGroups, maxNotes } from "../../src/overseer/types";

describe("budget scaling", () => {
  test("one pull request gets the base budget", () => {
    expect(maxStatements(1)).toBe(6);
    expect(maxGroups(1)).toBe(8);
  });

  test("each pull request past the first adds 2 statements and 4 groups", () => {
    expect(maxStatements(2)).toBe(8);
    expect(maxGroups(2)).toBe(12);
    expect(maxStatements(3)).toBe(10);
    expect(maxGroups(3)).toBe(16);
  });

  test("ceilings bind at 12 statements and 16 groups", () => {
    expect(maxStatements(5)).toBe(12);
    expect(maxGroups(5)).toBe(16);
    expect(maxStatements(50)).toBe(12);
    expect(maxGroups(50)).toBe(16);
  });

  test("the group ceiling binds one pull request before the statement ceiling", () => {
    expect(maxGroups(3)).toBe(BUDGETS.groups.ceiling);
    expect(maxStatements(3)).toBeLessThan(BUDGETS.statements.ceiling);
    expect(maxStatements(4)).toBe(BUDGETS.statements.ceiling);
  });

  test("notes do not scale with decomposition", () => {
    expect(maxNotes()).toBe(6);
    expect(BUDGETS.notes.min).toBe(0);
  });

  test("floors are flat and never above the scaled ceiling", () => {
    for (const prCount of [1, 2, 3, 5, 12]) {
      expect(maxStatements(prCount)).toBeGreaterThanOrEqual(BUDGETS.statements.min);
      expect(maxGroups(prCount)).toBeGreaterThanOrEqual(BUDGETS.groups.min);
    }
  });

  test("a degenerate pr count cannot drop below the base budget", () => {
    expect(maxStatements(0)).toBe(BUDGETS.statements.base);
    expect(maxGroups(0)).toBe(BUDGETS.groups.base);
  });
});
