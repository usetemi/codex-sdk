import json
import sys
import unittest
from pathlib import Path

from usetemi_codex_sdk.transport import (
    AppServerClient,
    AppServerClosedError,
    JsonLineDecoder,
    JsonRpcResponseError,
    MessageRouter,
    encode_json_rpc_message,
)

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = json.loads((ROOT / "conformance" / "fixtures" / "transport_core.json").read_text())
EXPANDED_FIXTURE = json.loads(
    (ROOT / "conformance" / "fixtures" / "transport_expanded.json").read_text()
)
FAKE_APP_SERVER = ROOT / "conformance" / "fake_app_server.py"


class TransportTest(unittest.TestCase):
    def test_encodes_json_rpc_messages_as_compact_newline_delimited_json(self) -> None:
        self.assertEqual(encode_json_rpc_message(FIXTURE["request"]), FIXTURE["requestLine"])

    def test_decodes_complete_partial_notification_and_malformed_json_lines(self) -> None:
        decoder = JsonLineDecoder()
        messages = []
        malformed = []

        for chunk in FIXTURE["chunks"]:
            decoded = decoder.feed(chunk)
            messages.extend(decoded.messages)
            malformed.extend(line.raw for line in decoded.malformed)

        self.assertEqual(messages, FIXTURE["decodedMessages"])
        self.assertEqual(malformed, FIXTURE["malformedLines"])

    def test_routes_expected_responses_and_preserves_unknown_notifications(self) -> None:
        router = MessageRouter()
        router.expect_response(FIXTURE["router"]["expectedResponseId"])

        self.assertEqual(
            router.route(FIXTURE["router"]["response"]),
            {
                "type": "response",
                "id": FIXTURE["router"]["expectedResponseId"],
                "message": FIXTURE["router"]["response"],
            },
        )
        self.assertEqual(
            router.route(FIXTURE["router"]["notification"]),
            {
                "type": "notification",
                "message": FIXTURE["router"]["notification"],
            },
        )
        self.assertEqual(
            router.route(FIXTURE["router"]["orphanResponse"]),
            {
                "type": "orphanResponse",
                "id": "req-2",
                "message": FIXTURE["router"]["orphanResponse"],
            },
        )
        self.assertEqual(router.notifications, [FIXTURE["router"]["notification"]])

    def test_decodes_expanded_shared_framing_cases(self) -> None:
        for framing_case in EXPANDED_FIXTURE["framingCases"]:
            decoder = JsonLineDecoder()
            messages = []
            malformed = []

            for chunk in framing_case["chunks"]:
                decoded = decoder.feed(chunk)
                messages.extend(decoded.messages)
                malformed.extend(line.raw for line in decoded.malformed)

            self.assertEqual(messages, framing_case["decodedMessages"])
            self.assertEqual(malformed, framing_case["malformedLines"])
            self.assertEqual(decoder.pending, framing_case["pending"])

    def test_routes_expanded_shared_message_cases(self) -> None:
        router = MessageRouter()
        for request_id in EXPANDED_FIXTURE["router"]["expectedResponseIds"]:
            router.expect_response(request_id)

        routes = [router.route(message) for message in EXPANDED_FIXTURE["router"]["messages"]]
        self.assertEqual(
            [{"type": route["type"], "id": route.get("id")} for route in routes],
            [
                {"type": route["type"], "id": route.get("id")}
                for route in EXPANDED_FIXTURE["router"]["routes"]
            ],
        )
        self.assertEqual(router.notifications, EXPANDED_FIXTURE["router"]["notifications"])

    def test_app_server_client_handles_request_responses_and_errors(self) -> None:
        with fake_client() as client:
            self.assertEqual(client.request("sdk/echo", {"value": 42}), {"value": 42})

            with self.assertRaisesRegex(JsonRpcResponseError, "fake failure"):
                client.request("sdk/error", {"retry": False})

    def test_app_server_client_sends_and_receives_notifications(self) -> None:
        with fake_client() as client:
            client.notify("sdk/client-notification", {"from": "client"})
            self.assertEqual(
                client.next_event(),
                {
                    "type": "notification",
                    "message": {
                        "method": "fake/clientNotificationReceived",
                        "params": {"from": "client"},
                    },
                },
            )

            self.assertEqual(
                client.request("sdk/notify-server", {"from": "server"}),
                {"notified": True},
            )
            self.assertEqual(
                client.next_event(),
                {
                    "type": "notification",
                    "message": {
                        "method": "fake/notification",
                        "params": {"from": "server"},
                    },
                },
            )

    def test_app_server_client_surfaces_server_requests_and_client_responses(self) -> None:
        with fake_client() as client:
            self.assertEqual(
                client.request("sdk/request-client", {"question": "approve?"}),
                {"requested": True},
            )
            event = client.next_event()
            self.assertEqual(
                event,
                {
                    "type": "serverRequest",
                    "id": "server-1",
                    "message": {
                        "id": "server-1",
                        "method": "fake/serverRequest",
                        "params": {"question": "approve?"},
                    },
                },
            )

            client.respond(event["id"], {"approved": True})
            self.assertEqual(
                client.next_event(),
                {
                    "type": "notification",
                    "message": {
                        "method": "fake/serverRequestResolved",
                        "params": {
                            "id": "server-1",
                            "result": {"approved": True},
                        },
                    },
                },
            )

    def test_app_server_client_surfaces_malformed_output_and_process_exit(self) -> None:
        client = fake_client()
        try:
            self.assertEqual(client.request("sdk/malformed"), {"malformed": True})
            self.assertEqual(client.next_event(), {"type": "malformed", "raw": "not-json"})

            with self.assertRaises(AppServerClosedError):
                client.request("sdk/exit")
            self.assertEqual(client.next_event(), {"type": "exit", "code": 7})
            client.close()
            client.close()
        finally:
            client.close()


def fake_client() -> AppServerClient:
    return AppServerClient.start(command=[sys.executable, str(FAKE_APP_SERVER)])


if __name__ == "__main__":
    unittest.main()
