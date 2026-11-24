import { describe, expect, it } from "vitest";

import { issuePrompt, issueRepo, projectForIssue } from "@/lib/issueStart";
import type { Project } from "@/types/events";

const gh = { tracker: "github" as const, identifier: "Acme/App#12" };
const project = (path: string, remote?: string, lastSelected = ""): Project => ({
  path,
  name: path.split("/").pop() ?? path,
  space: null,
  remote,
  lastSelected,
});

describe("issueRepo", () => {
  it("reads owner/repo off a GitHub identifier", () => {
    expect(issueRepo(gh)).toBe("Acme/App");
  });
  it("answers none for Linear", () => {
    expect(issueRepo({ tracker: "linear", identifier: "DRA-53" })).toBeNull();
  });
});

describe("projectForIssue", () => {
  it("matches the remote, case aside", () => {
    const hit = project("/code/app", "github.com/acme/app");
    expect(projectForIssue([project("/code/web", "github.com/acme/web"), hit], gh)).toBe(hit);
  });
  it("prefers This Mac over another machine", () => {
    const far = project("dray://box/home/app", "github.com/acme/app", "2");
    const here = project("/code/app", "github.com/acme/app", "1");
    expect(projectForIssue([far, here], gh)).toBe(here);
  });
  it("then the project last picked", () => {
    const old = project("/code/app", "github.com/acme/app", "2026-01-01");
    const recent = project("/code/app2", "github.com/acme/app", "2026-06-01");
    expect(projectForIssue([old, recent], gh)).toBe(recent);
  });
  it("finds nothing for an unattached repo or a Linear issue", () => {
    const list = [project("/code/web", "github.com/acme/web"), project("/code/none")];
    expect(projectForIssue(list, gh)).toBeUndefined();
    expect(projectForIssue(list, { tracker: "linear", identifier: "DRA-1" })).toBeUndefined();
  });
});

describe("issuePrompt", () => {
  const issue = { identifier: "acme/app#12", title: "Fix login", url: "https://github.com/acme/app/issues/12" };
  it("puts tag, link and body in order", () => {
    expect(issuePrompt(issue, "  Steps\n1. log in  ")).toBe(
      "#acme/app#12 Fix login\nhttps://github.com/acme/app/issues/12\n\nSteps\n1. log in",
    );
  });
  it("drops an empty body", () => {
    expect(issuePrompt(issue, "   ")).toBe("#acme/app#12 Fix login\nhttps://github.com/acme/app/issues/12");
    expect(issuePrompt(issue, null)).toBe("#acme/app#12 Fix login\nhttps://github.com/acme/app/issues/12");
  });
  it("puts the reader's note last", () => {
    expect(issuePrompt(issue, "Body", " Keep it small ")).toBe(
      "#acme/app#12 Fix login\nhttps://github.com/acme/app/issues/12\n\nBody\n\nKeep it small",
    );
    expect(issuePrompt(issue, null, "Note")).toBe("#acme/app#12 Fix login\nhttps://github.com/acme/app/issues/12\n\nNote");
  });
});
