defmodule CodexSdk.MessageRouter do
  @moduledoc """
  Routes decoded JSON-RPC messages into expected responses, orphan responses, and notifications.
  """

  defstruct expected_response_ids: MapSet.new(), notifications: []

  @type id :: String.t() | number()
  @type routed ::
          {:response, id(), map()}
          | {:error_response, id(), map()}
          | {:server_request, id(), map()}
          | {:orphan_response, id(), map()}
          | {:notification, map()}
          | {:unknown, map()}
  @type t :: %__MODULE__{
          expected_response_ids: MapSet.t(id()),
          notifications: [map()]
        }

  @spec new() :: t()
  def new do
    %__MODULE__{}
  end

  @spec expect_response(t(), id()) :: t()
  def expect_response(%__MODULE__{} = router, id) when is_binary(id) or is_number(id) do
    %{router | expected_response_ids: MapSet.put(router.expected_response_ids, id)}
  end

  @spec route(t(), map()) :: {t(), routed()}
  def route(%__MODULE__{} = router, %{"id" => id, "method" => method} = message)
      when (is_binary(id) or is_number(id)) and is_binary(method) do
    {router, {:server_request, id, message}}
  end

  def route(%__MODULE__{} = router, %{"id" => id} = message)
      when is_binary(id) or is_number(id) do
    if MapSet.member?(router.expected_response_ids, id) do
      routed =
        if is_map(message["error"]) do
          {:error_response, id, message}
        else
          {:response, id, message}
        end

      {
        %{router | expected_response_ids: MapSet.delete(router.expected_response_ids, id)},
        routed
      }
    else
      {router, {:orphan_response, id, message}}
    end
  end

  def route(%__MODULE__{} = router, %{"method" => method} = message) when is_binary(method) do
    router = %{router | notifications: [message | router.notifications]}
    {router, {:notification, message}}
  end

  def route(%__MODULE__{} = router, message) when is_map(message) do
    {router, {:unknown, message}}
  end
end
