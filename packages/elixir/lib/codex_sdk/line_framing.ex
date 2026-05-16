defmodule CodexSdk.LineFraming do
  @moduledoc """
  Incremental newline-delimited JSON decoder for Codex app-server transports.
  """

  defstruct pending: ""

  @type event :: {:message, map()} | {:malformed, String.t()}
  @type t :: %__MODULE__{pending: String.t()}

  @spec new() :: t()
  def new do
    %__MODULE__{}
  end

  @spec feed(t(), binary()) :: {t(), [event()]}
  def feed(%__MODULE__{pending: pending}, chunk) when is_binary(chunk) do
    combined = pending <> chunk
    parts = String.split(combined, "\n", trim: false)
    {pending, complete_lines} = List.pop_at(parts, -1)

    events =
      complete_lines
      |> Enum.map(&String.trim_trailing(&1, "\r"))
      |> Enum.reject(&(&1 == ""))
      |> Enum.map(&decode_line/1)

    {%__MODULE__{pending: pending || ""}, events}
  end

  defp decode_line(line) do
    case Jason.decode(line) do
      {:ok, message} when is_map(message) -> {:message, message}
      {:ok, _other} -> {:malformed, line}
      {:error, _reason} -> {:malformed, line}
    end
  end
end
