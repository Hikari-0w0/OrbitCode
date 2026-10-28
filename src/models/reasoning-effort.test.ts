import assert from "node:assert/strict";
import test from "node:test";
import { OpenAICompatibleProvider } from "./openai-provider";
import { DONE_EVENT, startOpenAIMockServer, textDelta } from "../../tests/helpers/openai-mock";

test("GLM-5.3 默认 high，显式推理深度透传，其他模型不注入默认值", async () => {
  const server = await startOpenAIMockServer(() => ({ chunks: [{ data: textDelta("OK") + DONE_EVENT }] }));
  try {
    for (const options of [
      { model: "GLM-5.3" },
      { model: "glm-5.3-flash" },
      { model: "glm-5.3", reasoningEffort: "low" as const },
      { model: "glm-5.3", reasoningEffort: "max" as const },
      { model: "other-model" },
    ]) {
      const provider = new OpenAICompatibleProvider({ ...options, baseUrl: server.baseUrl, apiKey: "synthetic-only" });
      for await (const event of provider.stream([{ role: "user", content: "OK" }], { signal: AbortSignal.timeout(3000), toolChoice: "none" })) void event;
    }
    assert.deepEqual(server.requests.map(request => {
      assert.ok(typeof request.body === "object" && request.body !== null && "model" in request.body);
      return "reasoning_effort" in request.body ? request.body.reasoning_effort : undefined;
    }), ["high", "high", "low", "max", undefined]);
  } finally { await server.close(); }
});
