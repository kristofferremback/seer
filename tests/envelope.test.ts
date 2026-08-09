// Envelope encryption: the one way Seer stores a secret it will need to read back.
//
// The claims worth testing here are not "it round-trips" — that passes against almost any
// mistake. They are the four properties the design rests on: that a ciphertext cannot be
// moved between rows, that any altered byte is refused rather than half-decrypted, that a
// KEK can be rotated without a migration, and that equal plaintexts do not produce equal
// ciphertexts. Each is written so it would fail if the property were removed.

import { test, expect, describe, beforeEach } from "bun:test";
import { createDecipheriv } from "node:crypto";

import {
  EnvelopeError,
  generateKey,
  keyIdOf,
  loadKeyring,
  open,
  rewrap,
  seal,
  secretsEqual,
  setKeyring,
  type Keyring,
} from "../src/envelope";

const SECRET = "ghp_a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8";
const CONTEXT = "github_pat:usr_7c2k9pq4wm";

function ring(active: string, ids: string[]): Keyring {
  const keys = new Map<string, Buffer>();
  for (const id of ids) keys.set(id, Buffer.from(generateKey(), "base64"));
  return { activeId: active, keys };
}

let R: Keyring;

beforeEach(() => {
  R = ring("v1", ["v1"]);
  setKeyring(null);
});

describe("seal and open", () => {
  test("a sealed secret comes back exactly, and is nowhere in the envelope", () => {
    const envelope = seal(SECRET, CONTEXT, R);
    expect(open(envelope, CONTEXT, R)).toBe(SECRET);

    // The point of the exercise: the plaintext must not survive anywhere in the bytes,
    // in any encoding a careless implementation might have left it in.
    expect(envelope).not.toContain(SECRET);
    const raw = Buffer.from(envelope, "base64url");
    expect(raw.toString("utf8")).not.toContain(SECRET);
    expect(raw.toString("latin1")).not.toContain(SECRET);
    expect(raw.toString("hex")).not.toContain(Buffer.from(SECRET, "utf8").toString("hex"));
  });

  test("two seals of the same secret share no ciphertext", () => {
    const a = seal(SECRET, CONTEXT, R);
    const b = seal(SECRET, CONTEXT, R);
    // So a column cannot be read for which rows hold equal values. Note what this does
    // NOT prove: it passes on a fixed data key too, because the payload iv is random by
    // itself. The data key's freshness is a separate claim and is tested below, against
    // the format rather than through the front door — an earlier version of this file
    // asserted only this and believed it covered both.
    expect(a).not.toBe(b);
    expect(open(a, CONTEXT, R)).toBe(open(b, CONTEXT, R));
  });

  test("each seal mints a fresh data key", () => {
    // White-box on purpose. There is no black-box consequence of reusing the data key —
    // every ciphertext is iv-randomised regardless — so the only way to test the property
    // is to unwrap the two data keys and compare them. Reuse would be invisible from
    // outside and would quietly erode the birthday bound GCM's iv sizing assumes.
    const dekOf = (envelope: string): Buffer => {
      const raw = Buffer.from(envelope, "base64url");
      const idLength = raw[1]!;
      let at = 2 + idLength;
      const iv = raw.subarray(at, (at += 12));
      const tag = raw.subarray(at, (at += 16));
      const wrapped = raw.subarray(at, (at += 32));
      const d = createDecipheriv("aes-256-gcm", R.keys.get(R.activeId)!, iv);
      d.setAAD(raw.subarray(2, 2 + idLength));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(wrapped), d.final()]);
    };

    const first = dekOf(seal(SECRET, CONTEXT, R));
    const second = dekOf(seal(SECRET, CONTEXT, R));
    expect(first.length).toBe(32);
    expect(first.equals(second)).toBe(false);
    // And it is not the key-encryption key wearing a hat.
    expect(first.equals(R.keys.get(R.activeId)!)).toBe(false);
  });

  test("empty and large payloads both survive", () => {
    expect(open(seal("", CONTEXT, R), CONTEXT, R)).toBe("");
    const big = "x".repeat(200_000);
    expect(open(seal(big, CONTEXT, R), CONTEXT, R)).toBe(big);
  });

  test("unicode survives the round trip", () => {
    const s = "påsklilja 🌼 — ünïcodé";
    expect(open(seal(s, CONTEXT, R), CONTEXT, R)).toBe(s);
  });
});

describe("context binds a ciphertext to where it lives", () => {
  test("an envelope sealed for one row does not open for another", () => {
    const mine = seal(SECRET, "github_pat:usr_aaaaaaaaaa", R);

    // The attack this prevents: copy a ciphertext from one user's row to another's and
    // have the system decrypt it as though it were theirs.
    expect(() => open(mine, "github_pat:usr_bbbbbbbbbb", R)).toThrow(EnvelopeError);

    // And the success beside the refusal, so the test is not passing because decryption
    // is broken for everyone.
    expect(open(mine, "github_pat:usr_aaaaaaaaaa", R)).toBe(SECRET);
  });

  test("an empty context is refused on both sides rather than binding to nothing", () => {
    expect(() => seal(SECRET, "", R)).toThrow(/non-empty context/);
    const envelope = seal(SECRET, CONTEXT, R);
    expect(() => open(envelope, "", R)).toThrow(/non-empty context/);
  });
});

describe("tampering", () => {
  const regions: { name: string; at: (len: number) => number }[] = [
    { name: "the format version", at: () => 0 },
    { name: "the key id", at: () => 2 },
    { name: "the data key's iv", at: () => 6 },
    { name: "the data key's tag", at: () => 20 },
    { name: "the wrapped data key", at: () => 40 },
    { name: "the payload's iv", at: () => 74 },
    { name: "the payload's tag", at: () => 88 },
    { name: "the payload", at: (len) => len - 1 },
  ];

  for (const region of regions) {
    test(`a flipped bit in ${region.name} is refused`, () => {
      const raw = Buffer.from(seal(SECRET, CONTEXT, R), "base64url");
      const i = region.at(raw.length);
      raw[i] = raw[i]! ^ 0x01;
      // Every region is either authenticated or parsed strictly, so there is no byte a
      // caller can change and still get a plaintext back.
      expect(() => open(raw.toString("base64url"), CONTEXT, R)).toThrow(EnvelopeError);
    });
  }

  test("a truncated envelope is refused rather than read past its end", () => {
    const raw = Buffer.from(seal(SECRET, CONTEXT, R), "base64url");
    for (const cut of [0, 1, 2, 20, 60, raw.length - 1]) {
      expect(() => open(raw.subarray(0, cut).toString("base64url"), CONTEXT, R)).toThrow(
        EnvelopeError,
      );
    }
  });

  test("a future format version is refused rather than misparsed", () => {
    const raw = Buffer.from(seal(SECRET, CONTEXT, R), "base64url");
    raw[0] = 0x02;
    expect(() => open(raw.toString("base64url"), CONTEXT, R)).toThrow(/format version 2/);
  });
});

describe("key rotation", () => {
  test("a secret sealed under a retired key still opens while that key is kept", () => {
    const v1 = ring("v1", ["v1"]);
    const sealed = seal(SECRET, CONTEXT, v1);

    // Rotation: a new key becomes active, the old one stays in the ring.
    const both: Keyring = {
      activeId: "v2",
      keys: new Map([...v1.keys, ["v2", Buffer.from(generateKey(), "base64")]]),
    };
    expect(open(sealed, CONTEXT, both)).toBe(SECRET);
    expect(keyIdOf(sealed)).toBe("v1");

    // New writes go under the new key, with no migration in between.
    expect(keyIdOf(seal(SECRET, CONTEXT, both))).toBe("v2");
  });

  test("rewrap moves an envelope to the active key, and is idempotent", () => {
    const v1 = ring("v1", ["v1"]);
    const sealed = seal(SECRET, CONTEXT, v1);
    const both: Keyring = {
      activeId: "v2",
      keys: new Map([...v1.keys, ["v2", Buffer.from(generateKey(), "base64")]]),
    };

    const moved = rewrap(sealed, CONTEXT, both);
    expect(keyIdOf(moved)).toBe("v2");
    expect(open(moved, CONTEXT, both)).toBe(SECRET);

    // A sweep must be safe to re-run over rows it has already done.
    expect(rewrap(moved, CONTEXT, both)).toBe(moved);

    // And once every row is moved, the old key can go — which is the whole point of the
    // rotation story, so it is asserted rather than assumed.
    const v2Only: Keyring = { activeId: "v2", keys: new Map([["v2", both.keys.get("v2")!]]) };
    expect(open(moved, CONTEXT, v2Only)).toBe(SECRET);
    expect(() => open(sealed, CONTEXT, v2Only)).toThrow(/not in the keyring/);
  });

  test("a key dropped too early fails by name, not by looking like corruption", () => {
    const v1 = ring("v1", ["v1"]);
    const sealed = seal(SECRET, CONTEXT, v1);
    const wrong = ring("v9", ["v9"]);
    // The message has to distinguish "you retired a key that is still in use" from "these
    // bytes are damaged", because the fixes are entirely different.
    expect(() => open(sealed, CONTEXT, wrong)).toThrow(/sealed under key "v1"/);
  });

  test("an envelope names its key, and the ring is consulted by that name", () => {
    const v1 = ring("v1", ["v1"]);
    const sealed = seal(SECRET, CONTEXT, v1);
    // Right key bytes, wrong name: refused, because lookup is by the id the envelope
    // carries rather than by trying every key in the ring. Being explicit about what this
    // proves — it is the *lookup*, not the id's AAD. Removing `setAAD(idBytes)` leaves
    // this test green, because a relabelled envelope fails the ring lookup first and, if
    // it somehow got past that, would fail the GCM tag anyway. The AAD is defence in
    // depth over an already-closed door, and this test should not be read as its proof.
    const relabelled: Keyring = { activeId: "other", keys: new Map([["other", v1.keys.get("v1")!]]) };
    expect(() => open(sealed, CONTEXT, relabelled)).toThrow(/sealed under key "v1"/);
  });

  test("an envelope relabelled to name a key the attacker controls is still refused", () => {
    // The scenario the id binding exists for: someone who can write the column rewrites
    // the key id to point at a key they know, hoping the wrapped data key will be read
    // under it. The tag over the wrapped key is what refuses this.
    const attacker = Buffer.from(generateKey(), "base64");
    const v1 = ring("v1", ["v1"]);
    const both: Keyring = { activeId: "v1", keys: new Map([...v1.keys, ["evil", attacker]]) };
    const sealed = Buffer.from(seal(SECRET, CONTEXT, both), "base64url");

    // "v1" and "evil" differ in length, so the id is rewritten with its length byte.
    const idBytes = Buffer.from("evil", "utf8");
    const rest = sealed.subarray(2 + sealed[1]!);
    const forged = Buffer.concat([Buffer.from([sealed[0]!, idBytes.length]), idBytes, rest]);

    expect(() => open(forged.toString("base64url"), CONTEXT, both)).toThrow(EnvelopeError);
    // The success beside the refusal: the untouched envelope still opens.
    expect(open(sealed.toString("base64url"), CONTEXT, both)).toBe(SECRET);
  });
});

describe("the keyring is read from the environment, and complains precisely", () => {
  const k = generateKey();

  test("it parses several keys and honours the active one", () => {
    const r = loadKeyring({
      SEER_ENCRYPTION_KEYS: `v1:${k},v2:${generateKey()}`,
      SEER_ENCRYPTION_ACTIVE_KEY: "v2",
    } as NodeJS.ProcessEnv);
    expect(r.activeId).toBe("v2");
    expect([...r.keys.keys()]).toEqual(["v1", "v2"]);
  });

  test("with one key and no active named, that key is active", () => {
    const r = loadKeyring({ SEER_ENCRYPTION_KEYS: `v1:${k}` } as NodeJS.ProcessEnv);
    expect(r.activeId).toBe("v1");
  });

  const bad: [string, NodeJS.ProcessEnv, RegExp][] = [
    ["unset", {} as NodeJS.ProcessEnv, /SEER_ENCRYPTION_KEYS is not set/],
    ["empty", { SEER_ENCRYPTION_KEYS: "  " } as NodeJS.ProcessEnv, /is not set/],
    ["no colon", { SEER_ENCRYPTION_KEYS: "justakey" } as NodeJS.ProcessEnv, /malformed/],
    ["bad id", { SEER_ENCRYPTION_KEYS: `V1!:${k}` } as NodeJS.ProcessEnv, /key id/],
    ["duplicate id", { SEER_ENCRYPTION_KEYS: `v1:${k},v1:${k}` } as NodeJS.ProcessEnv, /twice/],
    ["short key", { SEER_ENCRYPTION_KEYS: "v1:c2hvcnQ=" } as NodeJS.ProcessEnv, /bytes.*required/],
    [
      "active names a missing key",
      { SEER_ENCRYPTION_KEYS: `v1:${k}`, SEER_ENCRYPTION_ACTIVE_KEY: "v7" } as NodeJS.ProcessEnv,
      /SEER_ENCRYPTION_ACTIVE_KEY names "v7"/,
    ],
  ];

  for (const [name, env, message] of bad) {
    test(`${name} throws, naming the variable`, () => {
      // Every one of these is a misconfiguration that would otherwise be discovered as an
      // undecryptable column months later, so each fails at the point of use with the
      // variable named.
      expect(() => loadKeyring(env)).toThrow(message);
    });
  }

  test("a generated key is 32 bytes of base64", () => {
    expect(Buffer.from(generateKey(), "base64").length).toBe(32);
    expect(generateKey()).not.toBe(generateKey());
  });
});

describe("secretsEqual", () => {
  test("compares by content and refuses length-mismatched pairs", () => {
    expect(secretsEqual("abc", "abc")).toBe(true);
    expect(secretsEqual("abc", "abd")).toBe(false);
    // timingSafeEqual throws on unequal lengths; the guard is what keeps that a false
    // rather than a 500, the same shape auth.ts uses for session signatures.
    expect(secretsEqual("abc", "abcd")).toBe(false);
    expect(secretsEqual("", "")).toBe(true);
  });
});
