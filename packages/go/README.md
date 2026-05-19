# codexsdk

Go module for Temi convenience SDK and low-level transport helpers for Codex.

## Install

```bash
go get github.com/usetemi/codex-sdk/packages/go@v0.130.0-11
```

Package versions track the stable Codex version they target. Version `0.130.0-11` targets Codex `0.130.0`.

## Usage

```go
import codexsdk "github.com/usetemi/codex-sdk/packages/go"
```

```go
client, err := codexsdk.StartAppServer(ctx, codexsdk.AppServerOptions{})
if err != nil {
	panic(err)
}
defer client.Close()

result, err := client.Request(ctx, "initialize", map[string]any{
	"clientInfo": map[string]any{
		"name":    "my-client",
		"title":   "My Client",
		"version": "0.1.0",
	},
	"capabilities": map[string]any{},
})
if err != nil {
	panic(err)
}

fmt.Println(result)
```
