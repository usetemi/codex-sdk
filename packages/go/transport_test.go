package codexsdk

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type transportFixture struct {
	Request        JSONRPCMessage   `json:"request"`
	RequestLine    string           `json:"requestLine"`
	Chunks         []string         `json:"chunks"`
	DecodedMessage []JSONRPCMessage `json:"decodedMessages"`
	MalformedLines []string         `json:"malformedLines"`
	Router         struct {
		ExpectedResponseID string         `json:"expectedResponseId"`
		Response           JSONRPCMessage `json:"response"`
		Notification       JSONRPCMessage `json:"notification"`
		OrphanResponse     JSONRPCMessage `json:"orphanResponse"`
	} `json:"router"`
}

type expandedFixture struct {
	FramingCases []struct {
		Chunks          []string         `json:"chunks"`
		DecodedMessages []JSONRPCMessage `json:"decodedMessages"`
		MalformedLines  []string         `json:"malformedLines"`
		Pending         string           `json:"pending"`
	} `json:"framingCases"`
	Router struct {
		ExpectedResponseIDs []any            `json:"expectedResponseIds"`
		Messages            []JSONRPCMessage `json:"messages"`
		Routes              []struct {
			Type RouteType `json:"type"`
			ID   any       `json:"id"`
		} `json:"routes"`
		Notifications []JSONRPCMessage `json:"notifications"`
	} `json:"router"`
}

func TestEncodeJSONRPCMessage(t *testing.T) {
	fixture := readTransportFixture(t)

	encoded, err := EncodeJSONRPCMessage(fixture.Request)
	if err != nil {
		t.Fatalf("EncodeJSONRPCMessage returned error: %v", err)
	}

	if string(encoded) != fixture.RequestLine {
		t.Fatalf("encoded line mismatch:\n got: %q\nwant: %q", string(encoded), fixture.RequestLine)
	}
}

func TestJSONLineDecoder(t *testing.T) {
	fixture := readTransportFixture(t)
	decoder := NewJSONLineDecoder()
	messages := make([]JSONRPCMessage, 0)
	malformed := make([]string, 0)

	for _, chunk := range fixture.Chunks {
		decoded := decoder.Feed([]byte(chunk))
		messages = append(messages, decoded.Messages...)

		for _, line := range decoded.Malformed {
			malformed = append(malformed, line.Raw)
		}
	}

	if decoder.Pending() != "" {
		t.Fatalf("pending = %q, want empty", decoder.Pending())
	}
	if !reflect.DeepEqual(messages, fixture.DecodedMessage) {
		t.Fatalf("decoded messages mismatch:\n got: %#v\nwant: %#v", messages, fixture.DecodedMessage)
	}
	if !reflect.DeepEqual(malformed, fixture.MalformedLines) {
		t.Fatalf("malformed lines mismatch:\n got: %#v\nwant: %#v", malformed, fixture.MalformedLines)
	}
}

func TestMessageRouter(t *testing.T) {
	fixture := readTransportFixture(t)
	router := NewMessageRouter()
	router.ExpectResponse(fixture.Router.ExpectedResponseID)

	response := router.Route(fixture.Router.Response)
	assertRouted(t, response, RouteResponse, fixture.Router.ExpectedResponseID, fixture.Router.Response)

	notification := router.Route(fixture.Router.Notification)
	assertRouted(t, notification, RouteNotification, nil, fixture.Router.Notification)

	orphan := router.Route(fixture.Router.OrphanResponse)
	assertRouted(t, orphan, RouteOrphanResponse, "req-2", fixture.Router.OrphanResponse)

	if !reflect.DeepEqual(router.Notifications(), []JSONRPCMessage{fixture.Router.Notification}) {
		t.Fatalf("notifications mismatch: %#v", router.Notifications())
	}
}

func TestExpandedJSONLineDecoder(t *testing.T) {
	fixture := readExpandedFixture(t)

	for _, framingCase := range fixture.FramingCases {
		decoder := NewJSONLineDecoder()
		messages := make([]JSONRPCMessage, 0)
		malformed := make([]string, 0)

		for _, chunk := range framingCase.Chunks {
			decoded := decoder.Feed([]byte(chunk))
			messages = append(messages, decoded.Messages...)
			for _, line := range decoded.Malformed {
				malformed = append(malformed, line.Raw)
			}
		}

		if !reflect.DeepEqual(messages, framingCase.DecodedMessages) {
			t.Fatalf("decoded messages mismatch:\n got: %#v\nwant: %#v", messages, framingCase.DecodedMessages)
		}
		if !reflect.DeepEqual(malformed, framingCase.MalformedLines) {
			t.Fatalf("malformed lines mismatch:\n got: %#v\nwant: %#v", malformed, framingCase.MalformedLines)
		}
		if decoder.Pending() != framingCase.Pending {
			t.Fatalf("pending = %q, want %q", decoder.Pending(), framingCase.Pending)
		}
	}
}

func TestExpandedMessageRouter(t *testing.T) {
	fixture := readExpandedFixture(t)
	router := NewMessageRouter()
	for _, id := range fixture.Router.ExpectedResponseIDs {
		router.ExpectResponse(id)
	}

	for i, message := range fixture.Router.Messages {
		routed := router.Route(message)
		want := fixture.Router.Routes[i]
		if routed.Type != want.Type {
			t.Fatalf("route %d type = %q, want %q", i, routed.Type, want.Type)
		}
		if !reflect.DeepEqual(routed.ID, want.ID) {
			t.Fatalf("route %d id = %#v, want %#v", i, routed.ID, want.ID)
		}
	}
	if !reflect.DeepEqual(router.Notifications(), fixture.Router.Notifications) {
		t.Fatalf("notifications mismatch: %#v", router.Notifications())
	}
}

func TestAppServerClientRequestResponsesAndErrors(t *testing.T) {
	client := startFakeAppServer(t)
	defer client.Close()

	result, err := client.Request(t.Context(), "sdk/echo", map[string]any{"value": "42"})
	if err != nil {
		t.Fatalf("Request returned error: %v", err)
	}
	if !reflect.DeepEqual(result, map[string]any{"value": "42"}) {
		t.Fatalf("result = %#v", result)
	}

	_, err = client.Request(t.Context(), "sdk/error", map[string]any{"retry": false})
	var responseError *JSONRPCResponseError
	if !errors.As(err, &responseError) {
		t.Fatalf("error = %v, want JSONRPCResponseError", err)
	}
	if responseError.Message != "fake failure" {
		t.Fatalf("error message = %q", responseError.Message)
	}
}

func TestAppServerClientNotifications(t *testing.T) {
	client := startFakeAppServer(t)
	defer client.Close()

	if err := client.Notify("sdk/client-notification", map[string]any{"from": "client"}); err != nil {
		t.Fatalf("Notify returned error: %v", err)
	}
	event := nextEvent(t, client)
	assertEvent(t, event, AppServerEventNotification, nil, JSONRPCMessage{
		"method": "fake/clientNotificationReceived",
		"params": map[string]any{"from": "client"},
	})

	result, err := client.Request(t.Context(), "sdk/notify-server", map[string]any{"from": "server"})
	if err != nil {
		t.Fatalf("Request returned error: %v", err)
	}
	if !reflect.DeepEqual(result, map[string]any{"notified": true}) {
		t.Fatalf("result = %#v", result)
	}
	event = nextEvent(t, client)
	assertEvent(t, event, AppServerEventNotification, nil, JSONRPCMessage{
		"method": "fake/notification",
		"params": map[string]any{"from": "server"},
	})
}

func TestAppServerClientServerRequestAndResponse(t *testing.T) {
	client := startFakeAppServer(t)
	defer client.Close()

	result, err := client.Request(t.Context(), "sdk/request-client", map[string]any{"question": "approve?"})
	if err != nil {
		t.Fatalf("Request returned error: %v", err)
	}
	if !reflect.DeepEqual(result, map[string]any{"requested": true}) {
		t.Fatalf("result = %#v", result)
	}

	event := nextEvent(t, client)
	assertEvent(t, event, AppServerEventServerRequest, "server-1", JSONRPCMessage{
		"id":     "server-1",
		"method": "fake/serverRequest",
		"params": map[string]any{"question": "approve?"},
	})

	if err := client.Respond(event.ID, map[string]any{"approved": true}); err != nil {
		t.Fatalf("Respond returned error: %v", err)
	}
	event = nextEvent(t, client)
	assertEvent(t, event, AppServerEventNotification, nil, JSONRPCMessage{
		"method": "fake/serverRequestResolved",
		"params": map[string]any{
			"id":     "server-1",
			"result": map[string]any{"approved": true},
		},
	})
}

func TestAppServerClientMalformedOutputAndExit(t *testing.T) {
	client := startFakeAppServer(t)
	defer client.Close()

	result, err := client.Request(t.Context(), "sdk/malformed", nil)
	if err != nil {
		t.Fatalf("Request returned error: %v", err)
	}
	if !reflect.DeepEqual(result, map[string]any{"malformed": true}) {
		t.Fatalf("result = %#v", result)
	}

	event := nextEvent(t, client)
	if event.Type != AppServerEventMalformed || event.Raw != "not-json" {
		t.Fatalf("event = %#v", event)
	}

	_, err = client.Request(t.Context(), "sdk/exit", nil)
	var closedError *AppServerClosedError
	if !errors.As(err, &closedError) {
		t.Fatalf("error = %v, want AppServerClosedError", err)
	}
	event = nextEvent(t, client)
	if event.Type != AppServerEventExit || event.Code == nil || *event.Code != 7 {
		t.Fatalf("event = %#v", event)
	}

	if err := client.Close(); err != nil {
		t.Fatalf("first Close returned error: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("second Close returned error: %v", err)
	}
}

func assertRouted(
	t *testing.T,
	routed RoutedMessage,
	routeType RouteType,
	id any,
	message JSONRPCMessage,
) {
	t.Helper()

	if routed.Type != routeType {
		t.Fatalf("routed type = %q, want %q", routed.Type, routeType)
	}
	if !reflect.DeepEqual(routed.ID, id) {
		t.Fatalf("routed id = %#v, want %#v", routed.ID, id)
	}
	if !reflect.DeepEqual(routed.Message, message) {
		t.Fatalf("routed message mismatch:\n got: %#v\nwant: %#v", routed.Message, message)
	}
}

func readTransportFixture(t *testing.T) transportFixture {
	t.Helper()

	path := filepath.Join("..", "conformance", "fixtures", "transport_core.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var fixture transportFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}

	return fixture
}

func readExpandedFixture(t *testing.T) expandedFixture {
	t.Helper()

	path := filepath.Join("..", "conformance", "fixtures", "transport_expanded.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var fixture expandedFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}

	return fixture
}

func startFakeAppServer(t *testing.T) *AppServerClient {
	t.Helper()

	client, err := StartAppServer(t.Context(), AppServerOptions{
		Command: "python3",
		Args:    []string{filepath.Join("..", "conformance", "fake_app_server.py")},
	})
	if err != nil {
		t.Fatalf("StartAppServer returned error: %v", err)
	}

	return client
}

func nextEvent(t *testing.T, client *AppServerClient) AppServerEvent {
	t.Helper()

	select {
	case event, ok := <-client.Events():
		if !ok {
			t.Fatal("event channel closed")
		}
		return event
	case <-t.Context().Done():
		t.Fatalf("timed out waiting for event: %v", t.Context().Err())
	}

	panic("unreachable")
}

func assertEvent(
	t *testing.T,
	event AppServerEvent,
	eventType AppServerEventType,
	id any,
	message JSONRPCMessage,
) {
	t.Helper()

	if event.Type != eventType {
		t.Fatalf("event type = %q, want %q", event.Type, eventType)
	}
	if !reflect.DeepEqual(event.ID, id) {
		t.Fatalf("event id = %#v, want %#v", event.ID, id)
	}
	if !reflect.DeepEqual(event.Message, message) {
		t.Fatalf("event message mismatch:\n got: %#v\nwant: %#v", event.Message, message)
	}
}
