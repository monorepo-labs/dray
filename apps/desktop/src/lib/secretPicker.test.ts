import { describe, expect, it } from "vitest";

import { matchSecrets } from "./secretPicker";

const NAMES = ["GITHUB_TOKEN", "NPM_TOKEN", "OPENAI_API_KEY", "GH_TOKEN"];

describe("matchSecrets", () => {
  it("keeps everything for an empty search", () => {
    expect(matchSecrets(NAMES, "  ")).toEqual(NAMES);
  });

  it("matches part of a name, case aside", () => {
    expect(matchSecrets(NAMES, "npm")).toEqual(["NPM_TOKEN"]);
    expect(matchSecrets(NAMES, "Api")).toEqual(["OPENAI_API_KEY"]);
  });

  it("reads _ and spaces alike and wants every word", () => {
    expect(matchSecrets(NAMES, "github token")).toEqual(["GITHUB_TOKEN"]);
    expect(matchSecrets(NAMES, "gh_tok")).toEqual(["GH_TOKEN"]);
    expect(matchSecrets(NAMES, "token")).toEqual(["GITHUB_TOKEN", "NPM_TOKEN", "GH_TOKEN"]);
  });

  it("answers nothing when nothing matches", () => {
    expect(matchSecrets(NAMES, "stripe")).toEqual([]);
  });
});
