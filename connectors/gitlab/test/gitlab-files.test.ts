import { describe, expect, it } from "bun:test";
import { assertRegularTargets, type GitlabGet, readGitlabFilesAt } from "../src/gitlab-files.ts";

const SHA = "a".repeat(40);

function reply(json: unknown, status = 200): ReturnType<GitlabGet> {
  return Promise.resolve({ ok: status < 400, status, json, text: JSON.stringify(json) });
}

describe("assertRegularTargets", () => {
  it("skips tree entries without a string path and type, so a target they stand for is unverified", async () => {
    const get: GitlabGet = () =>
      reply([{ path: 7, type: "blob" }, { path: "a.txt" }, null, "a.txt"]);
    await expect(
      assertRegularTargets(get, "1", SHA, [{ path: "a.txt", exists: true }]),
    ).rejects.toThrow("a.txt");
  });

  it("reads an entry with no mode as a plain blob", async () => {
    const get: GitlabGet = () => reply([{ path: "a.txt", type: "blob" }]);
    await expect(
      assertRegularTargets(get, "1", SHA, [{ path: "a.txt", exists: true }]),
    ).resolves.toBeUndefined();
  });

  it("refuses a directory with more pages than it will read", async () => {
    const calls: string[] = [];
    const full = Array.from({ length: 100 }, (_, i) => ({
      path: `d/f${String(i)}`,
      type: "blob",
      mode: "100644",
    }));
    const get: GitlabGet = (path) => {
      calls.push(path);
      return reply(full);
    };
    await expect(
      assertRegularTargets(get, "1", SHA, [{ path: "d/new.txt", exists: false }]),
    ).rejects.toThrow('GitLab directory "d" has too many entries to check');
    expect(calls).toHaveLength(50);
    expect(calls[0]).toContain("path=d");
    expect(calls[0]).toContain("page=1");
  });
});

describe("readGitlabFilesAt", () => {
  it("refuses a 200 reply without a last_commit_id and a content", async () => {
    const get: GitlabGet = () => reply({ last_commit_id: SHA });
    await expect(readGitlabFilesAt(get, "1", SHA, ["a.txt"], 1024)).rejects.toThrow(
      "GitLab returned an unreadable file for a.txt",
    );
  });

  it("refuses a reply that is not an object the same way", async () => {
    const get: GitlabGet = () => reply(["not", "a", "file"]);
    await expect(readGitlabFilesAt(get, "1", SHA, ["a.txt"], 1024)).rejects.toThrow(TypeError);
  });
});
