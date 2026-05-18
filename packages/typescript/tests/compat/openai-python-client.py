from __future__ import annotations

import json
import os

from openai import APIStatusError, OpenAI  # ty: ignore[unresolved-import]


def required_env(name: str) -> str:
    value = os.environ.get(name)
    assert value, f"{name} must be set"
    return value


base_url = required_env("OPENAI_COMPAT_BASE_URL")
api_key = required_env("OPENAI_COMPAT_API_KEY")
model = "codex-mini"
expected_text = "compat response"

client = OpenAI(api_key=api_key, base_url=base_url, max_retries=0)

models = client.models.list()
assert models.data[0].id == model

chat = client.chat.completions.create(
    model=model,
    messages=[{"role": "user", "content": "Say hello."}],
)
assert chat.choices[0].message.content == expected_text
assert chat.usage is not None
assert chat.usage.prompt_tokens == 5
assert chat.usage.completion_tokens == 3

chat_stream_text = ""
saw_chat_usage = False
for chunk in client.chat.completions.create(
    model=model,
    stream=True,
    stream_options={"include_usage": True},
    messages=[{"role": "user", "content": "Stream hello."}],
):
    if chunk.choices and chunk.choices[0].delta.content:
        chat_stream_text += chunk.choices[0].delta.content
    saw_chat_usage = saw_chat_usage or chunk.usage is not None
assert chat_stream_text == expected_text
assert saw_chat_usage

response = client.responses.create(
    model=model,
    input="Say hello.",
)
assert response.output_text == expected_text
assert response.usage is not None
assert response.usage.input_tokens == 5
assert response.usage.output_tokens == 3

response_stream_text = ""
saw_response_completed = False
for event in client.responses.create(
    model=model,
    input="Stream hello.",
    stream=True,
):
    if event.type == "response.output_text.delta":
        response_stream_text += event.delta
    elif event.type == "response.completed":
        saw_response_completed = True
assert response_stream_text == expected_text
assert saw_response_completed

try:
    client.chat.completions.create(
        model=model,
        n=2,
        messages=[{"role": "user", "content": "This should fail."}],
    )
except APIStatusError as exc:
    assert exc.status_code == 501
    body = exc.response.json()
    assert body["error"]["type"] == "unsupported_feature"
    assert body["error"]["param"] == "n"
else:
    raise AssertionError("expected unsupported chat request to raise APIStatusError")

try:
    client.responses.create(
        model=model,
        input="This should fail.",
        previous_response_id="resp_old",
    )
except APIStatusError as exc:
    assert exc.status_code == 404
    body = exc.response.json()
    assert body["error"]["type"] == "invalid_request_error"
    assert body["error"]["param"] == "previous_response_id"
    assert body["error"]["code"] == "not_found"
else:
    raise AssertionError(
        "expected unsupported responses request to raise APIStatusError"
    )

print(json.dumps({"ok": True, "client": "openai-python"}))
