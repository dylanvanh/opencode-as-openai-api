import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "../src/cli.js";

test("parses the public CLI options", () => {
  assert.deepEqual(parseArgs(["--model", "provider/model", "--port", "0", "--max-concurrency", "2", "--tunnel", "quick"]), {
    model: "provider/model", port: 0, maxConcurrency: 2, tunnel: "quick",
  });
  assert.throws(() => parseArgs([]), /--model is required/);
  assert.throws(() => parseArgs(["--model", "invalid"]), /provider\/model/);
});
