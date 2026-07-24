import { describe, expect, it } from "vitest";
import { codexRunner } from "./runner.js";
import type { AgentSandbox } from "../types.js";
import type { CommandResult } from "../../index.js";

const ok: CommandResult = { ok: true, exitCode: 0, stdout: "", stderr: "" };

/** Records every exec call (command + env) and every file written. */
function recordingSandbox() {
  const calls: Array<{ command: string; env?: Record<string, string> }> = [];
  const sandbox: AgentSandbox = {
    workspace: "/w",
    exec: async (command, options) => {
      calls.push({ command, env: options?.env });
      return ok;
    },
    readFile: async () => "",
  };
  return { sandbox, calls };
}

describe("codexRunner gateway mode", () => {
  it("skips `codex login` on install (env_key auth handles it)", async () => {
    const { sandbox, calls } = recordingSandbox();
    await codexRunner.install(sandbox, "0.138.0", "gw-key", true);
    expect(calls.some((c) => c.command.includes("login"))).toBe(false);
  });

  it("still logs in with the OpenAI key on direct install", async () => {
    const { sandbox, calls } = recordingSandbox();
    await codexRunner.install(sandbox, "0.138.0", "sk-openai", false);
    const login = calls.find((c) => c.command.includes("login --with-api-key"));
    expect(login?.env).toEqual({ OPENAI_API_KEY: "sk-openai" });
  });

  it("writes the Vercel provider config and passes the gateway key", async () => {
    const { sandbox, calls } = recordingSandbox();
    await codexRunner.exec({
      sandbox,
      model: "openai/gpt-5.4-mini",
      apiKey: "gw-key",
      gateway: true,
      systemPromptPath: "/s",
      userPromptPath: "/u",
      mcpServers: {},
      timeoutSec: 1,
    });

    // Config is staged base64-encoded (writeSandboxFile) into ~/.codex/config.toml.
    const configWrite = calls.find((c) => c.command.includes("config.toml"));
    const encoded = /printf %s '([^']+)'/.exec(configWrite?.command ?? "")?.[1];
    const toml = Buffer.from(encoded ?? "", "base64").toString("utf8");
    expect(toml).toContain('model_provider = "vercel"');
    expect(toml).toContain('base_url = "https://ai-gateway.vercel.sh/v1"');
    expect(toml).toContain('env_key = "AI_GATEWAY_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');

    const run = calls.find((c) => c.command.includes(" exec "));
    expect(run?.env).toEqual({ AI_GATEWAY_API_KEY: "gw-key" });
  });

  it("writes no config and keeps the OpenAI env when direct", async () => {
    const { sandbox, calls } = recordingSandbox();
    await codexRunner.exec({
      sandbox,
      model: "gpt-5.4-mini",
      apiKey: "sk-openai",
      gateway: false,
      systemPromptPath: "/s",
      userPromptPath: "/u",
      mcpServers: {},
      timeoutSec: 1,
    });
    expect(calls.some((c) => c.command.includes("config.toml"))).toBe(false);
    const run = calls.find((c) => c.command.includes(" exec "));
    expect(run?.env).toEqual({ OPENAI_API_KEY: "sk-openai" });
  });
});
