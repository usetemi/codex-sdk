defmodule CodexSdk.AppServer do
  @moduledoc """
  Low-level stdio client for a local Codex app-server subprocess.
  """

  use GenServer

  defmodule JsonRpcError do
    @moduledoc "JSON-RPC error response."
    defexception [:code, :data, message: "JSON-RPC error"]
  end

  defmodule ClosedError do
    @moduledoc "Raised when the app-server process exits while requests are pending."
    defexception [:code, message: "app-server closed"]
  end

  defstruct port: nil,
            owner: nil,
            decoder: CodexSdk.LineFraming.new(),
            router: CodexSdk.MessageRouter.new(),
            pending: %{},
            counter: 0,
            closed?: false,
            exit_code: nil

  @type event ::
          {:notification, map()}
          | {:server_request, String.t() | number(), map()}
          | {:malformed, String.t()}
          | {:unknown, map()}
          | {:exit, integer()}

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    opts = Keyword.put_new(opts, :owner, self())
    GenServer.start_link(__MODULE__, opts)
  end

  @spec request(GenServer.server(), String.t(), term(), timeout()) ::
          {:ok, term()} | {:error, JsonRpcError.t() | ClosedError.t()}
  def request(server, method, params \\ nil, timeout \\ 5_000) do
    GenServer.call(server, {:request, method, params}, timeout)
  end

  @spec notify(GenServer.server(), String.t(), term()) :: :ok | {:error, ClosedError.t()}
  def notify(server, method, params \\ nil) do
    GenServer.call(server, {:notify, method, params})
  end

  @spec respond(GenServer.server(), String.t() | number(), term()) ::
          :ok | {:error, ClosedError.t()}
  def respond(server, id, result) do
    GenServer.call(server, {:respond, id, result})
  end

  @spec respond_error(GenServer.server(), String.t() | number(), map()) ::
          :ok | {:error, ClosedError.t()}
  def respond_error(server, id, error) do
    GenServer.call(server, {:respond_error, id, error})
  end

  @spec stop(GenServer.server()) :: :ok
  def stop(server) do
    GenServer.call(server, :stop)
  catch
    :exit, _reason -> :ok
  end

  @impl true
  def init(opts) do
    command = Keyword.get(opts, :command, "codex")
    args = Keyword.get(opts, :args, ["app-server", "--listen", "stdio://"])
    owner = Keyword.fetch!(opts, :owner)

    executable = System.find_executable(command) || command

    port_opts =
      [:binary, :exit_status, args: args]
      |> maybe_put_cd(Keyword.get(opts, :cwd))

    port = Port.open({:spawn_executable, executable}, port_opts)

    {:ok, %__MODULE__{port: port, owner: owner}}
  end

  @impl true
  def handle_call({:request, _method, _params}, _from, %__MODULE__{closed?: true} = state) do
    {:reply, {:error, closed_error(state.exit_code)}, state}
  end

  def handle_call({:request, method, params}, from, %__MODULE__{} = state) do
    id = "req-#{state.counter + 1}"

    message =
      %{"id" => id, "method" => method}
      |> maybe_put_params(params)

    case send_message(state, message) do
      :ok ->
        state = %{
          state
          | counter: state.counter + 1,
            router: CodexSdk.MessageRouter.expect_response(state.router, id),
            pending: Map.put(state.pending, id, from)
        }

        {:noreply, state}

      {:error, error} ->
        {:reply, {:error, error}, state}
    end
  end

  def handle_call({:notify, method, params}, _from, %__MODULE__{} = state) do
    message =
      %{"method" => method}
      |> maybe_put_params(params)

    {:reply, send_message(state, message), state}
  end

  def handle_call({:respond, id, result}, _from, %__MODULE__{} = state) do
    {:reply, send_message(state, %{"id" => id, "result" => result}), state}
  end

  def handle_call({:respond_error, id, error}, _from, %__MODULE__{} = state) do
    {:reply, send_message(state, %{"id" => id, "error" => error}), state}
  end

  def handle_call(:stop, _from, %__MODULE__{} = state) do
    state =
      if state.closed? do
        state
      else
        Port.close(state.port)
        %{state | closed?: true}
      end

    {:reply, :ok, state}
  end

  @impl true
  def handle_info({port, {:data, data}}, %__MODULE__{port: port} = state) do
    {decoder, events} = CodexSdk.LineFraming.feed(state.decoder, data)

    state =
      events
      |> Enum.reduce(%{state | decoder: decoder}, &handle_event/2)

    {:noreply, state}
  end

  def handle_info({port, {:exit_status, status}}, %__MODULE__{port: port} = state) do
    state =
      if state.closed? do
        state
      else
        Enum.each(state.pending, fn {_id, from} ->
          GenServer.reply(from, {:error, closed_error(status)})
        end)

        send_event(state, {:exit, status})

        %{state | closed?: true, exit_code: status, pending: %{}}
      end

    {:noreply, state}
  end

  defp handle_event({:malformed, raw}, %__MODULE__{} = state) do
    send_event(state, {:malformed, raw})
    state
  end

  defp handle_event({:message, message}, %__MODULE__{} = state) do
    {router, routed} = CodexSdk.MessageRouter.route(state.router, message)

    state
    |> Map.put(:router, router)
    |> handle_routed(routed)
  end

  defp handle_routed(%__MODULE__{} = state, {:response, id, message}) do
    reply_pending(state, id, {:ok, message["result"]})
  end

  defp handle_routed(%__MODULE__{} = state, {:error_response, id, message}) do
    reply_pending(state, id, {:error, json_rpc_error(message["error"])})
  end

  defp handle_routed(%__MODULE__{} = state, {:server_request, id, message}) do
    send_event(state, {:server_request, id, message})
    state
  end

  defp handle_routed(%__MODULE__{} = state, {:notification, message}) do
    send_event(state, {:notification, message})
    state
  end

  defp handle_routed(%__MODULE__{} = state, {:orphan_response, _id, message}) do
    send_event(state, {:unknown, message})
    state
  end

  defp handle_routed(%__MODULE__{} = state, {:unknown, message}) do
    send_event(state, {:unknown, message})
    state
  end

  defp reply_pending(%__MODULE__{} = state, id, reply) do
    case Map.pop(state.pending, id) do
      {nil, pending} ->
        %{state | pending: pending}

      {from, pending} ->
        GenServer.reply(from, reply)
        %{state | pending: pending}
    end
  end

  defp send_message(%__MODULE__{closed?: true, exit_code: code}, _message) do
    {:error, closed_error(code)}
  end

  defp send_message(%__MODULE__{} = state, message) do
    if Port.command(state.port, CodexSdk.JsonRpc.encode(message)) do
      :ok
    else
      {:error, closed_error(state.exit_code)}
    end
  end

  defp maybe_put_params(message, nil), do: message
  defp maybe_put_params(message, params), do: Map.put(message, "params", params)

  defp maybe_put_cd(opts, nil), do: opts
  defp maybe_put_cd(opts, cwd), do: [{:cd, cwd} | opts]

  defp send_event(%__MODULE__{} = state, event) do
    send(state.owner, {:usetemi_codex_sdk_app_server_event, self(), event})
  end

  defp json_rpc_error(error) when is_map(error) do
    %JsonRpcError{
      code: Map.get(error, "code", -32_000),
      message: Map.get(error, "message", "JSON-RPC error"),
      data: Map.get(error, "data")
    }
  end

  defp json_rpc_error(error) do
    %JsonRpcError{code: -32_000, message: "JSON-RPC error", data: error}
  end

  defp closed_error(code) do
    %ClosedError{code: code, message: "app-server closed with code #{inspect(code)}"}
  end
end
