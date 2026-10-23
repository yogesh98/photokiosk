import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("real Git pulls deploy after fast-forward/rebase, but not no-op, amend, or conflict", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "photokiosk-hooks-"));
  try {
    const origin = path.join(temporary, "origin");
    const checkout = path.join(temporary, "checkout");
    const log = path.join(temporary, "deployments");
    const env = {
      ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Hook test", GIT_AUTHOR_EMAIL: "hook@example.invalid",
      GIT_COMMITTER_NAME: "Hook test", GIT_COMMITTER_EMAIL: "hook@example.invalid",
      GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", PHOTO_KIOSK_HOOK_TEST_LOG: log,
    };
    function git(cwd, args, allowFailure = false) {
      const result = spawnSync("git", args, { cwd, env, encoding: "utf8" });
      if (!allowFailure) assert.equal(result.status, 0, result.stderr || result.stdout);
      return result;
    }
    async function commit(cwd, name, contents) {
      await writeFile(path.join(cwd, name), contents);
      git(cwd, ["add", name]);
      git(cwd, ["commit", "-m", name]);
    }
    async function count() {
      try { return (await readFile(log, "utf8")).trim().split("\n").length; }
      catch (error) { if (error.code === "ENOENT") return 0; throw error; }
    }
    await mkdir(origin);
    git(origin, ["init", "-b", "main"]);
    await commit(origin, "shared.txt", "base\n");
    git(temporary, ["clone", origin, checkout]);
    await cp(path.join(root, ".githooks"), path.join(checkout, ".githooks"), { recursive: true });
    await mkdir(path.join(checkout, "scripts"));
    await cp(path.join(root, "scripts/post-pull.sh"), path.join(checkout, "scripts/post-pull.sh"));
    await mkdir(path.join(checkout, ".deploy"));
    const fakeNode = path.join(temporary, "node");
    await writeFile(fakeNode, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PHOTO_KIOSK_HOOK_TEST_LOG"\n');
    await chmod(fakeNode, 0o755);
    await writeFile(path.join(checkout, ".deploy/node"), `${fakeNode}\n`);
    git(checkout, ["config", "core.hooksPath", ".githooks"]);

    await commit(origin, "remote.txt", "fast-forward\n");
    git(checkout, ["pull", "--ff-only"]);
    assert.equal(await count(), 1, "fast-forward pull must deploy");
    git(checkout, ["pull", "--ff-only"]);
    assert.equal(await count(), 1, "up-to-date pull must skip deployment");

    await commit(checkout, "local.txt", "local commit\n");
    await commit(origin, "remote.txt", "rebase\n");
    git(checkout, ["pull", "--rebase"]);
    assert.equal(await count(), 2, "rebased pull must deploy once");
    git(checkout, ["commit", "--amend", "--no-edit"]);
    assert.equal(await count(), 2, "amending a commit must skip deployment");

    await commit(checkout, "shared.txt", "local conflict\n");
    await commit(origin, "shared.txt", "remote conflict\n");
    assert.notEqual(git(checkout, ["pull", "--no-rebase", "--no-edit"], true).status, 0);
    assert.equal(await count(), 2, "conflicted pull must skip deployment");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
