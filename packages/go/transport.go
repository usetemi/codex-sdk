package codexsdk

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
)

// JSONRPCMessage is a decoded JSON-RPC object.
type JSONRPCMessage map[string]any

// ErrJSONRPCLineNotObject is reported when a newline-delimited JSON value is not an object.
var ErrJSONRPCLineNotObject = errors.New("JSON-RPC line must decode to an object")

// EncodeJSONRPCMessage encodes a JSON-RPC message as compact newline-delimited JSON.
func EncodeJSONRPCMessage(message JSONRPCMessage) ([]byte, error) {
	encoded, err := json.Marshal(message)
	if err != nil {
		return nil, fmt.Errorf("encode JSON-RPC message: %w", err)
	}

	return append(encoded, '\n'), nil
}

// MalformedJSONLine records a JSON line that could not be decoded as a JSON-RPC object.
type MalformedJSONLine struct {
	Raw string
	Err error
}

// DecodedJSONLines contains messages and malformed lines decoded from one feed chunk.
type DecodedJSONLines struct {
	Messages  []JSONRPCMessage
	Malformed []MalformedJSONLine
}

// JSONLineDecoder incrementally decodes newline-delimited JSON-RPC messages.
type JSONLineDecoder struct {
	pending string
}

// NewJSONLineDecoder returns an empty newline-delimited JSON decoder.
func NewJSONLineDecoder() *JSONLineDecoder {
	return &JSONLineDecoder{}
}

// Feed decodes all complete lines from chunk and retains any partial final line.
func (decoder *JSONLineDecoder) Feed(chunk []byte) DecodedJSONLines {
	combined := decoder.pending + string(chunk)
	decoded := DecodedJSONLines{
		Messages:  make([]JSONRPCMessage, 0),
		Malformed: make([]MalformedJSONLine, 0),
	}

	for {
		line, rest, found := strings.Cut(combined, "\n")
		if !found {
			decoder.pending = combined
			return decoded
		}

		combined = rest
		raw, _ := strings.CutSuffix(line, "\r")
		if raw == "" {
			continue
		}

		message, err := decodeJSONRPCLine(raw)
		if err != nil {
			decoded.Malformed = append(decoded.Malformed, MalformedJSONLine{Raw: raw, Err: err})
			continue
		}

		decoded.Messages = append(decoded.Messages, message)
	}
}

// Pending returns the partial line retained for the next feed call.
func (decoder *JSONLineDecoder) Pending() string {
	return decoder.pending
}

func decodeJSONRPCLine(raw string) (JSONRPCMessage, error) {
	var parsed any
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return nil, fmt.Errorf("decode JSON-RPC line: %w", err)
	}

	message, ok := parsed.(map[string]any)
	if !ok {
		return nil, ErrJSONRPCLineNotObject
	}

	return JSONRPCMessage(message), nil
}

// RouteType identifies how a decoded JSON-RPC message was routed.
type RouteType string

const (
	// RouteResponse is an expected response for a tracked request ID.
	RouteResponse RouteType = "response"
	// RouteErrorResponse is an expected JSON-RPC error response for a tracked request ID.
	RouteErrorResponse RouteType = "errorResponse"
	// RouteServerRequest is a request initiated by the server.
	RouteServerRequest RouteType = "serverRequest"
	// RouteOrphanResponse is a response for an untracked request ID.
	RouteOrphanResponse RouteType = "orphanResponse"
	// RouteNotification is a JSON-RPC notification.
	RouteNotification RouteType = "notification"
	// RouteUnknown is an object that is neither a response nor a notification.
	RouteUnknown RouteType = "unknown"
)

// RoutedMessage is the result of routing a decoded JSON-RPC message.
type RoutedMessage struct {
	Type    RouteType
	ID      any
	Message JSONRPCMessage
}

// MessageRouter routes decoded JSON-RPC objects into responses, notifications, and unknown messages.
type MessageRouter struct {
	expectedResponseIDs map[responseID]struct{}
	notifications       []JSONRPCMessage
}

// NewMessageRouter returns an empty message router.
func NewMessageRouter() *MessageRouter {
	return &MessageRouter{expectedResponseIDs: make(map[responseID]struct{})}
}

// ExpectResponse tracks requestID as an expected response.
func (router *MessageRouter) ExpectResponse(requestID any) {
	key, ok := normalizeResponseID(requestID)
	if !ok {
		return
	}

	router.expectedResponseIDs[key] = struct{}{}
}

// Route routes a decoded JSON-RPC object.
func (router *MessageRouter) Route(message JSONRPCMessage) RoutedMessage {
	if id, ok := message["id"]; ok {
		if key, ok := normalizeResponseID(id); ok {
			if _, ok := message["method"].(string); ok {
				return RoutedMessage{Type: RouteServerRequest, ID: id, Message: message}
			}

			if _, expected := router.expectedResponseIDs[key]; expected {
				delete(router.expectedResponseIDs, key)
				if _, ok := message["error"].(map[string]any); ok {
					return RoutedMessage{Type: RouteErrorResponse, ID: id, Message: message}
				}

				return RoutedMessage{Type: RouteResponse, ID: id, Message: message}
			}

			return RoutedMessage{Type: RouteOrphanResponse, ID: id, Message: message}
		}
	}

	if method, ok := message["method"].(string); ok && method != "" {
		router.notifications = append(router.notifications, message)
		return RoutedMessage{Type: RouteNotification, Message: message}
	}

	return RoutedMessage{Type: RouteUnknown, Message: message}
}

// Notifications returns the notifications routed so far.
func (router *MessageRouter) Notifications() []JSONRPCMessage {
	return slices.Clone(router.notifications)
}

type responseID struct {
	kind  string
	value string
}

func normalizeResponseID(id any) (responseID, bool) {
	switch value := id.(type) {
	case string:
		return responseID{kind: "string", value: value}, true
	case int:
		return responseID{kind: "number", value: strconv.FormatInt(int64(value), 10)}, true
	case int64:
		return responseID{kind: "number", value: strconv.FormatInt(value, 10)}, true
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return responseID{}, false
		}

		return responseID{kind: "number", value: strconv.FormatFloat(value, 'f', -1, 64)}, true
	case json.Number:
		return responseID{kind: "number", value: value.String()}, true
	default:
		return responseID{}, false
	}
}
