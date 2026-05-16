defmodule CodexSdk.TransportTest do
  use ExUnit.Case, async: true

  @fixture_path Path.expand("../../conformance/fixtures/transport_core.json", __DIR__)
  @expanded_fixture_path Path.expand(
                           "../../conformance/fixtures/transport_expanded.json",
                           __DIR__
                         )
  @fake_app_server_path Path.expand("../../conformance/fake_app_server.py", __DIR__)

  test "encodes JSON-RPC messages as compact newline-delimited JSON" do
    fixture = fixture()

    assert IO.iodata_to_binary(CodexSdk.JsonRpc.encode(fixture["request"])) ==
             fixture["requestLine"]
  end

  test "decodes complete, partial, notification, and malformed JSON lines" do
    fixture = fixture()
    state = CodexSdk.LineFraming.new()

    {state, messages, malformed} =
      Enum.reduce(fixture["chunks"], {state, [], []}, fn chunk, {state, messages, malformed} ->
        {state, events} = CodexSdk.LineFraming.feed(state, chunk)

        {
          state,
          messages ++ for({:message, message} <- events, do: message),
          malformed ++ for({:malformed, raw} <- events, do: raw)
        }
      end)

    assert state.pending == ""
    assert messages == fixture["decodedMessages"]
    assert malformed == fixture["malformedLines"]
  end

  test "routes expected responses and preserves unknown notifications" do
    fixture = fixture()
    router_fixture = fixture["router"]

    router =
      CodexSdk.MessageRouter.new()
      |> CodexSdk.MessageRouter.expect_response(router_fixture["expectedResponseId"])

    {router, routed_response} = CodexSdk.MessageRouter.route(router, router_fixture["response"])

    assert routed_response ==
             {:response, router_fixture["expectedResponseId"], router_fixture["response"]}

    {router, routed_notification} =
      CodexSdk.MessageRouter.route(router, router_fixture["notification"])

    assert routed_notification == {:notification, router_fixture["notification"]}

    {router, routed_orphan} =
      CodexSdk.MessageRouter.route(router, router_fixture["orphanResponse"])

    assert routed_orphan == {:orphan_response, "req-2", router_fixture["orphanResponse"]}
    assert router.notifications == [router_fixture["notification"]]
  end

  test "decodes expanded shared framing cases" do
    fixture = expanded_fixture()

    for framing_case <- fixture["framingCases"] do
      state = CodexSdk.LineFraming.new()

      {state, messages, malformed} =
        Enum.reduce(framing_case["chunks"], {state, [], []}, fn chunk,
                                                                {state, messages, malformed} ->
          {state, events} = CodexSdk.LineFraming.feed(state, chunk)

          {
            state,
            messages ++ for({:message, message} <- events, do: message),
            malformed ++ for({:malformed, raw} <- events, do: raw)
          }
        end)

      assert messages == framing_case["decodedMessages"]
      assert malformed == framing_case["malformedLines"]
      assert state.pending == framing_case["pending"]
    end
  end

  test "routes expanded shared message cases" do
    fixture = expanded_fixture()["router"]

    router =
      Enum.reduce(fixture["expectedResponseIds"], CodexSdk.MessageRouter.new(), fn id, router ->
        CodexSdk.MessageRouter.expect_response(router, id)
      end)

    {routes, router} =
      Enum.map_reduce(fixture["messages"], router, fn message, router ->
        {router, routed} = CodexSdk.MessageRouter.route(router, message)
        {routed, router}
      end)

    assert Enum.map(routes, &route_summary/1) == fixture["routes"]
    assert router.notifications == fixture["notifications"]
  end

  test "app-server client handles request responses and errors" do
    {:ok, server} = fake_app_server()

    try do
      assert {:ok, %{"value" => "42"}} =
               CodexSdk.AppServer.request(server, "sdk/echo", %{"value" => "42"})

      assert {:error, %CodexSdk.AppServer.JsonRpcError{message: "fake failure"}} =
               CodexSdk.AppServer.request(server, "sdk/error", %{"retry" => false})
    after
      CodexSdk.AppServer.stop(server)
    end
  end

  test "app-server client sends and receives notifications" do
    {:ok, server} = fake_app_server()

    try do
      assert :ok =
               CodexSdk.AppServer.notify(server, "sdk/client-notification", %{"from" => "client"})

      assert_receive {:usetemi_codex_sdk_app_server_event, ^server,
                      {:notification,
                       %{
                         "method" => "fake/clientNotificationReceived",
                         "params" => %{"from" => "client"}
                       }}}

      assert {:ok, %{"notified" => true}} =
               CodexSdk.AppServer.request(server, "sdk/notify-server", %{"from" => "server"})

      assert_receive {:usetemi_codex_sdk_app_server_event, ^server,
                      {:notification,
                       %{"method" => "fake/notification", "params" => %{"from" => "server"}}}}
    after
      CodexSdk.AppServer.stop(server)
    end
  end

  test "app-server client surfaces server requests and client responses" do
    {:ok, server} = fake_app_server()

    try do
      assert {:ok, %{"requested" => true}} =
               CodexSdk.AppServer.request(server, "sdk/request-client", %{
                 "question" => "approve?"
               })

      assert_receive {:usetemi_codex_sdk_app_server_event, ^server,
                      {:server_request, "server-1",
                       %{
                         "id" => "server-1",
                         "method" => "fake/serverRequest",
                         "params" => %{"question" => "approve?"}
                       }}}

      assert :ok = CodexSdk.AppServer.respond(server, "server-1", %{"approved" => true})

      assert_receive {:usetemi_codex_sdk_app_server_event, ^server,
                      {:notification,
                       %{
                         "method" => "fake/serverRequestResolved",
                         "params" => %{
                           "id" => "server-1",
                           "result" => %{"approved" => true}
                         }
                       }}}
    after
      CodexSdk.AppServer.stop(server)
    end
  end

  test "app-server client surfaces malformed output and process exit" do
    {:ok, server} = fake_app_server()

    assert {:ok, %{"malformed" => true}} = CodexSdk.AppServer.request(server, "sdk/malformed")
    assert_receive {:usetemi_codex_sdk_app_server_event, ^server, {:malformed, "not-json"}}

    assert {:error, %CodexSdk.AppServer.ClosedError{code: 7}} =
             CodexSdk.AppServer.request(server, "sdk/exit")

    assert_receive {:usetemi_codex_sdk_app_server_event, ^server, {:exit, 7}}
    assert :ok = CodexSdk.AppServer.stop(server)
    assert :ok = CodexSdk.AppServer.stop(server)
  end

  defp fixture do
    @fixture_path
    |> File.read!()
    |> Jason.decode!()
  end

  defp expanded_fixture do
    @expanded_fixture_path
    |> File.read!()
    |> Jason.decode!()
  end

  defp fake_app_server do
    CodexSdk.AppServer.start_link(
      command: "python3",
      args: [@fake_app_server_path],
      owner: self()
    )
  end

  defp route_summary({:response, id, _message}), do: %{"type" => "response", "id" => id}

  defp route_summary({:error_response, id, _message}),
    do: %{"type" => "errorResponse", "id" => id}

  defp route_summary({:server_request, id, _message}),
    do: %{"type" => "serverRequest", "id" => id}

  defp route_summary({:orphan_response, id, _message}),
    do: %{"type" => "orphanResponse", "id" => id}

  defp route_summary({:notification, _message}), do: %{"type" => "notification"}
  defp route_summary({:unknown, _message}), do: %{"type" => "unknown"}
end
