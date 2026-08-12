import { describe, expect, it } from "vitest";

import {
  audienceHosts,
  authUrl,
  dataRemoteUrl,
  hostOf,
  identityConfig,
  tokenAudience,
} from "../src/identity/config.js";

/**
 * What a token's audience has to say about one host, and why each entry is
 * there.
 *
 * These are not four spellings of the same thing kept for symmetry. The client
 * turns the audience into its own `acceptable_root_domains` and refuses to send
 * the token to any remote not named in it — it treats that as leaking the token
 * to a third party — and the comparison is against strings the client assembled
 * itself, from settings written by a person. An audience observed working end
 * to end carried all four, and there is no version of the client here to read,
 * so none of them is known to be redundant.
 *
 * If this list is ever shortened, the thing that proves it is a real client
 * completing a clone, a commit and a push — not this file passing.
 */
function spellingsOf(host: string, dataPort: number): Record<string, string> {
  return {
    "the bare host, as a remote written with no port at all": host,
    "the host and the data port, as an address with no scheme": `${host}:${dataPort}`,
    "the data remote as a URL": `lore://${host}:${dataPort}`,
    "the same URL with the trailing slash a normaliser may add": `lore://${host}:${dataPort}/`,
  };
}

describe("the audience of a minted token", () => {
  it("names loreserver, so loreserver will look at the token at all", () => {
    const config = identityConfig({ audience: "loreserver" });

    expect(tokenAudience(config)).toContain("loreserver");
  });

  it("names the auth endpoint, so a client will sign in", () => {
    const config = identityConfig({ authOrigin: "hub.example.com:41402" });
    const auth = authUrl(config);

    // Both spellings: the client's own message about a mismatch has been seen
    // carrying the trailing slash.
    expect(tokenAudience(config)).toContain(auth);
    expect(tokenAudience(config)).toContain(`${auth}/`);
  });

  it("names the data remote, which is where the work actually happens", () => {
    const config = identityConfig({ authOrigin: "hub.example.com:41402", dataPort: 41337 });
    const audience = tokenAudience(config);

    // Without these the client signs in, stores the token, and then fails every
    // repository operation with "Failed to resolve repository: No token
    // stored" — which reads like a missing token rather than a token the client
    // has decided it may not use here.
    for (const [reason, entry] of Object.entries(spellingsOf("hub.example.com", 41337))) {
      expect(audience, `the audience is missing ${reason}`).toContain(entry);
    }
  });

  it("names the data remote for every host the operator supplied", () => {
    const config = identityConfig({
      authOrigin: "hub.example.com:41402",
      hostnames: ["hub.example.com", "hub.internal", "10.0.0.7"],
      dataPort: 41337,
    });
    const audience = tokenAudience(config);

    // A collaborator does not connect on 127.0.0.1. A token whose audience
    // names only the host the Hub was configured with works on the Hub machine
    // and nowhere else, which passes every check that can be made locally.
    for (const host of ["hub.example.com", "hub.internal", "10.0.0.7"]) {
      for (const [reason, entry] of Object.entries(spellingsOf(host, 41337))) {
        expect(audience, `the audience is missing ${reason}, for ${host}`).toContain(entry);
      }
    }
  });

  it("follows the data port it was configured with", () => {
    const config = identityConfig({ authOrigin: "hub.example.com:41402", dataPort: 42_000 });

    expect(tokenAudience(config)).toContain("lore://hub.example.com:42000");
    expect(tokenAudience(config)).not.toContain("lore://hub.example.com:41337");
  });

  it("covers the loopback when the operator named no host at all", () => {
    // The ordinary first run: one machine, nothing configured, and a client on
    // that machine has to work.
    const audience = tokenAudience(identityConfig());

    expect(audience).toContain("lore://127.0.0.1:41337");
    expect(audience).toContain("https://127.0.0.1:41402");
  });

  it("repeats nothing, because a repeated audience says nothing extra", () => {
    const config = identityConfig({
      authOrigin: "hub.example.com:41402",
      // The auth origin's own host named again, which an operator will do.
      hostnames: ["hub.example.com", "hub.example.com"],
    });
    const audience = tokenAudience(config);

    expect(audience.length).toBe(new Set(audience).size);
  });

  it("brackets an IPv6 host in the forms that are URLs, and not in the one that is not", () => {
    const config = identityConfig({ authOrigin: "[::1]:41402", dataPort: 41337 });
    const audience = tokenAudience(config);

    expect(audience).toContain("lore://[::1]:41337");
    expect(audience).toContain("[::1]:41337");
    expect(audience).toContain("[::1]");
  });
});

describe("the hosts an audience is written for", () => {
  it("is the auth origin's host, plus everything --hostname named", () => {
    expect(
      audienceHosts(
        identityConfig({ authOrigin: "hub.example.com:41402", hostnames: ["hub.internal"] }),
      ),
    ).toEqual(["hub.example.com", "hub.internal"]);
  });

  it("takes the host out of an origin however the origin is written", () => {
    expect(hostOf("hub.example.com:41402")).toBe("hub.example.com");
    expect(hostOf("hub.example.com")).toBe("hub.example.com");
    expect(hostOf("127.0.0.1:41402")).toBe("127.0.0.1");
    // The brackets are what tell an address's colons from the port's.
    expect(hostOf("[::1]:41402")).toBe("[::1]");
    expect(hostOf("[2001:db8::2]")).toBe("[2001:db8::2]");
  });

  it("writes the data remote as a client does", () => {
    expect(dataRemoteUrl("hub.example.com", 41337)).toBe("lore://hub.example.com:41337");
    expect(dataRemoteUrl("::1", 41337)).toBe("lore://[::1]:41337");
    expect(dataRemoteUrl("[::1]", 41337)).toBe("lore://[::1]:41337");
  });
});

describe("both ways a token is issued", () => {
  it("build their audience from the same function", async () => {
    // Not a behavioural check — a structural one. Two lists that had to agree
    // would be two lists that eventually did not, so the exchange method and
    // `token mint` reach the same place. tests/exchange.test.ts checks what the
    // exchange actually returns; this checks that nothing has grown a second
    // copy of the list in the meantime.
    const { readFile } = await import("node:fs/promises");
    const sources = await Promise.all([
      readFile(new URL("../src/identity/tokens.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/projects/service.ts", import.meta.url), "utf8"),
    ]);

    // The one place `aud` is assembled is mintToken, which every issuing path
    // goes through.
    expect(sources[0]).toContain("aud: tokenAudience(config)");
    expect(sources[1]).toContain("mintToken(");
    expect(sources[1]).not.toContain("aud:");
  });
});
