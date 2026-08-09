import { test, expect } from "bun:test";
import { githubUserOAuthConfig } from "../src/config";

// The pair is read from an argument rather than process.env so these can be asked
// without a subprocess; config.ts calls it with process.env once, at import.

test("a deployment with neither variable boots, with no OAuth application", () => {
  expect(githubUserOAuthConfig({})).toBeNull();
});

test("exactly one variable is a mistake, and the error names both", () => {
  const half = () => githubUserOAuthConfig({ GITHUB_OAUTH_CLIENT_ID: "Ov23.x" });
  expect(half).toThrow(/GITHUB_OAUTH_CLIENT_ID/);
  expect(half).toThrow(/GITHUB_OAUTH_CLIENT_SECRET/);
  const otherHalf = () => githubUserOAuthConfig({ GITHUB_OAUTH_CLIENT_SECRET: "shh" });
  expect(otherHalf).toThrow(/GITHUB_OAUTH_CLIENT_ID/);
  expect(otherHalf).toThrow(/GITHUB_OAUTH_CLIENT_SECRET/);
});

test("both set is the enabled application", () => {
  expect(
    githubUserOAuthConfig({ GITHUB_OAUTH_CLIENT_ID: "Ov23.x", GITHUB_OAUTH_CLIENT_SECRET: "shh" }),
  ).toEqual({ clientId: "Ov23.x", clientSecret: "shh" });
});
