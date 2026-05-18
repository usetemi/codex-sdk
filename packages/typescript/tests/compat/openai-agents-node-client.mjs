import assert from "node:assert/strict";

import { Agent, OpenAIProvider, Runner, setTracingDisabled, tool } from "@openai/agents";
import OpenAI from "openai";
import { z } from "zod";

const baseURL = requiredEnv("OPENAI_COMPAT_BASE_URL");
const apiKey = requiredEnv("OPENAI_COMPAT_API_KEY");
const model = "codex-mini";

const client = new OpenAI({
  apiKey,
  baseURL,
  maxRetries: 0,
});
const modelProvider = new OpenAIProvider({
  openAIClient: client,
  useResponses: true,
  useResponsesWebSocket: false,
});
setTracingDisabled(true);

let toolCalls = 0;
const getWeather = tool({
  name: "get_weather",
  description: "Get the weather for a city.",
  parameters: z.object({
    city: z.string(),
  }),
  execute: async ({ city }) => {
    toolCalls += 1;
    return `The weather in ${city} is sunny.`;
  },
});

const runner = new Runner({ modelProvider });
const toolAgent = new Agent({
  name: "Weather agent",
  instructions: "Use tools when useful.",
  model,
  tools: [getWeather],
});
const toolResult = await runner.run(toolAgent, "What is the weather in Tokyo?");
assert.equal(toolCalls, 1);
assert.equal(toolResult.finalOutput, "Agent saw sunny weather.");
assert.match(toolResult.lastResponseId ?? "", /^resp_/);

const plainAgent = new Agent({
  name: "Plain agent",
  instructions: "Answer directly.",
  model,
});
const plainResult = await runner.run(plainAgent, "Say hello.");
assert.equal(plainResult.finalOutput, "Plain agent response.");
assert.match(plainResult.lastResponseId ?? "", /^resp_/);

console.log(JSON.stringify({ ok: true, client: "openai-agents-node" }));

function requiredEnv(name) {
  const value = process.env[name];
  assert.equal(typeof value, "string", `${name} must be set`);
  assert.notEqual(value, "", `${name} must not be empty`);
  return value;
}
