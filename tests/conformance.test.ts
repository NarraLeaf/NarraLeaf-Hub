/**
 * What both halves of the protocol have to agree about.
 *
 * The names on the wire are written down twice - once in `src/team/protocol.ts` here and
 * once in `src/shared/types/team.ts` in Studio - because the two repositories release
 * separately and neither depends on the other. Two copies of anything drift, so the names
 * themselves live in `src/team/contract.json`, of which Studio holds a byte-identical
 * copy, and each side pins its own constants to it.
 *
 * What that catches: a method renamed here without the file moving, a capability added to
 * the document and not to the list, an error code invented in one place.
 *
 * What it does not catch, and it is worth being plain about: the two JSON files are kept
 * identical by whoever edits them. A change made in one repository and not the other
 * passes both suites. What it buys is that the change is a diff on a file whose whole
 * purpose is to be compared, rather than a rename buried in a module.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ANCHOR_FIELD_LIMIT,
  COMMENT_BODY_LIMIT,
  INSTANCE_FIELD_LIMIT,
  LIVE_PAYLOAD_LIMIT,
  OVERLAY_BODY_LIMIT,
  SUGGESTION_LIMIT,
  TEAM_METHODS,
  TEAM_PROTOCOL_VERSION,
  TEAM_SOCKET_PATH,
  TOPIC_MEMBERS,
  TOPIC_PROJECTS,
  liveTopic,
  projectClientsTopic,
  projectLiveTopic,
  projectOverlayTopic,
  projectThreadsTopic,
  projectTopic,
} from "../src/team/protocol.js";
import { capabilitiesOf, methodTable } from "../src/team/methods.js";
import { teamMethods } from "../src/team/endpoint.js";

interface Contract {
  protocol: number;
  socketPath: string;
  capabilities: string[];
  errorCodes: string[];
  methods: string[];
  topics: Record<string, string>;
  limits: Record<string, number>;
}

const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src/team/contract.json", import.meta.url)), "utf-8"),
) as Contract;

describe("the protocol contract", () => {
  it("is the version this build speaks", () => {
    expect(TEAM_PROTOCOL_VERSION).toBe(contract.protocol);
    expect(TEAM_SOCKET_PATH).toBe(contract.socketPath);
  });

  it("serves every method the contract names, and no others", () => {
    // Sorted rather than compared in order: the contract is a set, and a method moved
    // up the list is not a change to what a client can call.
    expect([...methodTable(teamMethods()).keys()].sort()).toEqual([...contract.methods].sort());
    expect(Object.values(TEAM_METHODS).sort()).toEqual([...contract.methods].sort());
  });

  it("announces every capability the contract names", () => {
    expect(capabilitiesOf(methodTable(teamMethods())).sort()).toEqual(
      [...contract.capabilities].sort(),
    );
  });

  it("builds the topics the contract spells out", () => {
    expect(TOPIC_PROJECTS).toBe(contract.topics["projects"]);
    expect(TOPIC_MEMBERS).toBe(contract.topics["members"]);
    expect(projectTopic("abc")).toBe(contract.topics["project"]?.replace("{project}", "abc"));
    expect(projectThreadsTopic("abc")).toBe(
      contract.topics["projectThreads"]?.replace("{project}", "abc"),
    );
    expect(projectOverlayTopic("abc")).toBe(
      contract.topics["projectOverlay"]?.replace("{project}", "abc"),
    );
    expect(projectClientsTopic("abc")).toBe(
      contract.topics["projectClients"]?.replace("{project}", "abc"),
    );
    expect(projectLiveTopic("abc")).toBe(
      contract.topics["projectLive"]?.replace("{project}", "abc"),
    );
    expect(liveTopic("xyz")).toBe(contract.topics["live"]?.replace("{session}", "xyz"));
  });

  it("bounds what it stores at the sizes the contract states", () => {
    expect(ANCHOR_FIELD_LIMIT).toBe(contract.limits["anchorField"]);
    expect(COMMENT_BODY_LIMIT).toBe(contract.limits["commentBody"]);
    expect(SUGGESTION_LIMIT).toBe(contract.limits["suggestion"]);
    expect(OVERLAY_BODY_LIMIT).toBe(contract.limits["overlayBody"]);
    expect(LIVE_PAYLOAD_LIMIT).toBe(contract.limits["livePayload"]);
    expect(INSTANCE_FIELD_LIMIT).toBe(contract.limits["instanceField"]);
  });
});
