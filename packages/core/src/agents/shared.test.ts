import { afterEach, describe, expect, it } from "vitest";
import { requireEnv } from "./shared.js";

const VAR = "OPENCODE_TEST_ENV_VAR";

describe("requireEnv", () => {
  afterEach(() => {
    delete process.env[VAR];
  });

  it("returns the value when set", () => {
    process.env[VAR] = "secret";
    expect(requireEnv(VAR)).toBe("secret");
  });

  it("throws a clear, variable-naming error when unset, including the hint", () => {
    expect(() => requireEnv(VAR, "Set it to run X.")).toThrowError(
      `Environment variable ${VAR} is not set. Set it to run X.`,
    );
  });

  it("distinguishes set-but-empty from unset", () => {
    process.env[VAR] = "   ";
    expect(() => requireEnv(VAR)).toThrowError(`Environment variable ${VAR} is set but empty.`);
  });
});
