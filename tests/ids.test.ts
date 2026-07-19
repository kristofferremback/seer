import { test, expect, describe } from "bun:test";
import {
  tinyId,
  newApiKey,
  hashKey,
  keyHint,
  USR_ID_RE,
  WS_ID_RE,
  INV_ID_RE,
  KEY_ID_RE,
  API_KEY_RE,
} from "../src/ids";

const CROCKFORD = /^[0-9abcdefghjkmnpqrstvwxyz]+$/;

describe("tinyId", () => {
  test("shape: <prefix>_ + 10 crockford chars", () => {
    const id = tinyId("ws");
    expect(id.startsWith("ws_")).toBe(true);
    expect(id.length).toBe("ws_".length + 10);
    expect(CROCKFORD.test(id.slice(3))).toBe(true);
  });

  test("ids match their route regexes and never the wrong one", () => {
    expect(USR_ID_RE.test(tinyId("usr"))).toBe(true);
    expect(WS_ID_RE.test(tinyId("ws"))).toBe(true);
    expect(INV_ID_RE.test(tinyId("inv"))).toBe(true);
    expect(KEY_ID_RE.test(tinyId("key"))).toBe(true);
    expect(WS_ID_RE.test(tinyId("usr"))).toBe(false);
    // No ambiguous Crockford letters (i, l, o, u) in the alphabet.
    for (let i = 0; i < 200; i++) {
      expect(/[ilou]/.test(tinyId("ws").slice(3))).toBe(false);
    }
  });

  test("uniqueness over a few thousand draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(tinyId("ws"));
    expect(seen.size).toBe(5000);
  });
});

describe("api keys", () => {
  test("token shape and regex", () => {
    const t = newApiKey();
    expect(t.startsWith("seer_sk_")).toBe(true);
    expect(API_KEY_RE.test(t)).toBe(true);
    // 8 (prefix) + 32 body
    expect(t.length).toBe(8 + 32);
  });

  test("uniqueness over a few thousand draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) seen.add(newApiKey());
    expect(seen.size).toBe(5000);
  });

  test("hashKey is deterministic sha256 hex of the full token", () => {
    const t = newApiKey();
    const h = hashKey(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey(t)).toBe(h);
    expect(hashKey(t + "x")).not.toBe(h);
  });

  test("keyHint: first 12 + separator + last 4", () => {
    const t = "seer_sk_9f3Kabcdefghijklmnopqrstuv12sD2e";
    const hint = keyHint(t);
    expect(hint).toBe(`seer_sk_9f3K····${t.slice(-4)}`);
    expect(hint).toContain("····");
  });
});
