import assert from "node:assert/strict";
import { test } from "node:test";
import { GATEWAY_AGENT_NAME } from "./opencode-configuration.js";
import { selectOpenCodeServerStrategy } from "./opencode-server-strategy.js";

const V1_VERSION = "1.18.16";
const V2_VERSION = "2.0.0";
const V2_BETA_VERSION = "0.0.0-beta-19425";
const CONFIGURED_PASSWORD = "configured-server-password";

test("launches V1 with its restricted agent and pure mode", () => {
  // given
  const strategy = selectOpenCodeServerStrategy(V1_VERSION);

  // when
  const options = strategy.createLaunchOptions(CONFIGURED_PASSWORD);
  const config = JSON.parse(options.environment["OPENCODE_CONFIG_CONTENT"] ?? "{}");

  // then
  assert.ok(options.arguments.includes("--pure"));
  assert.equal(config.agent[GATEWAY_AGENT_NAME].mode, "primary");
  assert.equal(config.agent[GATEWAY_AGENT_NAME].permission["*"], "deny");
  assert.equal(options.environment["OPENCODE_SERVER_PASSWORD"], undefined);
  assert.equal(options.backendPassword, undefined);
});

for (const version of [V2_VERSION, V2_BETA_VERSION]) {
  test(`launches ${version} with matching server and backend passwords`, () => {
    // given
    const strategy = selectOpenCodeServerStrategy(version);

    // when
    const options = strategy.createLaunchOptions(CONFIGURED_PASSWORD);
    const config = JSON.parse(options.environment["OPENCODE_CONFIG_CONTENT"] ?? "{}");

    // then
    assert.equal(options.arguments.includes("--pure"), false);
    assert.equal(options.backendPassword, CONFIGURED_PASSWORD);
    assert.equal(options.environment["OPENCODE_SERVER_PASSWORD"], CONFIGURED_PASSWORD);
    assert.equal(config.agents[GATEWAY_AGENT_NAME].mode, "primary");
    assert.deepEqual(config.agents[GATEWAY_AGENT_NAME].permissions, [{ action: "*", resource: "*", effect: "deny" }]);
  });
}

test("generates a distinct V2 password per private process when none is configured", () => {
  // given
  const strategy = selectOpenCodeServerStrategy(V2_VERSION);

  // when
  const firstLaunch = strategy.createLaunchOptions(undefined);
  const secondLaunch = strategy.createLaunchOptions(undefined);

  // then
  assert.ok(firstLaunch.backendPassword);
  assert.notEqual(firstLaunch.backendPassword, secondLaunch.backendPassword);
  assert.equal(firstLaunch.environment["OPENCODE_SERVER_PASSWORD"], firstLaunch.backendPassword);
  assert.equal(secondLaunch.environment["OPENCODE_SERVER_PASSWORD"], secondLaunch.backendPassword);
});

test("rejects unsupported versions before creating private-server options", () => {
  // given
  const versions = ["1.18.3", "3.0.0", "invalid"];

  // when
  const select = (version: string) => selectOpenCodeServerStrategy(version);

  // then
  for (const version of versions) assert.throws(() => select(version), /required/);
});
