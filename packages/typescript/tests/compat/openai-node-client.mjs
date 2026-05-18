import assert from "node:assert/strict";

import OpenAI from "openai";

const baseURL = requiredEnv("OPENAI_COMPAT_BASE_URL");
const apiKey = requiredEnv("OPENAI_COMPAT_API_KEY");
const model = "codex-mini";
const expectedText = "compat response";

const client = new OpenAI({
  apiKey,
  baseURL,
  maxRetries: 0,
});

const models = await client.models.list();
assert.equal(models.data[0]?.id, model);

const chat = await client.chat.completions.create({
  model,
  messages: [{ role: "user", content: "Say hello." }],
});
assert.equal(chat.choices[0]?.message?.content, expectedText);
assert.equal(chat.usage?.prompt_tokens, 5);
assert.equal(chat.usage?.completion_tokens, 3);

let chatStreamText = "";
let sawChatUsage = false;
const chatStream = await client.chat.completions.create({
  model,
  stream: true,
  stream_options: { include_usage: true },
  messages: [{ role: "user", content: "Stream hello." }],
});
for await (const chunk of chatStream) {
  chatStreamText += chunk.choices[0]?.delta?.content ?? "";
  sawChatUsage ||= Boolean(chunk.usage);
}
assert.equal(chatStreamText, expectedText);
assert.equal(sawChatUsage, true);

const response = await client.responses.create({
  model,
  input: "Say hello.",
});
assert.equal(response.output_text, expectedText);
assert.equal(response.usage?.input_tokens, 5);
assert.equal(response.usage?.output_tokens, 3);

let responseStreamText = "";
let sawResponseCompleted = false;
const responseStream = await client.responses.create({
  model,
  input: "Stream hello.",
  stream: true,
});
for await (const event of responseStream) {
  if (event.type === "response.output_text.delta") {
    responseStreamText += event.delta;
  } else if (event.type === "response.completed") {
    sawResponseCompleted = true;
  }
}
assert.equal(responseStreamText, expectedText);
assert.equal(sawResponseCompleted, true);

await assert.rejects(
  () =>
    client.chat.completions.create({
      model,
      n: 2,
      messages: [{ role: "user", content: "This should fail." }],
    }),
  (error) => {
    assert.equal(error.status, 501);
    assert.equal(error.error?.type, "unsupported_feature");
    assert.equal(error.error?.param, "n");
    return true;
  },
);

await assert.rejects(
  () =>
    client.responses.create({
      model,
      input: "This should fail.",
      previous_response_id: "resp_old",
    }),
  (error) => {
    assert.equal(error.status, 404);
    assert.equal(error.error?.type, "invalid_request_error");
    assert.equal(error.error?.param, "previous_response_id");
    assert.equal(error.error?.code, "not_found");
    return true;
  },
);

console.log(JSON.stringify({ ok: true, client: "openai-node" }));

function requiredEnv(name) {
  const value = process.env[name];
  assert.equal(typeof value, "string", `${name} must be set`);
  assert.notEqual(value, "", `${name} must not be empty`);
  return value;
}
