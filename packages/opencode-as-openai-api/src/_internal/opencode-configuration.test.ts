import assert from "node:assert/strict";
import { test } from "node:test";
import { validateOpenCodeVersion, validateOpenCodeV2Version } from "./opencode-configuration.js";

for (const version of ["1.18.4", "1.18.16", "1.19.0"]) {
  test(`accepts supported OpenCode version ${version}`, () => {
    // given
    const upstreamVersion = version;

    // when
    const validated = validateOpenCodeVersion(upstreamVersion);

    // then
    assert.equal(validated, upstreamVersion);
  });
}

for (const version of [undefined, "", "1.18.3", "1.17.99", "2.0.0", "1.18", "1.18.4-beta", "1.99999999999999999999.0"]) {
  test(`rejects unsupported OpenCode version ${String(version)}`, () => {
    // given
    const upstreamVersion = version;

    // when
    const validate = (): unknown => validateOpenCodeVersion(upstreamVersion);

    // then
    assert.throws(validate, /OpenCode 1.18.4 or newer in the 1.x series is required/);
  });
}

test("accepts V2 releases and the installed V2 beta version format", () => {
  // given
  const versions = ["2.0.0", "2.1.3", "2.0.0-beta.1", "0.0.0-beta-19425"];

  // when
  const validated = versions.map(validateOpenCodeV2Version);

  // then
  assert.deepEqual(validated, versions);
});

test("rejects unsupported or missing V2 versions", () => {
  // given
  const versions = [undefined, "", "1.18.16", "3.0.0", "0.0.0", "2.0", "2.01.0", "2.0.0\n"];

  // when
  const validate = (version: unknown): string => validateOpenCodeV2Version(version);

  // then
  for (const version of versions) assert.throws(() => validate(version), /supported OpenCode 2.x/);
});
