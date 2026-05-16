# CodexSdk

Temi convenience SDK and low-level transport helpers for Codex.

## Install

Add `:usetemi_codex_sdk` to `mix.exs`:

```elixir
def deps do
  [
    {:usetemi_codex_sdk, "0.130.0-1"}
  ]
end
```

Package versions track the stable Codex version they target. Version `0.130.0-1` targets Codex `0.130.0`.

## Usage

```elixir
{:ok, server} = CodexSdk.AppServer.start_link()

try do
  {:ok, result} =
    CodexSdk.AppServer.request(server, "initialize", %{
      "clientInfo" => %{
        "name" => "my-client",
        "title" => "My Client",
        "version" => "0.1.0"
      },
      "capabilities" => %{}
    })

  IO.inspect(result)
after
  CodexSdk.AppServer.stop(server)
end
```

The Hex package and OTP app are named `:usetemi_codex_sdk`; public modules remain under `CodexSdk`. App-server events are delivered as `{:usetemi_codex_sdk_app_server_event, server, event}`.
