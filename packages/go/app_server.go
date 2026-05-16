package codexsdk

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
)

// AppServerOptions configures a local Codex app-server subprocess.
type AppServerOptions struct {
	Command string
	Args    []string
	Dir     string
	Env     []string
}

// JSONRPCErrorBody is the JSON-RPC error object returned by the app-server.
type JSONRPCErrorBody struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitzero"`
}

// JSONRPCResponseError wraps a JSON-RPC error response.
type JSONRPCResponseError struct {
	Code    int
	Message string
	Data    any
}

func (err *JSONRPCResponseError) Error() string {
	return err.Message
}

// AppServerClosedError is returned when the app-server exits while requests are pending.
type AppServerClosedError struct {
	Code *int
}

func (err *AppServerClosedError) Error() string {
	if err.Code == nil {
		return "app-server closed"
	}

	return fmt.Sprintf("app-server closed with code %d", *err.Code)
}

// AppServerEventType identifies an app-server event.
type AppServerEventType string

const (
	AppServerEventNotification  AppServerEventType = "notification"
	AppServerEventServerRequest AppServerEventType = "serverRequest"
	AppServerEventMalformed     AppServerEventType = "malformed"
	AppServerEventUnknown       AppServerEventType = "unknown"
	AppServerEventExit          AppServerEventType = "exit"
)

// AppServerEvent is emitted for server notifications, server requests, malformed output, and exits.
type AppServerEvent struct {
	Type    AppServerEventType
	ID      any
	Message JSONRPCMessage
	Raw     string
	Code    *int
}

type responseOutcome struct {
	result any
	err    error
}

// AppServerClient manages a local stdio Codex app-server subprocess.
type AppServerClient struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	events chan AppServerEvent

	decoder JSONLineDecoder
	router  *MessageRouter

	mutex          sync.Mutex
	pending        map[responseID]chan responseOutcome
	requestCounter int
	closed         bool

	waitDone chan struct{}
	waitErr  error
}

// StartAppServer starts a Codex app-server subprocess.
func StartAppServer(ctx context.Context, options AppServerOptions) (*AppServerClient, error) {
	command := options.Command
	if command == "" {
		command = "codex"
	}
	args := options.Args
	if args == nil {
		args = []string{"app-server", "--listen", "stdio://"}
	}

	cmd := exec.CommandContext(ctx, command, args...)
	cmd.Dir = options.Dir
	if options.Env != nil {
		cmd.Env = append(os.Environ(), options.Env...)
	}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("open app-server stdin: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("open app-server stdout: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("open app-server stderr: %w", err)
	}

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start app-server: %w", err)
	}

	client := &AppServerClient{
		cmd:      cmd,
		stdin:    stdin,
		events:   make(chan AppServerEvent, 32),
		router:   NewMessageRouter(),
		pending:  make(map[responseID]chan responseOutcome),
		waitDone: make(chan struct{}),
	}

	go io.Copy(io.Discard, stderr)
	go client.readStdout(stdout)
	go client.wait()

	return client, nil
}

// Request sends a JSON-RPC request and waits for its response.
func (client *AppServerClient) Request(ctx context.Context, method string, params any) (any, error) {
	id := client.nextRequestID()
	key, _ := normalizeResponseID(id)
	responses := make(chan responseOutcome, 1)

	client.mutex.Lock()
	client.pending[key] = responses
	client.router.ExpectResponse(id)
	client.mutex.Unlock()

	if err := client.write(JSONRPCMessage{"id": id, "method": method, "params": params}); err != nil {
		client.removePending(key)
		return nil, err
	}

	select {
	case response := <-responses:
		return response.result, response.err
	case <-ctx.Done():
		client.removePending(key)
		return nil, context.Cause(ctx)
	}
}

// Notify sends a JSON-RPC notification.
func (client *AppServerClient) Notify(method string, params any) error {
	return client.write(JSONRPCMessage{"method": method, "params": params})
}

// Respond sends a successful response to a server-initiated request.
func (client *AppServerClient) Respond(id any, result any) error {
	return client.write(JSONRPCMessage{"id": id, "result": result})
}

// RespondError sends an error response to a server-initiated request.
func (client *AppServerClient) RespondError(id any, errorBody JSONRPCErrorBody) error {
	return client.write(JSONRPCMessage{"id": id, "error": errorBody})
}

// Events returns app-server events.
func (client *AppServerClient) Events() <-chan AppServerEvent {
	return client.events
}

// Close stops the app-server subprocess. It is safe to call more than once.
func (client *AppServerClient) Close() error {
	client.mutex.Lock()
	alreadyClosed := client.closed
	client.mutex.Unlock()
	if alreadyClosed {
		return nil
	}

	_ = client.stdin.Close()
	if client.cmd.Process != nil {
		_ = client.cmd.Process.Kill()
	}
	<-client.waitDone
	return client.waitErr
}

func (client *AppServerClient) nextRequestID() string {
	client.mutex.Lock()
	defer client.mutex.Unlock()

	client.requestCounter++
	return fmt.Sprintf("req-%d", client.requestCounter)
}

func (client *AppServerClient) write(message JSONRPCMessage) error {
	client.mutex.Lock()
	defer client.mutex.Unlock()

	if client.closed {
		return &AppServerClosedError{}
	}

	encoded, err := EncodeJSONRPCMessage(message)
	if err != nil {
		return err
	}
	if _, err := client.stdin.Write(encoded); err != nil {
		return fmt.Errorf("write app-server message: %w", err)
	}

	return nil
}

func (client *AppServerClient) readStdout(stdout io.Reader) {
	reader := bufio.NewReader(stdout)
	for {
		chunk, err := reader.ReadBytes('\n')
		if len(chunk) > 0 {
			decoded := client.decoder.Feed(chunk)
			for _, malformed := range decoded.Malformed {
				client.events <- AppServerEvent{Type: AppServerEventMalformed, Raw: malformed.Raw}
			}
			for _, message := range decoded.Messages {
				client.handleMessage(message)
			}
		}
		if err != nil {
			return
		}
	}
}

func (client *AppServerClient) handleMessage(message JSONRPCMessage) {
	routed := client.router.Route(message)
	switch routed.Type {
	case RouteResponse:
		client.resolvePending(routed.ID, responseOutcome{result: message["result"]})
	case RouteErrorResponse:
		client.resolvePending(routed.ID, responseOutcome{err: parseJSONRPCResponseError(message["error"])})
	case RouteServerRequest:
		client.events <- AppServerEvent{Type: AppServerEventServerRequest, ID: routed.ID, Message: message}
	case RouteNotification:
		client.events <- AppServerEvent{Type: AppServerEventNotification, Message: message}
	case RouteUnknown, RouteOrphanResponse:
		client.events <- AppServerEvent{Type: AppServerEventUnknown, Message: message}
	}
}

func (client *AppServerClient) resolvePending(id any, outcome responseOutcome) {
	key, ok := normalizeResponseID(id)
	if !ok {
		return
	}

	client.mutex.Lock()
	responses := client.pending[key]
	delete(client.pending, key)
	client.mutex.Unlock()

	if responses != nil {
		responses <- outcome
	}
}

func (client *AppServerClient) removePending(key responseID) {
	client.mutex.Lock()
	delete(client.pending, key)
	client.mutex.Unlock()
}

func (client *AppServerClient) wait() {
	err := client.cmd.Wait()
	code := 0
	if client.cmd.ProcessState != nil {
		code = client.cmd.ProcessState.ExitCode()
	}
	if err != nil && errors.Is(err, os.ErrProcessDone) {
		err = nil
	}

	client.mutex.Lock()
	if client.closed {
		client.mutex.Unlock()
		close(client.waitDone)
		return
	}
	client.closed = true
	pending := make([]chan responseOutcome, 0, len(client.pending))
	for _, responses := range client.pending {
		pending = append(pending, responses)
	}
	clear(client.pending)
	client.waitErr = err
	client.mutex.Unlock()

	closedError := &AppServerClosedError{Code: new(code)}
	for _, responses := range pending {
		responses <- responseOutcome{err: closedError}
	}
	client.events <- AppServerEvent{Type: AppServerEventExit, Code: new(code)}
	close(client.waitDone)
}

func parseJSONRPCResponseError(raw any) *JSONRPCResponseError {
	errorBody, ok := raw.(map[string]any)
	if !ok {
		return &JSONRPCResponseError{Code: -32000, Message: "JSON-RPC error"}
	}

	code := -32000
	if value, ok := errorBody["code"].(float64); ok {
		code = int(value)
	}
	message := "JSON-RPC error"
	if value, ok := errorBody["message"].(string); ok {
		message = value
	}

	return &JSONRPCResponseError{
		Code:    code,
		Message: message,
		Data:    errorBody["data"],
	}
}
