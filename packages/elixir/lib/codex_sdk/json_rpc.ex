defmodule CodexSdk.JsonRpc do
  @moduledoc """
  JSON-RPC message encoding helpers for Codex app-server transports.
  """

  @spec encode(map()) :: iodata()
  def encode(message) when is_map(message) do
    [Jason.encode!(message), "\n"]
  end
end
