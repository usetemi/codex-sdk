Mix.install([{:jason, "~> 1.4"}])

Application.ensure_all_started(:inets)
Application.ensure_all_started(:ssl)

defmodule CompatClient do
  def main do
    base_url = required_env!("OPENAI_COMPAT_BASE_URL")
    api_key = required_env!("OPENAI_COMPAT_API_KEY")
    model = "codex-mini"
    expected_text = "compat response"

    {200, models} = json_request(:get, "#{base_url}/models", nil, api_key)
    [first_model | _] = Map.fetch!(models, "data")
    assert(Map.fetch!(first_model, "id") == model, "unexpected model payload")

    {200, chat} =
      json_request(
        :post,
        "#{base_url}/chat/completions",
        %{
          "model" => model,
          "messages" => [%{"role" => "user", "content" => "Say hello."}]
        },
        api_key
      )

    [choice | _] = Map.fetch!(chat, "choices")
    assert(get_in(choice, ["message", "content"]) == expected_text, "unexpected chat text")
    assert(get_in(chat, ["usage", "prompt_tokens"]) == 5, "unexpected chat prompt tokens")
    assert(
      get_in(chat, ["usage", "completion_tokens"]) == 3,
      "unexpected chat completion tokens"
    )

    {200, chat_stream_body} =
      raw_request(
        :post,
        "#{base_url}/chat/completions",
        %{
          "model" => model,
          "stream" => true,
          "stream_options" => %{"include_usage" => true},
          "messages" => [%{"role" => "user", "content" => "Stream hello."}]
        },
        api_key
      )

    chat_events = parse_sse(chat_stream_body)
    assert(List.last(chat_events) == "[DONE]", "expected chat [DONE]")

    chat_chunks =
      chat_events
      |> Enum.drop(-1)
      |> Enum.map(&Jason.decode!/1)

    chat_stream_text =
      chat_chunks
      |> Enum.map(fn chunk ->
        chunk
        |> get_in(["choices", Access.at(0), "delta", "content"])
        |> Kernel.||("")
      end)
      |> Enum.join()

    saw_chat_usage =
      Enum.any?(chat_chunks, fn chunk ->
        get_in(chunk, ["usage", "total_tokens"]) == 8
      end)

    assert(chat_stream_text == expected_text, "unexpected chat stream text")
    assert(saw_chat_usage, "expected chat usage chunk")

    {200, response} =
      json_request(
        :post,
        "#{base_url}/responses",
        %{
          "model" => model,
          "input" => "Say hello."
        },
        api_key
      )

    assert(Map.fetch!(response, "output_text") == expected_text, "unexpected responses text")
    assert(get_in(response, ["usage", "input_tokens"]) == 5, "unexpected responses input tokens")
    assert(
      get_in(response, ["usage", "output_tokens"]) == 3,
      "unexpected responses output tokens"
    )

    {200, response_stream_body} =
      raw_request(
        :post,
        "#{base_url}/responses",
        %{
          "model" => model,
          "input" => "Stream hello.",
          "stream" => true
        },
        api_key
      )

    response_events = parse_sse(response_stream_body)

    response_payloads =
      Enum.map(response_events, fn event ->
        if event == "[DONE]", do: event, else: Jason.decode!(event)
      end)

    response_stream_text =
      response_payloads
      |> Enum.filter(&is_map/1)
      |> Enum.filter(&(Map.get(&1, "type") == "response.output_text.delta"))
      |> Enum.map_join("", &Map.fetch!(&1, "delta"))

    saw_response_completed =
      Enum.any?(response_payloads, fn
        %{"type" => "response.completed"} -> true
        _ -> false
      end)

    assert(response_stream_text == expected_text, "unexpected responses stream text")
    assert(saw_response_completed, "expected response.completed event")

    {501, chat_error} =
      json_request(
        :post,
        "#{base_url}/chat/completions",
        %{
          "model" => model,
          "n" => 2,
          "messages" => [%{"role" => "user", "content" => "This should fail."}]
        },
        api_key
      )

    assert(get_in(chat_error, ["error", "type"]) == "unsupported_feature", "unexpected chat error type")
    assert(get_in(chat_error, ["error", "param"]) == "n", "unexpected chat error param")

    {501, response_error} =
      json_request(
        :post,
        "#{base_url}/responses",
        %{
          "model" => model,
          "input" => "This should fail.",
          "previous_response_id" => "resp_old"
        },
        api_key
      )

    assert(
      get_in(response_error, ["error", "type"]) == "unsupported_feature",
      "unexpected responses error type"
    )

    assert(
      get_in(response_error, ["error", "param"]) == "previous_response_id",
      "unexpected responses error param"
    )

    IO.puts(Jason.encode!(%{ok: true, client: "raw-elixir"}))
  end

  defp json_request(method, url, body, api_key) do
    {status, payload} = raw_request(method, url, body, api_key)
    {status, Jason.decode!(payload)}
  end

  defp raw_request(method, url, body, api_key) do
    request =
      case body do
        nil ->
          {String.to_charlist(url), auth_headers(api_key)}

        payload ->
          {String.to_charlist(url), auth_headers(api_key), 'application/json', Jason.encode!(payload)}
      end

    options = [body_format: :binary]

    response =
      case body do
        nil -> :httpc.request(method, request, [], options)
        _ -> :httpc.request(method, request, [], options)
      end

    case response do
      {:ok, {{_version, status, _reason}, _headers, response_body}} ->
        {status, response_body}

      other ->
        raise "unexpected http response: #{inspect(other)}"
    end
  end

  defp auth_headers(api_key) do
    [
      {'authorization', String.to_charlist("Bearer " <> api_key)},
      {'content-type', 'application/json'}
    ]
  end

  defp parse_sse(body) do
    body
    |> String.split("\n\n", trim: true)
    |> Enum.map(fn event ->
      event
      |> String.split("\n")
      |> Enum.filter(&String.starts_with?(&1, "data: "))
      |> Enum.map_join("\n", &String.replace_prefix(&1, "data: ", ""))
    end)
  end

  defp required_env!(name) do
    case System.fetch_env(name) do
      {:ok, value} -> value
      :error -> raise "#{name} must be set"
    end
  end

  defp assert(true, _message), do: :ok
  defp assert(false, message), do: raise(message)
end

CompatClient.main()
