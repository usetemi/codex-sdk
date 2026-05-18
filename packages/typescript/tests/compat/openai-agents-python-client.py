from __future__ import annotations

import asyncio
import json
import os

from openai import AsyncOpenAI  # ty: ignore[unresolved-import]

from agents import (  # ty: ignore[unresolved-import]
    Agent,
    Runner,
    function_tool,
    set_default_openai_api,
    set_default_openai_client,
    set_tracing_disabled,
)


def required_env(name: str) -> str:
    value = os.environ.get(name)
    assert value, f"{name} must be set"
    return value


base_url = required_env("OPENAI_COMPAT_BASE_URL")
api_key = required_env("OPENAI_COMPAT_API_KEY")
model = "codex-mini"
tool_calls = 0


@function_tool
def get_weather(city: str) -> str:
    """Get the weather for a city."""
    global tool_calls
    tool_calls += 1
    return f"The weather in {city} is sunny."


async def main() -> None:
    client = AsyncOpenAI(api_key=api_key, base_url=base_url, max_retries=0)
    set_default_openai_client(client=client, use_for_tracing=False)
    set_default_openai_api("responses")
    set_tracing_disabled(disabled=True)

    tool_agent = Agent(
        name="Weather agent",
        instructions="Use tools when useful.",
        model=model,
        tools=[get_weather],
    )
    tool_result = await Runner.run(tool_agent, "What is the weather in Tokyo?")
    assert tool_calls == 1
    assert tool_result.final_output == "Agent saw sunny weather."
    assert (tool_result.last_response_id or "").startswith("resp_")

    plain_agent = Agent(
        name="Plain agent",
        instructions="Answer directly.",
        model=model,
    )
    plain_result = await Runner.run(plain_agent, "Say hello.")
    assert plain_result.final_output == "Plain agent response."
    assert (plain_result.last_response_id or "").startswith("resp_")

    print(json.dumps({"ok": True, "client": "openai-agents-python"}))


asyncio.run(main())
