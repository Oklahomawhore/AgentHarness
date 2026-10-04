"""Python protocol projection of the keyless native scope Session recorded by the SDK lane.

The subprocess only replays recorded protocol data. The native scenario, not this
test, proves actual Loop requests, online reads, and model-visible replacement.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from pydantic import BaseModel

from deepseek_harness import DeepSeekHarness, RunResult
from deepseek_harness.api import final_response, finish_reason


REPOSITORY = Path(__file__).resolve().parents[3]
SESSION = REPOSITORY / "snapshots/sdk/scope-context-live/session.v3.jsonl"
EXPECTED = Path(__file__).parent / "expected/scope-context-live.json"

PROTOCOL_FIXTURE = '''\
import json
import sys

rows = [json.loads(line) for line in open(sys.argv[1], encoding="utf-8") if line.strip()]
stages = []
current = []
for row in rows[1:]:
    current.append(row)
    if row["type"] == "turn/end":
        stages.append(current)
        current = []
assert len(stages) == 3
stages[-1].extend(current)
next_stage = 0

def send(value):
    print(json.dumps(value), flush=True)

for line in sys.stdin:
    message = json.loads(line)
    method = message["method"]
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {"serverInfo": {"name": "recorded-scope-protocol"}}})
    elif method in ("session/prompt", "fixture/release-automatic"):
        stage = stages[next_stage]
        automatic = next_stage == 1
        assert automatic == (method == "fixture/release-automatic")
        next_stage += 1
        session_id = rows[0]["id"]
        if not automatic:
            user = next(row["data"] for row in stage if row["type"] == "user/message" and row["data"]["source"]["kind"] == "user")
            assert message["params"]["contentBlocks"] == user["content"]
            result = {"messageId": user["id"]}
        else:
            result = {}
        send({"jsonrpc": "2.0", "id": message["id"], "result": result})
        send({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": session_id, "status": "running"}})
        for event in stage:
            send({"jsonrpc": "2.0", "method": "session.event", "params": {"sessionId": session_id, "event": event}})
        send({"jsonrpc": "2.0", "method": "session.status", "params": {"sessionId": session_id, "status": "idle"}})
    elif method == "shutdown":
        send({"jsonrpc": "2.0", "id": message["id"], "result": {}})
        break
    else:
        raise AssertionError(method)
'''


class EmptyResponse(BaseModel):
    pass


def test_native_scope_recording_projects_losslessly_through_python(tmp_path: Path) -> None:
    script = tmp_path / "recorded_protocol.py"
    script.write_text(PROTOCOL_FIXTURE, encoding="utf-8")
    recorded = [json.loads(line) for line in SESSION.read_text(encoding="utf-8").splitlines()]
    with DeepSeekHarness(
        _launch_args=(sys.executable, str(script), str(SESSION)),
        cwd=str(tmp_path),
        request_timeout_seconds=10,
    ) as harness:
        session = harness.start_session(recorded[0]["id"])
        with harness.client.subscribe_session_notifications(session.id) as all_notifications:
            first = session.run("Inspect the current shared API declaration.")
            with harness.client.subscribe_session_notifications(session.id) as subscription:
                # Test-only protocol release: there is no user prompt for the recorded automatic turn.
                harness.client.request("fixture/release-automatic", None, response_model=EmptyResponse)
                notifications = []
                while True:
                    notification = subscription.next()
                    notifications.append(notification)
                    if notification.method == "session.status" and notification.payload.get("status") == "idle":
                        break
            events = [item.payload["event"] for item in notifications if item.method == "session.event"]
            automatic = RunResult(session.id, final_response(events), finish_reason(events), events, notifications)
            last = session.run("Continue after leaving the shared scope.")
            observed_notifications = []
            all_notifications.drain(observed_notifications.append)

    results = [first, automatic, last]
    observed_events = [item.payload["event"] for item in observed_notifications if item.method == "session.event"]
    assert observed_events == recorded[1:], "The public subscription must retain the complete Session event sequence"
    first_receipt = next(index for index, event in enumerate(recorded) if event["type"] == "agent/inbox/spliced")
    # RunResult starts at its own receipt; the subscription also retains control events between runs.
    for result in (first, last):
        assert result.events[0]["type"] == "agent/inbox/spliced"
        start = recorded.index(result.events[0])
        assert result.events == recorded[start:start + len(result.events)]
    events = observed_events[first_receipt - 1:]
    assert events == recorded[first_receipt:], "Python must retain every new control/source payload unchanged"
    states = [event["data"] for event in events if event["type"] == "scope-agent-context/state"]
    assert all(state["agentId"] == recorded[0]["id"] for state in states)
    pulses = [event["data"] for event in events if event["type"] == "user/message" and event["data"]["source"]["kind"] == "scope-agent-pulse"]
    assert len(pulses) == 1
    pulse = pulses[0]["source"]
    reservation = next(state for state in states if state["pendingActivation"] is not None)
    assert pulse["activationId"] == reservation["pendingActivation"]["id"]
    assert pulse["bindingId"] == reservation["binding"]["id"]
    assert reservation["pendingActivation"]["bindingId"] == reservation["binding"]["id"]
    contexts = [event for event in events if event["type"] == "user/message" and event["data"]["source"]["kind"] == "scope-agent-context"]
    suppressed = [event["data"] for event in events if event["type"] == "scope-agent-context/evaluation"
                  and event["data"]["decision"] == "suppress-unchanged"]
    assert [item["projection"]["taskRevision"] for item in suppressed] == [4, 5]
    assert all(item["baseline"] is not None for item in suppressed)
    for event in contexts[:3]:
        assert event["data"]["source"]["bindingId"] == pulse["bindingId"]
        assert event["data"]["source"]["subscriptionId"] == reservation["binding"]["subscriptionId"]
    projection = {
        "intervals": [{
            "finalResponse": result.final_response,
            "finishReason": result.finish_reason,
            "userInputs": sum(event["type"] == "user/message" and event["data"]["source"]["kind"] == "user" for event in result.events),
            "turns": [event["data"]["turn"] for event in result.events if event["type"] == "turn/end"],
            "steps": [event["data"]["step"] for event in result.events if event["type"] == "step/start"],
        } for result in results],
        "states": [{key: state[key] for key in ("mode", "pauseReason", "usedBudget", "lastActivationAt")}
                   | {"reserved": state["pendingActivation"] is not None} for state in states],
        "suppressedRevisions": [item["projection"]["taskRevision"] for item in suppressed],
        "contexts": [{
            "form": event["data"]["source"]["form"],
            "revision": event["data"]["source"].get("projection", {}).get("taskRevision"),
            "reason": event["data"]["source"].get("reason"),
            "text": [block["text"] for block in event["data"]["content"] if block["type"] == "text"],
            "replacesEarlierContext": isinstance(event.get("surfaceOp"), dict) and event["surfaceOp"].get("op") == "replace",
        } for event in contexts],
    }
    assert projection == json.loads(EXPECTED.read_text(encoding="utf-8"))
