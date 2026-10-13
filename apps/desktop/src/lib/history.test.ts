import { describe, expect, it } from "vitest";

import { matchHistory, type BrowserVisit } from "./history";

const visit = (url: string, title = "", visits = 1): BrowserVisit => ({ url, title, favicon: "", visits, last: 0 });

describe("matchHistory", () => {
  const list = [
    visit("https://docs.example.com/guide", "Example guide"),
    visit("https://www.github.com/monorepo-labs/dray", "dray", 3),
    visit("https://news.ycombinator.com/", "Hacker News"),
    visit("http://localhost:5173/", "Vite app", 9),
  ];

  it("ranks an address starting with the text first, ignoring scheme and www", () => {
    expect(matchHistory(list, "git").map((v) => v.url)).toEqual(["https://www.github.com/monorepo-labs/dray"]);
    expect(matchHistory(list, "local")[0].url).toBe("http://localhost:5173/");
  });

  it("matches inside the address and in the title, below a prefix", () => {
    const urls = matchHistory([visit("https://a.test/news"), visit("https://news.test/")], "news").map((v) => v.url);
    expect(urls).toEqual(["https://news.test/", "https://a.test/news"]);
    expect(matchHistory(list, "hacker").map((v) => v.url)).toEqual(["https://news.ycombinator.com/"]);
  });

  it("puts the more visited first within a rank", () => {
    const urls = matchHistory([visit("https://ab.test/", "", 1), visit("https://ac.test/", "", 5)], "a").map((v) => v.url);
    expect(urls).toEqual(["https://ac.test/", "https://ab.test/"]);
  });

  it("answers nothing for blank text and caps the list", () => {
    expect(matchHistory(list, "  ")).toEqual([]);
    expect(matchHistory(list, "e", 2)).toHaveLength(2);
  });
});
