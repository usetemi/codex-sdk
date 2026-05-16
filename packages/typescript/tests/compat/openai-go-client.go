package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	openai "github.com/openai/openai-go/v3"
	"github.com/openai/openai-go/v3/option"
	"github.com/openai/openai-go/v3/responses"
)

func main() {
	baseURL := requiredEnv("OPENAI_COMPAT_BASE_URL")
	apiKey := requiredEnv("OPENAI_COMPAT_API_KEY")

	const model = "codex-mini"
	const expectedText = "compat response"

	client := openai.NewClient(
		option.WithAPIKey(apiKey),
		option.WithBaseURL(baseURL),
		option.WithMaxRetries(0),
	)
	ctx := context.Background()

	models, err := client.Models.List(ctx)
	must(err)
	if len(models.Data) == 0 || models.Data[0].ID != model {
		panic(fmt.Sprintf("unexpected models payload: %+v", models.Data))
	}

	chat, err := client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{
		Model: openai.ChatModel(model),
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.UserMessage("Say hello."),
		},
	})
	must(err)
	if len(chat.Choices) == 0 || chat.Choices[0].Message.Content != expectedText {
		panic(fmt.Sprintf("unexpected chat response: %+v", chat))
	}
	if chat.Usage.PromptTokens != 5 || chat.Usage.CompletionTokens != 3 {
		panic(fmt.Sprintf("unexpected chat usage: %+v", chat.Usage))
	}

	chatStream := client.Chat.Completions.NewStreaming(ctx, openai.ChatCompletionNewParams{
		Model: openai.ChatModel(model),
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.UserMessage("Stream hello."),
		},
		StreamOptions: openai.ChatCompletionStreamOptionsParam{
			IncludeUsage: openai.Bool(true),
		},
	})

	chatStreamText := ""
	sawChatUsage := false
	for chatStream.Next() {
		chunk := chatStream.Current()
		if len(chunk.Choices) > 0 {
			chatStreamText += chunk.Choices[0].Delta.Content
		}
		sawChatUsage = sawChatUsage || chunk.Usage.TotalTokens > 0
	}
	must(chatStream.Err())
	if chatStreamText != expectedText {
		panic(fmt.Sprintf("unexpected chat stream text: %q", chatStreamText))
	}
	if !sawChatUsage {
		panic("expected final chat usage chunk")
	}

	response, err := client.Responses.New(ctx, responses.ResponseNewParams{
		Model: responses.ChatModel(model),
		Input: responses.ResponseNewParamsInputUnion{
			OfString: openai.String("Say hello."),
		},
	})
	must(err)
	if response.OutputText() != expectedText {
		panic(fmt.Sprintf("unexpected responses text: %q", response.OutputText()))
	}
	if response.Usage.InputTokens != 5 || response.Usage.OutputTokens != 3 {
		panic(fmt.Sprintf("unexpected responses usage: %+v", response.Usage))
	}

	responseStream := client.Responses.NewStreaming(ctx, responses.ResponseNewParams{
		Model: responses.ChatModel(model),
		Input: responses.ResponseNewParamsInputUnion{
			OfString: openai.String("Stream hello."),
		},
	})

	responseStreamText := ""
	sawResponseCompleted := false
	for responseStream.Next() {
		event := responseStream.Current()
		switch event.Type {
		case "response.output_text.delta":
			responseStreamText += event.Delta
		case "response.completed":
			sawResponseCompleted = true
		}
	}
	must(responseStream.Err())
	if responseStreamText != expectedText {
		panic(fmt.Sprintf("unexpected responses stream text: %q", responseStreamText))
	}
	if !sawResponseCompleted {
		panic("expected response.completed event")
	}

	_, err = client.Chat.Completions.New(ctx, openai.ChatCompletionNewParams{
		Model: openai.ChatModel(model),
		N:     openai.Int(2),
		Messages: []openai.ChatCompletionMessageParamUnion{
			openai.UserMessage("This should fail."),
		},
	})
	assertAPIError(err, 501, "unsupported_feature", "n")

	_, err = client.Responses.New(ctx, responses.ResponseNewParams{
		Model: responses.ChatModel(model),
		Input: responses.ResponseNewParamsInputUnion{
			OfString: openai.String("This should fail."),
		},
		PreviousResponseID: openai.String("resp_old"),
	})
	assertAPIError(err, 501, "unsupported_feature", "previous_response_id")

	must(json.NewEncoder(os.Stdout).Encode(map[string]any{
		"ok":     true,
		"client": "openai-go",
	}))
}

func assertAPIError(err error, status int, errorType string, param string) {
	if err == nil {
		panic("expected API error")
	}

	var apiErr *openai.Error
	if !errors.As(err, &apiErr) {
		panic(fmt.Sprintf("expected *openai.Error, got %T", err))
	}
	if apiErr.StatusCode != status || apiErr.Type != errorType || apiErr.Param != param {
		panic(fmt.Sprintf("unexpected API error: status=%d type=%q param=%q", apiErr.StatusCode, apiErr.Type, apiErr.Param))
	}
}

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func requiredEnv(name string) string {
	value := os.Getenv(name)
	if value == "" {
		panic(fmt.Sprintf("%s must be set", name))
	}
	return value
}
