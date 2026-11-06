import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAudit } from "@depthcue/cli/audit-file";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDepthcueServer } from "../src/server.ts";

const QUIET = 20;
const until = async (test: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
};

describe("the channel to the client", () => {
  let dir: string;
  let depthcue: ReturnType<typeof createDepthcueServer>;
  let client: Client;
  const events: { method: string; params: any }[] = [];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "dc-channel-"));
    events.length = 0;
    depthcue = createDepthcueServer(dir);
    client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    client.fallbackNotificationHandler = async (n) => {
      events.push({ method: n.method, params: n.params });
    };
    const [a, b] = InMemoryTransport.createLinkedPair();
    await depthcue.server.connect(a);
    await client.connect(b);
  });

  afterEach(async () => {
    await client.close();
    await depthcue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is declared to the client, with a word on how to read what comes", () => {
    expect(client.getServerCapabilities()?.experimental).toHaveProperty("claude/channel");
    expect(client.getInstructions()).toContain('<channel source="depthcue">');
  });

  it("tells the client what the person did, once, and not what the agent did", async () => {
    depthcue.startChannel(QUIET);
    appendAudit(dir, [{ by: "agent", kind: "edit", summary: "Shortened the title.", scene: "opening" }]);
    appendAudit(dir, [
      { by: "you", kind: "comment", summary: "Commented on an area of the chart.", scene: "method" },
      { by: "you", kind: "edit", summary: "Changed the lead.", scene: "opening" },
    ]);
    await until(() => events.length > 0);
    await new Promise((r) => setTimeout(r, 150));
    expect(events).toHaveLength(1);
    expect(events[0]?.method).toBe("notifications/claude/channel");
    expect(events[0]?.params.content).toBe(
      "[method] Commented on an area of the chart.\n[opening] Changed the lead.",
    );
    expect(events[0]?.params.meta).toMatchObject({ count: "2", scenes: "method,opening" });
  });

  it("says nothing about entries that were there before it started, or when only the agent wrote", async () => {
    appendAudit(dir, [{ by: "you", kind: "edit", summary: "Old change.", scene: "opening" }]);
    depthcue.startChannel(QUIET);
    appendAudit(dir, [{ by: "agent", kind: "reply", summary: "Replied.", scene: "opening" }]);
    await new Promise((r) => setTimeout(r, 300));
    expect(events).toEqual([]);
  });
});
