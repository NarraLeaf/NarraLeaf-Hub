import { describe, expect, it } from "vitest";

import {
  MalformedPasswordHashError,
  OWASP_SCRYPT_PARAMETERS,
  ScryptPasswordHasher,
  type ScryptParameters,
} from "../src/identity/passwords.js";

/**
 * The parameters Team actually uses cost a fifth of a second per hash, which is
 * the point of them. The tests that are about the format rather than the cost
 * use a cheaper setting so that the suite is not mostly key derivation.
 */
const CHEAP: ScryptParameters = { cost: 2 ** 12, blockSize: 8, parallelism: 1, keyLength: 32 };

describe("ScryptPasswordHasher", () => {
  it("writes the algorithm and the parameters into the stored string", async () => {
    const stored = await new ScryptPasswordHasher().hash("correct horse battery staple");

    // The shape is what lets a later algorithm be added without a migration.
    expect(stored).toMatch(/^scrypt\$N=131072,r=8,p=1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it("uses parameters at or above the current recommendation", () => {
    expect(OWASP_SCRYPT_PARAMETERS.cost).toBeGreaterThanOrEqual(2 ** 17);
    expect(OWASP_SCRYPT_PARAMETERS.blockSize).toBeGreaterThanOrEqual(8);
    expect(OWASP_SCRYPT_PARAMETERS.parallelism).toBeGreaterThanOrEqual(1);
  });

  it("verifies the password it was made from, at the real cost", async () => {
    const hasher = new ScryptPasswordHasher();
    const stored = await hasher.hash("correct horse battery staple");

    expect(await hasher.verify("correct horse battery staple", stored)).toBe(true);
    expect(await hasher.verify("correct horse battery stapler", stored)).toBe(false);
  });

  it("salts every hash, so two people with one password do not look alike", async () => {
    const hasher = new ScryptPasswordHasher(CHEAP);

    expect(await hasher.hash("shared password")).not.toBe(await hasher.hash("shared password"));
  });

  it("accepts the same characters however they were composed", async () => {
    const hasher = new ScryptPasswordHasher(CHEAP);
    // The same word, precomposed and decomposed. Two keyboards can produce
    // either, and nobody would guess that is why they were locked out.
    const stored = await hasher.hash("café au lait");

    expect(await hasher.verify("café au lait", stored)).toBe(true);
  });

  describe("verify, on a stored string it cannot read", () => {
    const hasher = new ScryptPasswordHasher(CHEAP);
    const unreadable: Readonly<Record<string, string>> = {
      "an empty string": "",
      "a bare word": "nonsense",
      "too few fields": "scrypt$N=16384,r=8,p=1$c2FsdA==",
      "another algorithm": "argon2id$m=65536,t=3,p=4$c2FsdA==$aGFzaA==",
      "unreadable parameters": "scrypt$rounds=many$c2FsdA==$aGFzaA==",
      "a cost that is not a power of two": "scrypt$N=3,r=8,p=1$c2FsdA==$aGFzaA==",
      "a salt that is not base64": "scrypt$N=16384,r=8,p=1$not base64!$aGFzaA==",
    };

    for (const [description, stored] of Object.entries(unreadable)) {
      it(`raises rather than answering no match: ${description}`, async () => {
        // A damaged record and a wrong password are different problems. The
        // caller has to be able to tell them apart; the person signing in must
        // not be able to.
        await expect(hasher.verify("any password", stored)).rejects.toBeInstanceOf(
          MalformedPasswordHashError,
        );
      });
    }
  });

  describe("needsRehash", () => {
    it("says no to its own output", async () => {
      const hasher = new ScryptPasswordHasher(CHEAP);

      expect(hasher.needsRehash(await hasher.hash("a password worth keeping"))).toBe(false);
    });

    it("says yes when the cost has been raised since", async () => {
      const stored = await new ScryptPasswordHasher(CHEAP).hash("a password worth keeping");
      const raised = new ScryptPasswordHasher({ ...CHEAP, cost: CHEAP.cost * 4 });

      expect(raised.needsRehash(stored)).toBe(true);
      // The old hash still verifies: it carries the parameters it was made
      // with, which is what makes raising the cost a decision with no flag day.
      expect(await raised.verify("a password worth keeping", stored)).toBe(true);
    });

    it("says yes when the block size or the key length has changed", async () => {
      const hasher = new ScryptPasswordHasher(CHEAP);
      const stored = await hasher.hash("a password worth keeping");

      expect(new ScryptPasswordHasher({ ...CHEAP, blockSize: 16 }).needsRehash(stored)).toBe(true);
      expect(new ScryptPasswordHasher({ ...CHEAP, keyLength: 64 }).needsRehash(stored)).toBe(true);
    });

    it("says yes to anything it cannot read", () => {
      const hasher = new ScryptPasswordHasher(CHEAP);

      expect(hasher.needsRehash("argon2id$m=65536,t=3,p=4$c2FsdA==$aGFzaA==")).toBe(true);
      expect(hasher.needsRehash("")).toBe(true);
    });
  });
});
