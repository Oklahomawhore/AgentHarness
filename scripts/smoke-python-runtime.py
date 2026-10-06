#!/usr/bin/env python3
"""Keyless full-turn and snapshot smoke for the Python SDK runtime."""

from __future__ import annotations

import argparse
import difflib
import importlib
import importlib.metadata
import json
import os
import queue
import re
import secrets
import shutil
import subprocess
import sys
import sysconfig
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import TYPE_CHECKING, Callable

if TYPE_CHECKING:
    from deepseek_harness import DeepSeekHarness, RunResult
    from deepseek_harness.api import Session


EXPECTED_TEXT = "runtime smoke ok"
LIVE_API_SENTINEL = "PYTHON_SDK_LIVE_OK"
CODE_PROMPT = "Use run_code to compute the packaged worker smoke value."
CODE_WORKER_TEXT = "code worker smoke ok"
WORKFLOW_PROMPT = "Use workflow to compute the packaged worker smoke value without agents."
WORKFLOW_WORKER_TEXT = "workflow worker smoke ok"
MINIMAL_PROMPT = "Exercise the packaged minimal agent's persistent shell."
MINIMAL_TEXT = "minimal agent smoke ok"
FS_SEARCH_PROMPT = "Exercise the packaged filesystem search tools."
FS_SEARCH_TEXT = "filesystem search smoke ok"
FS_SEARCH_MARKER = "PACKAGED_FS_SEARCH_OK"
MCP_PROMPT = "Exercise the packaged MCP client with one external stdio server."
MCP_TEXT = "MCP client smoke ok"
PROFILE_PLUGIN_PROMPT = "Verify the Python-installed dsh profile plugin."
PROFILE_PLUGIN_TEXT = "profile plugin smoke ok"
PROFILE_PLUGIN_MARKER = "PYTHON_INSTALLED_DSH_PROFILE_PLUGIN"
IS_WINDOWS = sys.platform == "win32"
MINIMAL_SHELL_TOOL = "pwsh" if IS_WINDOWS else "bash"
MINIMAL_SHELL_COMMAND = (
    "$global:dshSdkCounter = [int]$global:dshSdkCounter + 1; "
    'Write-Output "COUNT=$global:dshSdkCounter CWD=$((Get-Location).Path)"; '
    "if ($global:dshSdkCounter -eq 1) { Set-Location $env:TEMP }"
    if IS_WINDOWS
    else (
        "counter=$(( ${counter:-0} + 1 )); export counter; "
        "printf 'COUNT=%s CWD=%s\\n' \"$counter\" \"$PWD\"; "
        "if [ \"$counter\" -eq 1 ]; then cd /tmp; fi"
    )
)
MINIMAL_SHELL_SECOND_CWD = str(Path(tempfile.gettempdir()).resolve()) if IS_WINDOWS else "/tmp"
SPAWN_NODE_PROMPT = "Run node --version through the packaged shell tool."
SPAWN_NODE_TEXT = "spawn node smoke ok"
SPAWN_NODE_CALL_ID = "spawn-node-shell"
# The POSIX command string starts with `node ` inside the shell tool's `bash -c`
# argv, the exact form @yao-pkg/pkg's unpatched SEA bootstrap rewrites to the
# executable itself while stamping PKG_EXECPATH into the child environment.
SPAWN_NODE_COMMAND = (
    'node --version; if ($env:PKG_EXECPATH) { "PKG_EXECPATH=$env:PKG_EXECPATH" } else { "PKG_EXECPATH=ABSENT" }'
    if IS_WINDOWS
    else 'node --version; echo "PKG_EXECPATH=${PKG_EXECPATH:-ABSENT}"'
)
LEGACY_CUSTOM_DISABLED_ROWS = (
    "agent-instructions",
    "goal",
    "goal-round-driver",
    "command-goal",
    "plan-mode",
    "skill",
    "skill-filesystem",
    "tool-fs",
    "tool-fs-search",
    "tool-goal",
    "tool-ralph",
    "tool-skill",
    "tool-str-replace-editor",
    "tool-subagent-control",
    "tool-subagent-list-agents",
    "tool-subagent-fork",
    "tool-todo",
    "tool-web",
)
SNAPSHOT_PROMPT = "Run the advanced packaged-runtime snapshot scenario."
SNAPSHOT_SESSION_ID = "advanced-executable"
SNAPSHOT_DIRECT_CHILD_PROMPT = "Reply with exactly DIRECT_CHILD_OK and nothing else."
SNAPSHOT_WORKFLOW_CHILD_PROMPT = "Reply with exactly WORKFLOW_CHILD_OK and nothing else."
SNAPSHOT_FINAL_TEXT = "ADVANCED_EXECUTABLE_OK"
RESTART_FIRST_PROMPT = "Complete the first isolated Python SDK process turn."
RESTART_FIRST_TEXT = "PROCESS_ONE_OK"
RESTART_SECOND_PROMPT = "Complete the second isolated Python SDK process turn."
RESTART_SECOND_TEXT = "PROCESS_TWO_OK"
RESTART_FIRST_SESSION_ID = "process-one"
RESTART_SECOND_SESSION_ID = "process-two"
SNAPSHOT_PLUGIN_CODE = """\
return (ctx) => {
  harness.registerTool(ctx, harness.defineTool({
    name: 'snapshot_double',
    description: 'Double a number for executable snapshot verification.',
    parameters: { value: { type: 'number', required: true } },
    output: {
      schema: { type: 'number' },
      render(_args, value) {
        return [{ type: 'text', text: String(value) }]
      }
    },
    async execute(args) {
      return args.value * 2
    }
  }))
}
"""
SNAPSHOT_WORKFLOW_SCRIPT = (
    "phase('Delegate')\n"
    f"const reply = await agent('{SNAPSHOT_WORKFLOW_CHILD_PROMPT}', {{ label: 'workflow-child' }})\n"
    "return { reply }"
)
ADVANCED_SNAPSHOT_DIRECTORY = (
    Path(__file__).resolve().parent / "snapshots" / "python-sdk-single-exe" / "advanced"
)
ADVANCED_SNAPSHOT_FILENAMES = (
    "result.json", "session.v3.jsonl", "session.1.v3.jsonl", "session.2.v3.jsonl",
)
MINIMAL_SNAPSHOT_DIRECTORY = (
    Path(__file__).resolve().parent / "snapshots" / "python-sdk-single-exe" / "minimal"
)
if IS_WINDOWS:
    MINIMAL_SNAPSHOT_DIRECTORY /= "win-x64"
MINIMAL_SNAPSHOT_FILENAMES = ("model-visible.json",)
IN_HISTORY_SNAPSHOT_DIRECTORY = (
    Path(__file__).resolve().parent / "snapshots" / "python-sdk-single-exe" / "minimal-in-history"
)
IN_HISTORY_SNAPSHOT_FILENAMES = ("prompt-history.json",)
RESTART_SNAPSHOT_DIRECTORY = (
    Path(__file__).resolve().parent / "snapshots" / "python-sdk-single-exe" / "restart"
)
RESTART_SNAPSHOT_FILENAMES = (
    "result.json", "requests.json", "session.1.v3.jsonl", "session.2.v3.jsonl",
)
MCP_SERVER_SCRIPT = """\
import json
import os
import sys
import time


log_path = os.environ.get("MCP_SMOKE_LOG")


def send(message):
    sys.stdout.write(json.dumps(message, separators=(",", ":")) + "\\n")
    sys.stdout.flush()


for line in sys.stdin:
    request = json.loads(line)
    if log_path is not None:
        with open(log_path, "a", encoding="utf-8") as log:
            log.write(str(request.get("method")) + "\\n")
    request_id = request.get("id")
    if request_id is None:
        continue
    method = request.get("method")
    if method == "initialize":
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "protocolVersion": request["params"]["protocolVersion"],
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": "python-wheel-fixture", "version": "1.0.0"},
            },
        })
    elif method == "tools/list":
        # Keep discovery pending long enough that an SDK runtime answering
        # initialize before discovery completes makes its first model request
        # without this tool and fails deterministically.
        time.sleep(0.25)
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {
                "tools": [{
                    "name": "add",
                    "description": "Add two numbers.",
                    "inputSchema": {
                        "type": "object",
                        "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
                        "required": ["a", "b"],
                        "additionalProperties": False,
                    },
                }],
            },
        })
    elif method == "tools/call":
        params = request["params"]
        if params.get("name") != "add" or params.get("arguments") != {"a": 19, "b": 23}:
            send({
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32602, "message": "unexpected tool call"},
            })
            continue
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": {"content": [{"type": "text", "text": "42"}]},
        })
    else:
        send({
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {"code": -32601, "message": f"unsupported method: {method}"},
        })
"""


def write_profile_patch(
    root: Path,
    name: str,
    sessions: Path,
    patches: list[dict[str, object]],
) -> Path:
    """Write one JSON-form dsh profile patch with deterministic persistence."""
    path = root / name
    path.write_text(json.dumps([
        {
            "id": "session-persistence-jsonl",
            "config": {"root": str(sessions), "compression": "none"},
        },
        {"id": "session-telemetry-otel", "disabled": True},
        *patches,
    ], indent=2))
    return path


def write_advanced_profile_patch(root: Path, name: str, sessions: Path) -> Path:
    """Write the shared custom, snapshot, and restart profile patch."""
    return write_profile_patch(root, name, sessions, [
        {"id": "tools", "config": {"mode": "both"}},
        {
            "id": "system-prompt",
            "config": {
                "persona": "You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.",
            },
        },
        {"id": "session-log-deepseek", "config": {"enabled": True}},
        *({"id": row_id, "disabled": True} for row_id in LEGACY_CUSTOM_DISABLED_ROWS),
        {"id": "tool-bash", "disabled": True},
        {"id": "tool-pwsh", "disabled": True},
        {
            "id": "tool-subagent",
            "config": {
                "provider": "spawn",
                "toolName": "subagent",
                "backgroundMode": "one-shot",
            },
        },
        {"insert": [
            {"id": "code-runtime", "name": "@deepseek-ai/dsh-code-runtime-worker-thread"},
            {"id": "cordis-host-runner", "name": "@deepseek-ai/dsh-cordis-host-runner"},
            {"id": "cordis-tool", "name": "@deepseek-ai/dsh-tool-cordis"},
        ]},
    ])


def write_mcp_patch(root: Path, sessions: Path, server_script: Path) -> Path:
    """Write a profile patch that mounts the packaged MCP client."""
    return write_profile_patch(root, "mcp.patch.yml", sessions, [{
        "insert": [{
            "id": "mcp-fixture",
            "name": "@deepseek-ai/dsh-mcp-client",
            "config": {
                "serverName": "fixture",
                "transport": "stdio",
                "command": sys.executable,
                "args": [str(server_script)],
                "env": {"MCP_SMOKE_LOG": str(server_script.with_suffix(".log"))},
                "failOnStartupError": True,
                "reconnect": {"enabled": False},
            },
        }],
    }])


class MockModelHandler(BaseHTTPRequestHandler):
    """Return deterministic text, worker, and orchestration completions."""

    requests: list[dict[str, object]] = []

    def do_POST(self) -> None:
        content_length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(content_length))
        self.requests.append(body)
        self.send_response(200)
        self.send_header("content-type", "text/event-stream")
        self.end_headers()
        chunks = completion_chunks(body)
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()

    def log_message(self, _format: str, *_args: object) -> None:
        return


def completion_chunks(body: dict[str, object]) -> list[dict[str, object]]:
    """Choose the next deterministic model response from request history."""
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise AssertionError(f"model request has no messages: {body}")
    # A system prompt update may follow the tool result without replacing it.
    latest = next(message for message in reversed(messages) if message.get("role") != "system")
    if not isinstance(latest, dict):
        raise AssertionError(f"model request has an invalid latest message: {body}")

    if latest.get("role") == "tool":
        call_id, tool_name = latest_tool_call(messages)
        tool_text = message_text(latest.get("content"))
        mcp = mcp_tool_followup(call_id, tool_name, tool_text)
        if mcp is not None:
            return mcp
        fs_search = fs_search_tool_followup(call_id, tool_name, tool_text)
        if fs_search is not None:
            return fs_search
        spawn_node = spawn_node_tool_followup(call_id, tool_name, tool_text)
        if spawn_node is not None:
            return spawn_node
        minimal = minimal_tool_followup(call_id, tool_name, tool_text)
        if minimal is not None:
            return minimal
        advanced = advanced_tool_followup(body, call_id, tool_name, tool_text)
        if advanced is not None:
            return advanced
        if "42" not in tool_text:
            raise AssertionError(f"{tool_name} worker returned no expected value: {latest}")
        if tool_name == "run_code":
            return text_chunks(CODE_WORKER_TEXT)
        if tool_name == "workflow":
            return text_chunks(WORKFLOW_WORKER_TEXT)
        raise AssertionError(f"unexpected tool follow-up: {tool_name}")

    user_prompts = [
        message_text(message.get("content"))
        for message in reversed(messages)
        if isinstance(message, dict) and message.get("role") == "user"
    ]
    minimal_prompt = next((prompt for prompt in user_prompts if prompt == MINIMAL_PROMPT), None)
    # The minimal composition's assembled system prompt, advertised tool schemas, and
    # model-visible messages are pinned by its snapshot, not asserted here.
    if minimal_prompt is not None:
        return tool_call_chunks(
            "minimal-bash-1",
            MINIMAL_SHELL_TOOL,
            {"command": MINIMAL_SHELL_COMMAND},
        )
    scenario_prompts = {
        SNAPSHOT_DIRECT_CHILD_PROMPT,
        SNAPSHOT_WORKFLOW_CHILD_PROMPT,
        SNAPSHOT_PROMPT,
        CODE_PROMPT,
        WORKFLOW_PROMPT,
        FS_SEARCH_PROMPT,
        SPAWN_NODE_PROMPT,
        MCP_PROMPT,
        RESTART_FIRST_PROMPT,
        RESTART_SECOND_PROMPT,
        PROFILE_PLUGIN_PROMPT,
    }
    prompt = next(
        (candidate for candidate in user_prompts if candidate in scenario_prompts),
        message_text(latest.get("content")),
    )
    if prompt == SNAPSHOT_DIRECT_CHILD_PROMPT:
        return text_chunks("DIRECT_CHILD_OK")
    if prompt == SNAPSHOT_WORKFLOW_CHILD_PROMPT:
        return text_chunks("WORKFLOW_CHILD_OK")
    if prompt == SNAPSHOT_PROMPT:
        assert_advertised_tool(body, "cordis_define")
        return tool_call_chunks(
            "advanced-define",
            "cordis_define",
            {
                "plugin": {"kind": "new", "idPrefix": "snap"},
                "name": "Snapshot Double",
                "purpose": "Expose a deterministic doubling tool for executable snapshot verification.",
                "code": {"host": SNAPSHOT_PLUGIN_CODE},
            },
        )
    if prompt == RESTART_FIRST_PROMPT:
        return text_chunks(RESTART_FIRST_TEXT)
    if prompt == RESTART_SECOND_PROMPT:
        if any(
            isinstance(message, dict)
            and RESTART_FIRST_TEXT in message_text(message.get("content"))
            for message in messages
        ):
            raise AssertionError("second isolated process inherited the first process history")
        return text_chunks(RESTART_SECOND_TEXT)
    if prompt == CODE_PROMPT:
        assert_advertised_tool(body, "run_code")
        return tool_call_chunks(
            "call-code-worker",
            "run_code",
            {"code": "return 6 * 7", "description": "Compute the smoke value"},
        )
    if prompt == WORKFLOW_PROMPT:
        assert_advertised_tool(body, "workflow")
        return tool_call_chunks(
            "call-workflow-worker",
            "workflow",
            {
                "script": "return 6 * 7",
                "meta": {
                    "name": "pkg-worker-smoke",
                    "description": "exercise the packaged workflow worker",
                },
            },
        )
    if prompt == FS_SEARCH_PROMPT:
        assert_advertised_tool(body, "grep")
        assert_advertised_tool(body, "glob")
        return tool_call_chunks(
            "fs-search-grep",
            "grep",
            {"pattern": FS_SEARCH_MARKER, "path": "."},
        )
    if prompt == SPAWN_NODE_PROMPT:
        assert_advertised_tool(body, MINIMAL_SHELL_TOOL)
        return tool_call_chunks(
            SPAWN_NODE_CALL_ID,
            MINIMAL_SHELL_TOOL,
            {"command": SPAWN_NODE_COMMAND, "description": "Report the reachable Node version"},
        )
    if prompt == MCP_PROMPT:
        assert_advertised_tool(body, "mcp__fixture__add")
        return tool_call_chunks(
            "mcp-add",
            "mcp__fixture__add",
            {"a": 19, "b": 23},
        )
    if prompt == PROFILE_PLUGIN_PROMPT:
        system_text = "\n".join(
            message_text(message.get("content"))
            for message in messages
            if isinstance(message, dict) and message.get("role") == "system"
        )
        if PROFILE_PLUGIN_MARKER not in system_text:
            raise AssertionError("external profile plugin contributed no model-visible marker")
        return text_chunks(PROFILE_PLUGIN_TEXT)
    return text_chunks(EXPECTED_TEXT)


def mcp_tool_followup(
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Verify one tool call through the packaged MCP client."""
    if call_id != "mcp-add":
        return None
    if tool_name != "mcp__fixture__add" or "42" not in tool_text:
        raise AssertionError(f"packaged MCP call returned an unexpected result: {tool_name}: {tool_text}")
    return text_chunks(MCP_TEXT)


def fs_search_tool_followup(
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Exercise both ripgrep-backed tools through the packaged executable."""
    if not call_id.startswith("fs-search-"):
        return None
    if call_id == "fs-search-grep" and tool_name == "grep":
        if "needle.txt" not in tool_text or FS_SEARCH_MARKER not in tool_text:
            raise AssertionError(f"packaged grep returned no marker: {tool_text}")
        return tool_call_chunks(
            "fs-search-glob",
            "glob",
            {"pattern": "**/*.txt"},
        )
    if call_id == "fs-search-glob" and tool_name == "glob":
        if "needle.txt" not in tool_text:
            raise AssertionError(f"packaged glob returned no fixture path: {tool_text}")
        return text_chunks(FS_SEARCH_TEXT)
    raise AssertionError(f"unexpected filesystem-search follow-up: {call_id} {tool_name}: {tool_text}")


def host_node_version() -> str:
    """The machine's own `node --version` line, the required shell resolution target."""
    node = shutil.which("node")
    if node is None:
        raise AssertionError("the spawn-node scenario requires Node on PATH for comparison")
    return subprocess.run(
        [node, "--version"], capture_output=True, text=True, check=True,
    ).stdout.strip()


def spawn_node_tool_followup(
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Verify the packaged shell reached the machine's Node with a clean environment."""
    if call_id != SPAWN_NODE_CALL_ID:
        return None
    if tool_name != MINIMAL_SHELL_TOOL:
        raise AssertionError(f"spawn-node follow-up used an unexpected tool: {tool_name}")
    expected = host_node_version()
    if expected not in tool_text:
        raise AssertionError(
            f"packaged shell did not reach the machine's node {expected}: {tool_text}"
        )
    if "PKG_EXECPATH=ABSENT" not in tool_text:
        raise AssertionError(f"PKG_EXECPATH reached the shell child environment: {tool_text}")
    return text_chunks(SPAWN_NODE_TEXT)


def minimal_tool_followup(
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Verify the checked-in minimal composition's persistent PTY."""
    if not call_id.startswith("minimal-"):
        return None
    if call_id == "minimal-bash-1" and tool_name == MINIMAL_SHELL_TOOL:
        if "COUNT=1" not in tool_text:
            raise AssertionError(f"first persistent shell call lost its output: {tool_text}")
        return tool_call_chunks(
            "minimal-bash-2",
            MINIMAL_SHELL_TOOL,
            {"command": MINIMAL_SHELL_COMMAND},
        )
    if call_id == "minimal-bash-2" and tool_name == MINIMAL_SHELL_TOOL:
        expected = f"COUNT=2 CWD={MINIMAL_SHELL_SECOND_CWD}"
        if expected.lower() not in tool_text.lower():
            raise AssertionError(f"persistent shell did not retain state: {tool_text}")
        return text_chunks(MINIMAL_TEXT)
    raise AssertionError(f"unexpected minimal-agent follow-up: {call_id} {tool_name}: {tool_text}")


def advanced_tool_followup(
    body: dict[str, object],
    call_id: str,
    tool_name: str,
    tool_text: str,
) -> list[dict[str, object]] | None:
    """Advance the executable snapshot's deterministic parent tool chain."""
    if not call_id.startswith("advanced-"):
        return None
    if call_id == "advanced-define" and tool_name == "cordis_define":
        if "Defined snap-1/pkg-1 (Snapshot Double)" not in tool_text:
            raise AssertionError(f"cordis_define returned no dynamic Package ids: {tool_text}")
        if "snapshot_double" in advertised_tool_names(body):
            raise AssertionError("snapshot_double was advertised before cordis_run")
        assert_advertised_tool(body, "cordis_run")
        return tool_call_chunks(
            "advanced-run",
            "cordis_run",
            {"pluginId": "snap-1", "packageId": "pkg-1", "mode": "run"},
        )
    if call_id == "advanced-run" and tool_name == "cordis_run":
        if "snap-1/pkg-1 is running (run-1)" not in tool_text:
            raise AssertionError(f"cordis_run returned no running Package ids: {tool_text}")
        assert_advertised_tool(body, "run_code")
        assert_advertised_tool(body, "snapshot_double")
        return tool_call_chunks(
            "advanced-code",
            "run_code",
            {
                "code": "return await tools.snapshot_double({ value: 21 })",
                "description": "Run the temporary Plugin tool",
            },
        )
    if call_id == "advanced-code" and tool_name == "run_code":
        if "42" not in tool_text:
            raise AssertionError(f"run_code returned no dynamic-tool value: {tool_text}")
        assert_advertised_tool(body, "subagent")
        return tool_call_chunks(
            "advanced-direct-child",
            "subagent",
            {
                "description": "Check direct child",
                "prompt": SNAPSHOT_DIRECT_CHILD_PROMPT,
            },
        )
    if call_id == "advanced-direct-child" and tool_name == "subagent":
        if "DIRECT_CHILD_OK" not in tool_text:
            raise AssertionError(f"subagent returned no expected child value: {tool_text}")
        assert_advertised_tool(body, "workflow")
        return tool_call_chunks(
            "advanced-workflow",
            "workflow",
            {
                "script": SNAPSHOT_WORKFLOW_SCRIPT,
                "meta": {
                    "name": "advanced-exe-snapshot",
                    "description": "exercise one packaged workflow child",
                },
            },
        )
    if call_id == "advanced-workflow" and tool_name == "workflow":
        if "WORKFLOW_CHILD_OK" not in tool_text:
            raise AssertionError(f"workflow returned no expected child value: {tool_text}")
        assert_advertised_tool(body, "cordis_undefine")
        return tool_call_chunks(
            "advanced-undefine",
            "cordis_undefine",
            {"pluginId": "snap-1"},
        )
    if call_id == "advanced-undefine" and tool_name == "cordis_undefine":
        if "Removed dynamic Plugin snap-1 and all of its Packages." not in tool_text:
            raise AssertionError(f"cordis_undefine returned no removal result: {tool_text}")
        if "snapshot_double" in advertised_tool_names(body):
            raise AssertionError("snapshot_double remained advertised after cordis_undefine")
        return text_chunks(SNAPSHOT_FINAL_TEXT)
    raise AssertionError(f"unexpected advanced tool follow-up: {call_id} {tool_name}: {tool_text}")


def text_chunks(text: str) -> list[dict[str, object]]:
    """Build a complete streaming text response."""
    return [
        {"choices": [{"delta": {"role": "assistant", "content": None, "reasoning_content": ""}}]},
        {"choices": [{"delta": {"content": text}}]},
        {
            "choices": [{"delta": {"content": ""}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 3},
        },
    ]


def tool_call_chunks(call_id: str, name: str, arguments: dict[str, object]) -> list[dict[str, object]]:
    """Build a complete streaming function-call response."""
    return [
        {"choices": [{"delta": {"role": "assistant", "content": None, "reasoning_content": ""}}]},
        {
            "choices": [{
                "delta": {
                    "tool_calls": [{
                        "index": 0,
                        "id": call_id,
                        "type": "function",
                        "function": {"name": name, "arguments": json.dumps(arguments)},
                    }],
                },
            }],
        },
        {
            "choices": [{"delta": {"content": ""}, "finish_reason": "tool_calls"}],
            "usage": {"prompt_tokens": 3, "completion_tokens": 3},
        },
    ]


def latest_tool_call(messages: list[object]) -> tuple[str, str]:
    """Find the assistant call id and name paired with the latest tool result."""
    for message in reversed(messages[:-1]):
        if not isinstance(message, dict):
            continue
        calls = message.get("tool_calls")
        if not isinstance(calls, list):
            continue
        for call in reversed(calls):
            if not isinstance(call, dict):
                continue
            function = call.get("function")
            call_id = call.get("id")
            if (
                isinstance(call_id, str)
                and isinstance(function, dict)
                and isinstance(function.get("name"), str)
            ):
                return call_id, function["name"]
    raise AssertionError(f"tool result has no preceding assistant tool call: {messages}")


def message_text(content: object) -> str:
    """Read OpenAI text content in either string or block-list form."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and isinstance(block.get("text"), str)
        )
    return ""


def advertised_tool_names(body: dict[str, object]) -> set[str]:
    """Return the model-facing tool names advertised on one request."""
    tools = body.get("tools")
    if not isinstance(tools, list):
        raise AssertionError(f"model request advertised no tools: {body}")
    names: set[str] = set()
    for tool in tools:
        if not isinstance(tool, dict):
            continue
        function = tool.get("function")
        if isinstance(function, dict) and isinstance(function.get("name"), str):
            names.add(function["name"])
    return names


def assert_advertised_tool(body: dict[str, object], expected: str) -> None:
    """Require the packaged deployment to expose the requested tool."""
    names = advertised_tool_names(body)
    if expected not in names:
        raise AssertionError(f"model request did not advertise {expected}: {names}")


class MockModel:
    def __enter__(self) -> "MockModel":
        MockModelHandler.requests.clear()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), MockModelHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address
        self.url = f"http://{host}:{port}"
        return self

    def __exit__(self, _exc_type: object, _exc: object, _tb: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--scenario",
        choices=("all", "sdk-default", "sdk-custom", "sdk-minimal", "sdk-minimal-in-history", "sdk-fs-search", "sdk-spawn-node", "sdk-mcp", "sdk-snapshot", "sdk-restart", "sdk-scope-route-recovery", "sdk-scope-context", "sdk-task-context-peer-facts", "sdk-task-context-semantic", "sdk-scope-native-contribution", "sdk-scope-owner-participation", "sdk-scope-dual-contribution", "sdk-scope-local-joint", "sdk-scope-group-join", "sdk-scope-capture-self-omission", "sdk-scope-prejoin-initialization", "sdk-scope-owner-idle", "sdk-scope-joint-automatic", "sdk-scope-semantic-idle", "sdk-scope-automatic-withdrawal", "sdk-profile-plugin", "sdk-live", "runner", "direct"),
        default="all",
    )
    parser.add_argument("--exe", type=Path)
    parser.add_argument(
        "--installed-wheel",
        action="store_true",
        help="require a clean virtual environment containing matching installed SDK and runtime wheels",
    )
    parser.add_argument("--update-snapshots", action="store_true")
    args = parser.parse_args()
    if args.installed_wheel and args.exe is not None:
        parser.error("--installed-wheel resolves the wheel's own runtime and cannot be combined with --exe")
    if args.scenario == "sdk-live" and not args.installed_wheel:
        parser.error("--scenario sdk-live requires --installed-wheel")
    if args.scenario == "sdk-profile-plugin" and not args.installed_wheel:
        parser.error("--scenario sdk-profile-plugin requires --installed-wheel")
    if args.installed_wheel:
        args.exe = assert_installed_wheel_environment()
    if args.scenario in {"all", "sdk-custom", "sdk-minimal", "sdk-minimal-in-history", "sdk-fs-search", "sdk-spawn-node", "sdk-snapshot", "sdk-restart", "sdk-scope-route-recovery", "sdk-scope-context", "sdk-task-context-peer-facts", "sdk-task-context-semantic", "sdk-scope-native-contribution", "sdk-scope-owner-participation", "sdk-scope-dual-contribution", "sdk-scope-local-joint", "sdk-scope-group-join", "sdk-scope-capture-self-omission", "sdk-scope-prejoin-initialization", "sdk-scope-owner-idle", "sdk-scope-joint-automatic", "sdk-scope-semantic-idle", "sdk-scope-automatic-withdrawal", "runner", "direct"} and args.exe is None:
        parser.error("--exe is required for custom, minimal, fs-search, spawn-node, snapshot, restart, scope-context, runner, and direct scenarios")
    if args.update_snapshots and args.scenario not in {"all", "sdk-minimal", "sdk-minimal-in-history", "sdk-snapshot", "sdk-restart", "sdk-scope-route-recovery", "sdk-scope-context", "sdk-task-context-peer-facts", "sdk-task-context-semantic", "sdk-scope-native-contribution", "sdk-scope-owner-participation", "sdk-scope-dual-contribution", "sdk-scope-local-joint", "sdk-scope-group-join", "sdk-scope-capture-self-omission", "sdk-scope-prejoin-initialization", "sdk-scope-owner-idle", "sdk-scope-joint-automatic", "sdk-scope-semantic-idle", "sdk-scope-automatic-withdrawal"}:
        parser.error("--update-snapshots requires --scenario sdk-minimal, sdk-minimal-in-history, sdk-snapshot, sdk-restart, sdk-scope-context, sdk-task-context-peer-facts, sdk-task-context-semantic, sdk-scope-native-contribution, sdk-scope-owner-participation, sdk-scope-dual-contribution, sdk-scope-local-joint, sdk-scope-group-join, sdk-scope-capture-self-omission, sdk-scope-prejoin-initialization, sdk-scope-owner-idle, sdk-scope-joint-automatic, sdk-scope-semantic-idle, sdk-scope-automatic-withdrawal, or all")
    if args.exe is not None and not args.exe.is_file():
        parser.error(f"runtime executable does not exist: {args.exe}")

    if args.scenario in {"all", "runner"}:
        assert args.exe is not None
        smoke_packaged_runner(args.exe.resolve())
    if args.scenario == "runner":
        print("smoke-python-runtime: runner passed")
        return

    if args.scenario == "sdk-live":
        smoke_sdk_live()
        print("smoke-python-runtime: sdk-live passed")
        return

    if args.scenario in {"sdk-scope-route-recovery", "sdk-scope-context", "sdk-task-context-peer-facts", "sdk-task-context-semantic", "sdk-scope-native-contribution", "sdk-scope-owner-participation", "sdk-scope-dual-contribution", "sdk-scope-local-joint", "sdk-scope-group-join", "sdk-scope-capture-self-omission", "sdk-scope-prejoin-initialization", "sdk-scope-owner-idle", "sdk-scope-joint-automatic", "sdk-scope-semantic-idle", "sdk-scope-automatic-withdrawal"}:
        assert args.exe is not None
        scenario = "scope-context-live" if args.scenario == "sdk-scope-context" else args.scenario.removeprefix("sdk-")
        smoke_sdk_scope_context(args.exe.resolve(), args.update_snapshots, scenario=scenario)
        print(f"smoke-python-runtime: {args.scenario} passed")
        return

    with MockModel() as model:
        if args.scenario in {"all", "sdk-default"}:
            smoke_sdk_default(model.url)
        if args.scenario in {"all", "sdk-custom"}:
            assert args.exe is not None
            smoke_sdk_custom(model.url, args.exe.resolve())
        if args.scenario in {"all", "sdk-minimal"}:
            assert args.exe is not None
            smoke_sdk_minimal(model.url, args.exe.resolve(), args.update_snapshots)
        if args.scenario in {"all", "sdk-minimal-in-history"}:
            assert args.exe is not None
            smoke_sdk_minimal(model.url, args.exe.resolve(), args.update_snapshots, in_history=True)
        if args.scenario in {"all", "sdk-fs-search"}:
            assert args.exe is not None
            smoke_sdk_fs_search(model.url, args.exe.resolve())
        if args.scenario in {"all", "sdk-spawn-node"}:
            assert args.exe is not None
            smoke_sdk_spawn_node(model.url, args.exe.resolve())
        if args.scenario in {"all", "sdk-mcp"}:
            smoke_sdk_mcp(model.url, None if args.exe is None else args.exe.resolve())
        if args.scenario in {"all", "sdk-snapshot"}:
            assert args.exe is not None
            smoke_sdk_snapshot(model.url, args.exe.resolve(), args.update_snapshots)
        if args.scenario in {"all", "sdk-restart"}:
            assert args.exe is not None
            smoke_sdk_restart_snapshot(model.url, args.exe.resolve(), args.update_snapshots)
        if args.installed_wheel and args.scenario in {"all", "sdk-profile-plugin"}:
            smoke_sdk_profile_plugin(model.url)
        if args.scenario in {"all", "direct"}:
            assert args.exe is not None
            smoke_direct(model.url, args.exe.resolve())
        if not MockModelHandler.requests:
            raise AssertionError("mock model endpoint received no requests")
    print(f"smoke-python-runtime: {args.scenario} passed")


def assert_installed_wheel_environment() -> Path:
    """Prove that this process imports matching non-editable wheel installations."""
    if sys.prefix == sys.base_prefix:
        raise AssertionError("installed-wheel smoke must run inside a virtual environment")
    if os.environ.get("PYTHONPATH"):
        raise AssertionError("installed-wheel smoke requires PYTHONPATH to be unset")
    if os.environ.get("DSH_RUNTIME_MODE"):
        raise AssertionError("installed-wheel smoke requires DSH_RUNTIME_MODE to be unset")

    repo_root = Path(__file__).resolve().parent.parent
    cwd = Path.cwd().resolve()
    if cwd.is_relative_to(repo_root):
        raise AssertionError(f"installed-wheel smoke must run outside the repository, got {cwd}")

    sdk_version = importlib.metadata.version("deepseek-harness-sdk")
    runtime_version = importlib.metadata.version("deepseek-harness-runtime-bin")
    if sdk_version != runtime_version:
        raise AssertionError(
            f"installed SDK/runtime versions differ: {sdk_version} != {runtime_version}"
        )
    expected_runtime_requirement = f"deepseek-harness-runtime-bin=={sdk_version}"
    requirements = importlib.metadata.requires("deepseek-harness-sdk") or []
    if expected_runtime_requirement not in requirements:
        raise AssertionError(
            f"installed SDK does not require {expected_runtime_requirement}: {requirements}"
        )

    prefix = Path(sys.prefix).resolve()
    imported: dict[str, Path] = {}
    for name in ("deepseek_harness", "deepseek_harness_runtime"):
        module = importlib.import_module(name)
        module_file = getattr(module, "__file__", None)
        if not isinstance(module_file, str):
            raise AssertionError(f"installed module {name} has no filesystem location")
        path = Path(module_file).resolve()
        if not path.is_relative_to(prefix):
            raise AssertionError(f"installed module {name} came from outside the virtual environment: {path}")
        if path.is_relative_to(repo_root):
            raise AssertionError(f"installed module {name} came from the repository checkout: {path}")
        imported[name] = path

    runtime_module = sys.modules["deepseek_harness_runtime"]
    executable = runtime_module.bundled_runtime_path().resolve()
    runtime_package = imported["deepseek_harness_runtime"].parent
    if not executable.is_relative_to(runtime_package):
        raise AssertionError(f"bundled runtime came from outside the installed runtime wheel: {executable}")
    runtime_files = importlib.metadata.files("deepseek-harness-runtime-bin") or []
    if not any(Path(file).name == executable.name for file in runtime_files):
        raise AssertionError(f"runtime executable is absent from installed distribution records: {executable}")
    return executable


def smoke_sdk_live() -> None:
    """Run a real-model, tool-using two-turn task through installed wheels."""
    from deepseek_harness import DeepSeekHarness

    api_key = os.environ.get("DEEPSEEK_API_KEY")
    base_url = os.environ.get("DEEPSEEK_BASE_URL")
    if not api_key:
        raise AssertionError("sdk-live requires DEEPSEEK_API_KEY")
    if not base_url:
        raise AssertionError("sdk-live requires an explicit DEEPSEEK_BASE_URL")

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-live-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        marker = root / "live-api-marker.txt"
        session_id = "installed-wheel-live-api"
        shell_tool = "pwsh" if IS_WINDOWS else "bash"
        create_prompt = (
            f"Use the {shell_tool} tool to create the file at the absolute path below with exact UTF-8 "
            f"content {LIVE_API_SENTINEL}, with no newline or byte-order mark. "
            f"Then reply with exactly {LIVE_API_SENTINEL}.\n{marker}"
        )
        with DeepSeekHarness(
            provider="deepseek-official",
            model="deepseek-v4-flash",
            cwd=str(root),
            dsh_home=str(dsh_home),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key=api_key,
            base_url=base_url,
            request_timeout_seconds=180,
        ) as harness:
            created = harness.run(create_prompt, session_id=session_id)
            assert_live_turn("create", created)
            if not marker.is_file():
                raise AssertionError(f"create turn did not create {marker}")
            if marker.read_bytes() != LIVE_API_SENTINEL.encode("utf-8"):
                raise AssertionError(f"create turn wrote unexpected bytes to {marker}")

            # The challenge is absent from the prior turn and the verification prompt.
            challenge = secrets.token_hex(32).encode("ascii")
            marker.write_bytes(challenge)
            with tempfile.TemporaryDirectory(prefix="receipt-", dir=root) as receipt_directory:
                receipt = Path(receipt_directory) / "receipt.txt"
                verify_prompt = (
                    "The file created in the previous turn has changed externally. "
                    "Use a tool to read that same file and copy its exact current content to the "
                    "new receipt path below, without changing the source file. "
                    "Preserve every byte; do not add a newline or byte-order mark. "
                    f"Then reply with exactly {LIVE_API_SENTINEL}.\n{receipt}"
                )
                verified = harness.run(verify_prompt, session_id=session_id)
                assert_live_turn("verify", verified)
                if not receipt.is_file():
                    raise AssertionError(f"verify turn did not create receipt {receipt}")
                if receipt.read_bytes() != challenge:
                    raise AssertionError(f"verify turn wrote unexpected bytes to receipt {receipt}")
                if not marker.is_file() or marker.read_bytes() != challenge:
                    raise AssertionError(f"verify turn changed source file {marker}")
        assert_zstd_session_log(sessions)


def assert_live_turn(label: str, result: RunResult) -> None:
    """Require completed model tool use and the exact smoke answer for each live turn."""
    if result.finish_reason != "completed":
        event_types = [event.get("type") for event in result.events]
        turn_end_data = next(
            (event.get("data") for event in reversed(result.events) if event.get("type") == "turn/end"),
            None,
        )
        turn_end = safe_turn_end(turn_end_data)
        raise AssertionError(
            f"{label} turn ended with {result.finish_reason!r}; "
            f"final={result.final_response!r}; turn_end={turn_end!r}; events={event_types}"
        )
    if not any(event.get("type") == "tool/call" for event in result.events):
        raise AssertionError(
            f"{label} turn made no model-requested tool call; "
            f"final={result.final_response!r}"
        )
    if result.final_response.strip() != LIVE_API_SENTINEL:
        raise AssertionError(f"{label} turn returned {result.final_response!r}")

def safe_turn_end(value: object) -> object:
    """Project a live-provider failure without retaining credential-bearing text."""
    if not isinstance(value, dict):
        return value
    reason = value.get("reason")
    if not isinstance(reason, dict):
        return {"turn": value.get("turn"), "reason": reason}
    error = reason.get("error")
    safe_error = None
    if isinstance(error, dict):
        safe_error = {
            key: error.get(key)
            for key in ("code", "status")
            if error.get(key) is not None
        }
    return {
        "turn": value.get("turn"),
        "reason": {
            "kind": reason.get("kind"),
            **({"error": safe_error} if safe_error is not None else {}),
        },
    }


def smoke_sdk_default(base_url: str) -> None:
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-default-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_home=str(dsh_home),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run("reply with the smoke text", session_id="default-smoke")
        assert result.final_response == EXPECTED_TEXT, (
            f"final={result.final_response!r} finish={result.finish_reason!r} "
            f"events={[event.get('type') for event in result.events]!r} "
            f"turn_end={safe_turn_end(next((event.get('data', event) for event in reversed(result.events) if event.get('type') == 'turn/end'), {}))!r}"
        )
        assert_zstd_session_log(sessions)


def smoke_sdk_custom(base_url: str, executable: Path) -> None:
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-custom-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_advanced_profile_patch(root, "custom.patch.yml", sessions)
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_bin=str(executable),
            dsh_home=str(dsh_home),
            patches=(str(patch),),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            text_result = harness.run("reply with the smoke text", session_id="custom-smoke")
            code_result = harness.run(CODE_PROMPT, session_id="custom-smoke")
            workflow_result = harness.run(WORKFLOW_PROMPT, session_id="custom-smoke")
        assert text_result.final_response == EXPECTED_TEXT, text_result.final_response
        assert code_result.final_response == CODE_WORKER_TEXT, code_result.final_response
        assert workflow_result.final_response == WORKFLOW_WORKER_TEXT, workflow_result.final_response
        assert_session_log(sessions, root, EXPECTED_TEXT, CODE_WORKER_TEXT, WORKFLOW_WORKER_TEXT)


def smoke_sdk_minimal(
    base_url: str, executable: Path, update_snapshots: bool, *, in_history: bool = False,
) -> None:
    """Exercise the shipped standalone minimal profile through the packaged executable."""
    from deepseek_harness import DeepSeekHarness

    # One mock model serves every scenario of a run, so the snapshot takes this turn's slice.
    first_request = len(MockModelHandler.requests)
    with tempfile.TemporaryDirectory(prefix="dsh-sdk-minimal-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patches = ()
        if in_history:
            patch = root / "in-history.patch.yml"
            patch.write_text(json.dumps([
                {"id": "llm-deepseek", "config": {"models": [
                    {"id": "smoke-model", "systemPromptUpdate": "in-history"},
                ]}},
                {"insert": [{
                    "id": "in-history-prompt",
                    "name": (Path(__file__).resolve().parent / "fixtures/python-sdk-in-history-prompt.mjs").as_uri(),
                }]},
            ]))
            patches = (str(patch),)
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_bin=str(executable),
            dsh_home=str(dsh_home),
            profile="sdk-minimal",
            patches=patches,
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(MINIMAL_PROMPT, session_id="minimal-agent-smoke")

        event_text = json.dumps(result.events)
        if MINIMAL_TEXT not in event_text:
            raise AssertionError(f"minimal agent run emitted no final response: {result.events}")
        assert_session_log(sessions, root, MINIMAL_TEXT, "COUNT=1", "COUNT=2")

        requests = MockModelHandler.requests[first_request:]
        if in_history:
            logs = read_session_logs(sessions)
            files = build_in_history_snapshot_files(result, requests, logs[result.session_id])
            compare_snapshot_files(
                files, update_snapshots, IN_HISTORY_SNAPSHOT_DIRECTORY, IN_HISTORY_SNAPSHOT_FILENAMES,
            )
        else:
            files = build_minimal_snapshot_files(requests, root)
            compare_snapshot_files(
                files, update_snapshots, MINIMAL_SNAPSHOT_DIRECTORY, MINIMAL_SNAPSHOT_FILENAMES,
            )


def smoke_sdk_scope_context(executable: Path, update_snapshots: bool, *, scenario: str) -> None:
    """Drive an explicitly selected scope recording through the real Python SDK and built dsh."""
    from deepseek_harness import DeepSeekHarness

    repository = Path(__file__).resolve().parent.parent
    helper = repository / "scripts/fixtures/python-scope-profile.ts"
    if scenario not in {"scope-route-recovery", "scope-context-live", "task-context-peer-facts", "task-context-semantic", "scope-native-contribution", "scope-owner-participation", "scope-dual-contribution", "scope-local-joint", "scope-group-join", "scope-capture-self-omission", "scope-prejoin-initialization", "scope-owner-idle", "scope-joint-automatic", "scope-semantic-idle", "scope-automatic-withdrawal"}:
        raise AssertionError(f"unsupported scope snapshot: {scenario}")
    expected_name = {
        "scope-automatic-withdrawal": "scope-automatic-withdrawal-capture-origin-evidence",
        "scope-dual-contribution": "scope-dual-contribution-capture-origin-evidence",
        "scope-group-join": "scope-group-join-capture-origin-evidence",
        "scope-joint-automatic": "scope-joint-automatic-capture-origin-evidence",
        "scope-local-joint": "scope-local-joint-capture-origin-evidence",
        "scope-native-contribution": "scope-native-contribution-capture-origin-evidence",
        "scope-owner-idle": "scope-owner-idle-capture-origin-evidence",
        "scope-owner-participation": "scope-owner-participation-capture-origin-evidence",
        "scope-semantic-idle": "scope-semantic-idle-recorded-origin-evidence",
        "task-context-semantic": "task-context-semantic-recorded-origin-evidence",
    }.get(scenario, scenario)
    expected = repository / "scripts/snapshots/python-sdk-single-exe" / expected_name
    node = shutil.which("node")
    if node is None:
        raise AssertionError("scope snapshot preparation requires the repository's supported Node runtime")

    def prepare(mode: str, root: Path, *extra: str) -> object:
        output = subprocess.run(
            [node, "--import", "tsx", str(helper), mode, scenario, str(root), *extra],
            cwd=repository, capture_output=True, text=True, check=True, timeout=60,
        )
        return json.loads(output.stdout)

    with tempfile.TemporaryDirectory(prefix="dsh-python-scope-") as temporary:
        root = Path(temporary).resolve()
        prepared = prepare("prepare", root)
        assert isinstance(prepared, dict)
        if scenario in {"scope-joint-automatic", "scope-automatic-withdrawal", "scope-dual-contribution", "scope-local-joint", "scope-group-join", "scope-capture-self-omission"}:
            shutil.copytree(repository / "snapshots/sdk" / scenario / "workspace", root, dirs_exist_ok=True)
        home = root / ".dsh"
        with DeepSeekHarness(
            provider="deepseek-official", model="deepseek-v4-flash", cwd=str(root),
            dsh_bin=str(executable), dsh_home=str(home), profile="sdk",
            patches=tuple(prepared["patches"]), request_timeout_seconds=110,
            env={
                "DSH_SNAPSHOT": "replay", "DSH_SNAPSHOT_FILE": prepared["replayFixture"],
                "DSH_SNAPSHOT_OVERRIDE": prepared["replayOverride"],
                "DSH_SNAPSHOT_PROVIDER": "deepseek-official", "DSH_SNAPSHOT_MODEL": "deepseek-v4-flash",
                "DSH_TELEMETRY_DISABLED": "1", "DSH_AGENTS_HOME": str(root / ".agents"),
            },
        ) as harness:
            session = harness.start_session("fixture-root-session")
            if scenario == "task-context-peer-facts":
                turns = [session.run(prompt) for prompt in (
                    "Inspect the current peer-reported API declarations.",
                    "Continue after the peer corrects the declarations.",
                    "Continue after the peer reports an invalid artifact.",
                    "Continue after the owner revokes the peer contribution.",
                )]
            elif scenario == "task-context-semantic":
                turns = [session.run(prompt) for prompt in (
                    "Inspect the authorized peer Write report.",
                    "Inspect the peer Edit report for the second file.",
                    "Inspect the reported failed Write without assuming success.",
                    "Continue after the owner revokes the tool contribution.",
                )]
            elif scenario == "scope-automatic-withdrawal":
                first, last, observed = run_finite_scope_turns(
                    harness, session,
                    first_prompt="Retain my existing local responsibility before joining any shared scope.",
                    last_prompt="Continue my ordinary local work after the owner has revoked shared reading.",
                    expected_automatic_reason="blocked",
                )
            elif scenario == "scope-semantic-idle":
                first, last, observed = run_finite_scope_turns(
                    harness, session,
                    first_prompt="Join the shared Task and observe authorized implementation reports.",
                    last_prompt="Finish this verification and leave the Task.", completed_turn=5,
                )
            elif scenario in {"scope-owner-idle", "scope-joint-automatic"}:
                first_prompt, last_prompt = (
                    ("Authorize bounded owner work for the connected local Task.", "Continue after leaving the local Task.")
                    if scenario == "scope-owner-idle" else
                    ("Authorize one response to the joined scope under my existing read-only permission.",
                     "Pause the original permission and leave this joined scope.")
                )
                first, last, observed = run_finite_scope_turns(
                    harness, session, first_prompt=first_prompt, last_prompt=last_prompt,
                    coverage_revision=6 if scenario == "scope-owner-idle" else None,
                )
            elif scenario == "scope-prejoin-initialization":
                turns = [session.run(prompt) for prompt in (
                    "Record my permitted local work before joining any shared goal.",
                    "Request sharing of my recorded observations and continue while approval is pending.",
                    "Use the approved historical context without rereading files.",
                    "Publish a subsequent live change within my original responsibility.",
                    "Use the other member’s newly approved work.",
                    "Leave the shared goal and continue my original local work.",
                )]
            elif scenario == "scope-capture-self-omission":
                turns = [session.run(prompt) for prompt in (
                    "Retain my original local responsibility before joining the shared goal.",
                    "Join the shared goal and publish my permitted implementation.",
                    "Read independent changes without repeating my own capture.",
                    "Stop only my contribution and inspect the retained receiving permission.",
                    "Leave the shared goal and continue my original local work.",
                )]
            elif scenario == "scope-group-join":
                turns, observed = run_group_join_turns(harness, session)
            elif scenario == "scope-local-joint":
                turns, observed = run_local_joint_turns(harness, session)
            elif scenario == "scope-dual-contribution":
                turns = [session.run(prompt) for prompt in (
                    "Continue my existing local responsibility before sharing any tool reports.",
                    "Share this permitted Write with the remote owner while retaining my local Task.",
                    "Stop remote sharing and continue writing for my local Task.",
                    "Stop local collection while keeping my local Task and history.",
                )]
            elif scenario == "scope-owner-participation":
                turns = [session.run(prompt) for prompt in (
                    "Use the peer update and write the owner result.",
                    "Continue after stopping owner sharing.",
                    "Continue after stopping peer sharing.",
                )]
            elif scenario == "scope-native-contribution":
                turns = [session.run(prompt) for prompt in (
                    "Inspect the native source's client and guide changes.",
                    "Inspect the failed native Edit without assuming success.",
                    "Continue after the owner revokes native contribution.",
                )]
            else:
                first, last, observed = run_native_scope_turns(harness, session)
        logs = read_session_logs(home / "sessions")
        records = logs[session.id]
        if scenario == "task-context-peer-facts":
            result = peer_facts_snapshot_result(records, turns)
        elif scenario == "task-context-semantic":
            audits = read_session_logs(home / "semantic-audit")
            if set(audits) != {"task-context-semantic-audit"}:
                raise AssertionError("semantic runtime must retain one separately owned auxiliary audit Session")
            result = semantic_snapshot_result(records, turns, audits["task-context-semantic-audit"])
        elif scenario == "scope-semantic-idle":
            audits = read_session_logs(home / "semantic-audit")
            if set(audits) != {"scope-semantic-idle-audit"}:
                raise AssertionError("semantic idle run must retain its separate auxiliary audit")
            result = semantic_idle_snapshot_result(records, first, last, observed, audits["scope-semantic-idle-audit"])
        elif scenario == "scope-automatic-withdrawal":
            result = automatic_withdrawal_snapshot_result(records, first, last, observed)
            expected_workspace = repository / "snapshots/sdk" / scenario / "workspace.expected"
            sentinel = "permission-sentinel.txt"
            if (root / sentinel).read_bytes() != (expected_workspace / sentinel).read_bytes():
                raise AssertionError("revoked automatic work changed the read-only workspace file")
        elif scenario == "scope-owner-idle":
            result = owner_idle_snapshot_result(records, first, last, observed)
        elif scenario == "scope-joint-automatic":
            result = joint_automatic_snapshot_result(records, first, last, observed)
            expected_workspace = repository / "snapshots/sdk" / scenario / "workspace.expected"
            sentinel = "permission-sentinel.txt"
            if (root / sentinel).read_bytes() != (expected_workspace / sentinel).read_bytes():
                raise AssertionError("automatic response changed the read-only workspace file")
        elif scenario == "scope-prejoin-initialization":
            result = prejoin_initialization_snapshot_result(records, turns, json.loads((home / "prejoin-initialization-audit.json").read_text()))
            expected_workspace = repository / "snapshots/sdk" / scenario / "workspace.expected"
            for expected_file in expected_workspace.rglob("*"):
                if expected_file.is_file() and (root / expected_file.relative_to(expected_workspace)).read_bytes() != expected_file.read_bytes():
                    raise AssertionError("initialization changed the expected B workspace result")
        elif scenario == "scope-capture-self-omission":
            result = capture_self_snapshot_result(records, turns, json.loads((home / "capture-self-audit.json").read_text()))
            expected_workspace = repository / "snapshots/sdk" / scenario / "workspace.expected"
            for expected_file in expected_workspace.rglob("*"):
                if expected_file.is_file() and (root / expected_file.relative_to(expected_workspace)).read_bytes() != expected_file.read_bytes():
                    raise AssertionError("capture omission changed the expected B workspace result")
        elif scenario == "scope-group-join":
            result = group_join_snapshot_result(records, turns, observed, json.loads((home / "group-join-audit.json").read_text()))
            expected_workspace = repository / "snapshots/sdk" / scenario / "workspace.expected"
            for expected_file in expected_workspace.rglob("*"):
                if expected_file.is_file() and (root / expected_file.relative_to(expected_workspace)).read_bytes() != expected_file.read_bytes():
                    raise AssertionError("group join changed the expected B workspace result")
        elif scenario == "scope-local-joint":
            result = local_joint_snapshot_result(records, turns, observed, json.loads((home / "local-joint-audit.json").read_text()))
            expected_workspace = repository / "snapshots/sdk" / scenario / "workspace.expected"
            for expected_file in expected_workspace.rglob("*"):
                if expected_file.is_file() and (root / expected_file.relative_to(expected_workspace)).read_bytes() != expected_file.read_bytes():
                    raise AssertionError("local joint work changed the expected workspace result")
        elif scenario == "scope-dual-contribution":
            result = dual_contribution_snapshot_result(records, turns)
            expected_workspace = repository / "snapshots/sdk" / scenario / "workspace.expected"
            for expected_file in expected_workspace.rglob("*"):
                if expected_file.is_file() and (root / expected_file.relative_to(expected_workspace)).read_bytes() != expected_file.read_bytes():
                    raise AssertionError("dual contribution changed the expected local workspace result")
        elif scenario == "scope-owner-participation":
            result = owner_participation_snapshot_result(records, turns)
        elif scenario == "scope-native-contribution":
            result = native_contribution_snapshot_result(records, turns)
        else:
            result = native_scope_snapshot_result(records, first, last, observed)
            if scenario == "scope-route-recovery":
                routes = [event["data"] for event in records if event.get("type") == "scope-agent-context/route"]
                wire_routes = [event["data"] for event in observed if event.get("type") == "scope-agent-context/route"]
                if len(routes) != 1 or routes != wire_routes:
                    raise AssertionError("Python must retain the exact durable route event during the automatic turn")
                route = routes[0]
                result["routeRecovery"] = {"routeRevision": route["subscription"]["routeRevision"],
                                           "ownerAddress": route["subscription"]["invitation"]["ownerAddress"],
                                           "wirePreservesRouteEvent": True}

        session_files = latest_persisted_session_paths(home / "sessions")
        if len(session_files) != 1:
            raise AssertionError(f"scope runtime expected one persisted Session, found {len(session_files)}")
        normalized_result = prepare("normalize", root, str(session_files[0]))
        assert isinstance(normalized_result, dict)
        if not normalized_result["equivalent"]:
            diff = "".join(difflib.unified_diff(normalized_result["reference"].splitlines(keepends=True),
                                            normalized_result["comparison"].splitlines(keepends=True)))
            raise AssertionError("TypeScript and Python runtimes produced different native Session events\n" + diff)
        normalized = normalized_result["session"]
        compare_snapshot_files({"result.json": json.dumps(result, indent=2) + "\n", "session.v3.jsonl": normalized},
                               update_snapshots, expected, ("result.json", "session.v3.jsonl"))


def prejoin_initialization_snapshot_result(
    records: list[dict[str, object]], turns: list[RunResult], audit: dict[str, object],
) -> dict[str, object]:
    """Verify recorded-work consent and exact frozen requests from three actual Hosts."""
    members = {item["key"]: item for item in audit["members"]}
    b, c = members["b"], members["c"]
    coverage = audit["initialization"]["coverage"]
    if coverage != {"recorded": 5, "selected": 4, "omitted": 1, "unconfirmed": 0, "inFlight": 0, "acknowledged": 4}:
        raise AssertionError("historical selection and real owner receipts must describe the same fixed coverage")
    if audit["hostCount"] != 3 or audit["executingSessionCount"] != 2 or audit["fileOperations"]:
        raise AssertionError("three real Hosts initialize recorded observations without reading or scanning files")
    historical = next(item for item in c["requests"] if item["phase"] == "historical")["remoteText"]
    latest = next(item for item in c["requests"] if item["phase"] == "latest")["remoteText"]
    if "B_RECORDED_V2" not in historical or "B_BEFORE_APPROVAL" not in historical or "failure" not in historical:
        raise AssertionError("C must receive completed Write/Edit/failure evidence recorded before owner approval")
    if "B_LIVE_LATEST" not in latest:
        raise AssertionError("subsequent live work must supersede historical evidence")
    for member in members.values():
        for request in member["requests"]:
            if request["bytes"] > 12000:
                raise AssertionError("full local and framed remote context exceeds its byte budget")
            remote = request.get("remoteText") or ""
            if any(marker in remote for marker in ("C_PREJOIN_NOT_CONSENTED", "B_PRIVATE_NOT_SHARED", "DISK_ONLY_UNRECORDED")):
                raise AssertionError("unapproved history, private roots, and unrecorded disk contents cannot enter remote context")
    if b["state"]["binding"]["kind"] != "local-task" or c["state"]["binding"]["kind"] != "local-task-scope":
        raise AssertionError("B leaves only remote collaboration while C stays connected")
    if len(turns) != 6 or [event["data"]["name"] for event in records if event.get("type") == "tool/call"] != [
        "write", "edit", "edit", "write", "write", "read", "write", "write",
    ]:
        raise AssertionError("real production tools must execute without recall or historical re-execution")
    return {"turns": len(turns), "finalResponse": turns[-1].final_response, "coverage": coverage,
            "hostCount": 3, "executingSessionCount": 2,
            "requestCounts": {key: len(item["requests"]) for key, item in members.items()},
            "contextBytes": {key: [request["bytes"] for request in item["requests"]] for key, item in members.items()},
            "noFileScan": True, "noConsentHistoryOmitted": True, "localTaskRetained": True,
            "subsequentLiveWorkVisible": True, "otherMemberContinues": True}


def capture_self_snapshot_result(
    records: list[dict[str, object]], turns: list[RunResult], audit: dict[str, object],
) -> dict[str, object]:
    """Check exact source omission, same-peer Sessions, and independent stop/leave from the native request audit."""
    members = {item["key"]: item for item in audit["members"]}
    b, c1, c2 = members["b"], members["c1"], members["c2"]
    if (c1["peerId"] != c2["peerId"] or c1["capture"] == c2["capture"] or
            len({item["localTaskId"] for item in members.values()}) != 3):
        raise AssertionError("same peer must retain distinct actual Sessions, captures, and local Tasks")
    markers = {"b": "B_OWN_REPORT_", "c1": "C1_INDEPENDENT_REPORT", "c2": "C2_SAME_PEER_OTHER_SESSION"}
    for key, member in members.items():
        if member["state"]["usedBudget"] != 0:
            raise AssertionError("passive joining must not grant automatic work")
        for request in member["requests"]:
            if request["bytes"] > 8000:
                raise AssertionError("complete local plus framed remote context exceeds its byte budget")
            if request.get("remoteForm") == "snapshot":
                projection = request["projection"]
                if (projection["version"] != 3 or projection["peerCapture"]["captureId"] != member["capture"]["captureId"] or
                        projection["peerCapture"]["captureGeneration"] != member["capture"]["captureGeneration"] or
                        markers[key] in request["remoteText"]):
                    raise AssertionError("remote snapshot must omit only its exact authorized capture")
    c1_cross = next(item for item in c1["requests"] if item["phase"] == "cross-read")
    if markers["c2"] not in c1_cross["remoteText"] or markers["b"] not in c1_cross["remoteText"]:
        raise AssertionError("same-peer other Session and different-peer reports must both survive")
    b_cross = next(item for item in b["requests"] if item["phase"] == "turn-3-step-1")
    if any(markers[key] not in b_cross["remoteText"] for key in ("c1", "c2")):
        raise AssertionError("B must retain both independent source reports")
    stopped = next(item for item in b["requests"] if item["phase"] == "stopped")
    if not any(item["reason"] == "withdrawn" for item in stopped["projection"]["omittedSources"]):
        raise AssertionError("stopping collection must retain withdrawal evidence in adopted reading")
    if b["state"]["binding"]["kind"] != "local-task" or any(item["state"]["binding"]["kind"] != "local-task-scope" for item in (c1, c2)):
        raise AssertionError("B leave must preserve its local task and both other members")
    if "C2_AFTER_B_LEFT" not in c1["requests"][-1]["remoteText"]:
        raise AssertionError("C1 must receive C2 changes after B leaves")
    calls = [event["data"]["name"] for event in records if event.get("type") == "tool/call"]
    if calls != ["write"] * 3 or len(turns) != 5:
        raise AssertionError("B must execute five ordinary turns and three real Writes without recall")
    applications = {item["proposal"]["captureId"]: item for item in audit["applications"]}
    if (applications[b["capture"]["captureId"]]["result"]["readState"] != "active" or
            any(applications[item["capture"]["captureId"]]["result"]["status"] != "approved" for item in (c1, c2))):
        raise AssertionError("local leave and owner grant revocation remain distinct")
    return {"turns": len(turns), "finalResponse": turns[-1].final_response,
            "requestCounts": {key: len(item["requests"]) for key, item in members.items()},
            "contextBytes": {key: [request["bytes"] for request in item["requests"]] for key, item in members.items()},
            "exactOwnCaptureOmitted": True, "samePeerOtherSessionVisible": True,
            "ownerSourceRetained": any(markers["b"] in item["text"] for item in audit["ownerPublications"]),
            "withdrawalRetained": True, "otherMembersContinue": True, "bOwnerReadState": "active"}


def run_group_join_turns(
    harness: DeepSeekHarness, session: Session,
) -> tuple[list[RunResult], list[dict[str, object]]]:
    """Drive three owner prompts and wait for the three actual bounded automatic turns."""
    with harness.client.subscribe_session_notifications(session.id) as subscription:
        deadline = threading.Timer(110, harness.close)
        deadline.start()
        observed: list[dict[str, object]] = []

        def wait_completed(turn: int) -> None:
            while True:
                notification = subscription.next()
                if notification.method != "session.event":
                    continue
                event = notification.payload.get("event")
                if not isinstance(event, dict):
                    continue
                observed.append(event)
                if event.get("type") == "turn/end" and event["data"]["turn"] == turn:
                    if event["data"]["reason"] != {"kind": "completed"}:
                        raise AssertionError(f"group join turn {turn} did not complete")
                    return

        try:
            first = session.run("Continue my existing B responsibility and save my local baseline.")
            if first.finish_reason != "completed":
                raise AssertionError("group join setup failed before automatic work")
            wait_completed(2)
            joined = session.run("Join the shared goal with C while preserving my local Task and allowing two more automatic responses.")
            if joined.finish_reason != "completed":
                raise AssertionError("group join approval failed before automatic work")
            wait_completed(5)
            last = session.run("Leave the group scope and finish my local work while C stays joined.")
            wait_completed(6)
        finally:
            deadline.cancel()
            deadline.join()
    return [first, joined, last], observed


def run_local_joint_turns(
    harness: DeepSeekHarness, session: Session,
) -> tuple[list[RunResult], list[dict[str, object]]]:
    """Drive three owner prompts and wait for the three actual bounded automatic turns."""
    with harness.client.subscribe_session_notifications(session.id) as subscription:
        deadline = threading.Timer(110, harness.close)
        deadline.start()
        observed: list[dict[str, object]] = []

        def wait_completed(turn: int) -> None:
            while True:
                notification = subscription.next()
                if notification.method != "session.event":
                    continue
                event = notification.payload.get("event")
                if not isinstance(event, dict):
                    continue
                observed.append(event)
                if event.get("type") == "turn/end" and event["data"]["turn"] == turn:
                    if event["data"]["reason"] != {"kind": "completed"}:
                        raise AssertionError(f"local joint turn {turn} did not complete")
                    return

        try:
            first = session.run("Continue my existing client responsibility and save the local baseline.")
            if first.finish_reason != "completed":
                raise AssertionError("local joint setup failed before automatic work")
            wait_completed(2)
            joined = session.run("Join the API owner while retaining my local Task and approve two further automatic responses.")
            if joined.finish_reason != "completed":
                raise AssertionError("local joint approval failed before automatic work")
            wait_completed(5)
            last = session.run("Leave the shared scope and finish my local work.")
            wait_completed(6)
        finally:
            deadline.cancel()
            deadline.join()
    return [first, joined, last], observed


def local_joint_snapshot_result(
    records: list[dict[str, object]], turns: list[RunResult], observed: list[dict[str, object]],
    audit: dict[str, object], *, remote_marker: str = "REMOTE_API",
) -> dict[str, object]:
    """Verify retained local responsibility, both frozen request inputs and monotonic automatic allowance."""
    ends = [event["data"] for event in records if event.get("type") == "turn/end"]
    if ends != [{"turn": turn, "reason": {"kind": "completed"}} for turn in range(1, 7)]:
        raise AssertionError("local joint scenario must complete six actual turns")
    users, pulses, active_turn = [], [], None
    for event in records:
        if event.get("type") == "turn/start":
            active_turn = event["data"]["turn"]
        if event.get("type") == "user/message":
            source = event["data"]["source"]
            if source["kind"] == "user":
                users.append(active_turn)
            if source["kind"] == "scope-agent-pulse":
                pulses.append(active_turn)
    if users != [1, 3, 6] or pulses != [2, 4, 5]:
        raise AssertionError("only local response and two joined responses may run automatically")
    calls = [event["data"] for event in records if event.get("type") == "tool/call"]
    if [item["name"] for item in calls] != ["write"] * 4:
        raise AssertionError("local joint work must execute four real Writes without recall")
    dispatches = [event for event in records if event.get("type") == "scope-agent-context/request"]
    expected = [(2, 1, 2), (4, 1, 4), (4, 2, 4), (5, 1, 4), (5, 2, 4)]
    if [(item["data"]["turn"], item["data"]["step"], item["data"]["version"]) for item in dispatches] != expected:
        raise AssertionError("automatic requests must retain one local and four composite evidence anchors")
    wire_dispatches = [event["data"] for event in observed if event.get("type") == "scope-agent-context/request"]
    if wire_dispatches != [event["data"] for event in dispatches]:
        raise AssertionError("Python notifications lost exact request evidence")
    by_seq = {event["seq"]: event for event in records if "seq" in event}
    budgets = []
    for event in dispatches[1:]:
        request = event["data"]
        remote = by_seq[request["contextSeq"]]["data"]
        local = by_seq[request["localContextSeq"]]["data"]
        projection = request["projection"]
        if (request["contextSeq"] == request["localContextSeq"] or
                remote["source"]["kind"] != "scope-agent-context" or
                local["source"]["kind"] != "development-task-context" or
                projection["remote"] != remote["source"]["projection"] or
                projection["local"] != local["source"]["projection"]):
            raise AssertionError("composite evidence must identify both exact model-visible contexts")
        byte_count = sum(len(block["text"].encode("utf-8")) for message in (local, remote)
                         for block in message["content"] if block["type"] == "text")
        if byte_count > 8000 or request["maxContextBytes"] != 8000:
            raise AssertionError("combined local and remote messages exceeded the complete text budget")
        budgets.append(byte_count)
        text = "\n".join(block["text"] for block in remote["content"] if block["type"] == "text")
        expected_version = 2 if request["turn"] == 5 else 1
        if f"{remote_marker}_V{expected_version}" not in text or (expected_version == 2 and f"{remote_marker}_V1" in text):
            raise AssertionError("the current API correction must supersede its predecessor")
    joins = [event["data"] for event in records if event.get("type") == "scope-agent-context/join-read"]
    adopted = [item for item in joins if item["phase"] == "adopted"]
    if len(adopted) != 1 or adopted[0]["version"] != 4:
        raise AssertionError("one owner approval must adopt one combined local and remote interval")
    plan = adopted[0]["plan"]
    states = [event["data"] for event in records if event.get("type") == "scope-agent-context/state"]
    final = audit["state"]
    if (final["binding"]["kind"] != "local-task" or final["binding"]["id"] != plan["retainedLocal"]["bindingId"] or
            final["binding"]["target"] != plan["target"] or final["automatic"] != plan["retainedLocal"]["automatic"] or
            final["automatic"]["activationLimit"] != 4 or final["mode"] != "paused" or
            final["usedBudget"] != 3 or final["pendingActivation"] is not None):
        raise AssertionError("departure must restore the original paused local policy without refunding work")
    if (joins[-1]["phase"] != "ended" or joins[-1]["leaveAdopted"] is not True or joins[-1]["plan"] != plan or
            states[-1]["usedBudget"] != final["usedBudget"] or
            audit["localCapture"] != audit["originalLocalCapture"] or audit["localCaptureCollecting"] is not True or
            audit["localAssignment"]["taskId"] != plan["target"]["taskId"] or
            audit["localAssignment"]["bindingId"] != plan["target"]["taskBindingId"] or
            audit["localAssignment"]["expectedBindingEpoch"] != plan["target"]["bindingEpoch"]):
        raise AssertionError("joint departure must preserve the original capture and exact local assignment")
    if plan["automatic"]["activationLimit"] != 3 or plan["expectedBindingId"] == final["binding"]["id"]:
        raise AssertionError("joint allowance is an absolute total and departure requires a new local interval")
    final_start = next(event["seq"] for event in records if event.get("type") == "turn/start" and event["data"]["turn"] == 6)
    final_contexts = [event["data"] for event in records if event.get("type") == "user/message"
                      and event["seq"] > final_start and event["data"]["source"]["kind"] in
                      {"development-task-context", "scope-agent-context"}]
    if any(f"{remote_marker}_V{version}" in block["text"] for message in final_contexts for block in message["content"]
           if block["type"] == "text" for version in (1, 2, 3)):
        raise AssertionError("departed context retained remote API facts")
    authority = [event for event in records if event.get("type") in {"permission/preset", "sandbox/mode", "approval/policy"}]
    if len(authority) != 3:
        raise AssertionError("joining must retain the original Session authority")
    return {
        "responses": [{"text": item.final_response, "finishReason": item.finish_reason} for item in turns],
        "completedTurns": [item["turn"] for item in ends], "userTurns": users, "automaticTurns": pulses,
        "writeCalls": [item["callId"] for item in calls], "automaticRequestVersions": [item[2] for item in expected],
        "combinedContextBytes": budgets, "wirePreservesRequestEvidence": True,
        "joinAdoptions": 1, "jointAbsoluteLimit": 3, "restoredLocalLimit": 4,
        "finalMode": final["mode"], "usedBudget": final["usedBudget"], "originalAuthorityEvents": len(authority),
        "retainedOriginalTask": True, "restoredNewLocalInterval": True, "remoteFactsAfterLeave": [],
    }


def group_join_snapshot_result(
    records: list[dict[str, object]], turns: list[RunResult], observed: list[dict[str, object]],
    audit: dict[str, object],
) -> dict[str, object]:
    """Validate independent B/C authorization and passive C requests after B leaves the shared goal."""
    result = local_joint_snapshot_result(records, turns, observed, audit, remote_marker="C_SHARED")
    activations = {event["data"]["activationId"]: event["data"] for event in records
                   if event.get("type") == "scope-agent-context/evaluation" and event["data"]["decision"] == "activate"}
    for event in records:
        if event.get("type") != "scope-agent-context/request" or event["data"]["turn"] not in (4, 5):
            continue
        request = event["data"]
        candidate = activations[request["activationId"]]["projection"]["remote"]["text"]
        if f"C_SHARED_V{request['turn'] - 3}" not in candidate or (request["turn"] == 5 and "C_SHARED_V1" in candidate):
            raise AssertionError("B automatic reservation must already be caused by the independent current C update")
    entry = audit["entry"]
    applications = audit["applications"]
    if (entry["entry"]["kind"] != "scope-group-entry" or entry["entry"]["version"] != 2 or
            entry["entry"]["maxMembers"] != 2 or entry["state"] != "closed" or entry["applicationCount"] != 2):
        raise AssertionError("one explicitly reusable entry must retain two applicants after it closes")
    if len(applications) != 2 or len({item["applicationId"] for item in applications}) != 2:
        raise AssertionError("B and C require distinct retained applications")
    by_peer = {item["proposal"]["contributorPeerId"]: item for item in applications}
    b, c = by_peer[audit["bPeer"]], by_peer[audit["cPeer"]]
    if (b["result"]["status"] != "ended" or b["result"]["reason"] != "left" or
            b["result"]["readState"] != "active" or c["result"]["status"] != "approved" or
            c["result"]["readState"] != "active"):
        raise AssertionError("B departure must retain C independent active contribution and read permission: " +
                                 repr([{key: member["result"].get(key) for key in ("status", "reason", "readState")} for member in (b, c)]))
    if (any(item["entry"] != entry["entry"] for item in applications) or
            len({item["result"]["invitation"]["grant"]["grantId"] for item in applications}) != 2 or
            len({item["result"]["readInvitation"]["grantId"] for item in applications}) != 2):
        raise AssertionError("same-entry approvals must issue separate exact read and contribution grants")
    if (audit["bSubscription"]["state"] != "left" or audit["cSubscription"]["state"] != "active" or
            audit["bSubscription"]["invitation"]["grantId"] != b["result"]["readInvitation"]["grantId"]):
        raise AssertionError("B must end its exact subscription while C remains subscribed")
    c_state = audit["cState"]
    if (c_state["binding"]["kind"] != "local-task-scope" or c_state["automatic"] is not None or
            c_state["mode"] != "passive" or c_state["usedBudget"] != 0 or
            c_state["binding"]["target"]["taskId"] in {audit["sharedTaskId"], audit["state"]["binding"]["target"]["taskId"]} or
            audit["cLocalCapture"] != audit["cOriginalLocalCapture"]):
        raise AssertionError("C must retain its original different local Task and passive permission")
    if audit["cTurns"] != [{"turn": turn, "reason": {"kind": "completed"}} for turn in range(1, 5)]:
        raise AssertionError("passive C must execute exactly its four ordinary user turns")
    c_requests = audit["cRequests"]
    if [(item["turn"], item["step"]) for item in c_requests] != [(turn, step) for turn in range(1, 5) for step in (1, 2)]:
        raise AssertionError("C must make eight actual requests through the native AgentLoop")
    for item in c_requests:
        if item["bytes"] > 8000:
            raise AssertionError("passive C also requires one complete combined context budget")
        text = item["remoteText"]
        if item["turn"] == 3 and "B_SHARED_V1" not in text:
            raise AssertionError("C requests must contain the real independently published B Write")
        if item["turn"] == 4 and any(marker in text for marker in ("B_SHARED_V1", "B_SHARED_V2")):
            raise AssertionError("C kept B facts after that member left")
    result["group"] = {
        "entryVersion": 2, "entryState": entry["state"], "retainedApplications": 2,
        "separateContributionGrants": 2, "separateReadGrants": 2,
        "memberOutcomes": [b["result"]["status"], c["result"]["status"]],
        "bSubscriptionState": audit["bSubscription"]["state"], "cSubscriptionState": audit["cSubscription"]["state"],
        "bOwnerReadGrantState": b["result"]["readState"],
        "cMode": c_state["mode"], "cUsedBudget": c_state["usedBudget"],
        "cOrdinaryTurns": [item["turn"] for item in audit["cTurns"]],
        "cCombinedContextBytes": [item["bytes"] for item in c_requests],
        "cActualRequests": 8, "bActualRequests": 10, "totalControlledRequests": 18,
        "retainedDistinctLocalTasks": True, "cReceivesBWrite": True, "bReceivesCWrite": True,
        "cContinuesAfterBLeave": True, "cRemoteBFactsAfterLeave": [], "cChangesPrecedeBActivations": True,
    }
    return result


def run_native_scope_turns(harness: DeepSeekHarness, session: Session) -> tuple[RunResult, RunResult, list[dict[str, object]]]:
    """Preserve the native automatic-turn smoke's prompt and notification ordering."""
    with harness.client.subscribe_session_notifications(session.id) as subscription:
        # Closing the owned process bounds an event wait if the automatic turn never arrives.
        deadline = threading.Timer(110, harness.close)
        deadline.start()
        completed = False
        suppressed = []
        try:
            first = session.run("Inspect the current shared API declaration.")
            observed = []
            while True:
                notification = subscription.next()
                if notification.method != "session.event":
                    continue
                event = notification.payload.get("event")
                if not isinstance(event, dict):
                    continue
                observed.append(event)
                if event.get("type") == "turn/end" and event["data"]["turn"] == 2:
                    completed = True
                if event.get("type") == "scope-agent-context/evaluation" and event["data"]["decision"] == "suppress-unchanged":
                    suppressed.append(event["data"]["projection"]["taskRevision"])
                if completed and suppressed == [4, 5]:
                    break
            last = session.run("Continue after leaving the shared scope.")
        except Exception as error:
            raise AssertionError(f"native scope driver expected completed automatic turn and suppressions [4, 5]; completed={completed}, suppressed={suppressed}") from error
        finally:
            deadline.cancel()
            deadline.join()
    return first, last, observed


def native_scope_snapshot_result(
    records: list[dict[str, object]], first: RunResult, last: RunResult, observed: list[dict[str, object]],
) -> dict[str, object]:
    """Check native automatic admission, replacement, and leave before snapshot comparison."""
    automatic = []
    in_automatic = False
    for event in records:
        if event.get("type") == "turn/start":
            in_automatic = event["data"]["turn"] == 2
        if in_automatic:
            automatic.append(event)
        if event.get("type") == "turn/end":
            in_automatic = False
    if any(event.get("type") == "user/message" and event["data"]["source"]["kind"] == "user" for event in automatic):
        raise AssertionError("automatic turn unexpectedly required a user prompt")
    pulses = [event for event in automatic if event.get("type") == "user/message" and event["data"]["source"]["kind"] == "scope-agent-pulse"]
    if len(pulses) != 1:
        raise AssertionError("automatic turn must use one durably authorized pulse")
    contexts = [event for event in records if event.get("type") == "user/message" and event["data"]["source"]["kind"] == "scope-agent-context"]
    if [event["data"]["source"].get("projection", {}).get("taskRevision") for event in contexts] != [1, 2, 3, None]:
        raise AssertionError("Python runtime did not record each native replacement and withdrawal")
    if contexts[-1]["data"]["source"] != {"kind": "scope-agent-context", "version": 1, "form": "withdrawn", "reason": "left"}:
        raise AssertionError("leave did not withdraw current native scope context")
    states = [event["data"] for event in records if event.get("type") == "scope-agent-context/state"]
    if states[-1]["mode"] != "left" or states[-1]["usedBudget"] != 1 or states[-1]["pendingActivation"] is not None:
        raise AssertionError("leave reset the consumed native budget or retained an activation")
    suppressed = [event["data"] for event in records if event.get("type") == "scope-agent-context/evaluation"
                  and event["data"]["decision"] == "suppress-unchanged"]
    if [item["projection"]["taskRevision"] for item in suppressed] != [4, 5] or any(item["baseline"] is None for item in suppressed):
        raise AssertionError("unchanged scope evidence was not compared with completed automatic work")
    dispatches = [event["data"] for event in records if event.get("type") == "scope-agent-context/request"]
    if [(item["turn"], item["step"], item["projection"]["taskRevision"]) for item in dispatches] != [(2, 1, 2), (2, 2, 3)]:
        raise AssertionError("automatic completion evidence lost the actual busy request projection")
    if suppressed[0]["baseline"] != suppressed[1]["baseline"]:
        raise AssertionError("suppressed updates changed the completed automatic request baseline")
    return {
        "first": {"text": first.final_response, "finishReason": first.finish_reason},
        "last": {"text": last.final_response, "finishReason": last.finish_reason},
        "observedAutomaticTurn": any(event.get("type") == "turn/end" and event["data"]["turn"] == 2 for event in observed),
        "automaticUserInputs": 0, "automaticPulses": len(pulses),
        "contextRevisions": [1, 2, 3, None], "finalMode": states[-1]["mode"],
        "usedBudget": states[-1]["usedBudget"], "pendingActivation": states[-1]["pendingActivation"],
        "suppressedRevisions": [4, 5],
        "automaticRequestRevisions": [item["projection"]["taskRevision"] for item in dispatches],
    }




def run_finite_scope_turns(
    harness: DeepSeekHarness, session: Session, *, first_prompt: str, last_prompt: str,
    coverage_revision: int | None = None, completed_turn: int = 2, expected_automatic_reason: str = "completed",
) -> tuple[RunResult, RunResult, list[dict[str, object]]]:
    """Wait for the expected automatic terminal reason and optional coverage pause before user work."""
    with harness.client.subscribe_session_notifications(session.id) as subscription:
        deadline = threading.Timer(110, harness.close)
        deadline.start()
        try:
            first = session.run(first_prompt)
            observed = []
            completed = False
            evaluated = coverage_revision is None
            paused = coverage_revision is None
            while True:
                notification = subscription.next()
                if notification.method != "session.event":
                    continue
                event = notification.payload.get("event")
                if not isinstance(event, dict):
                    continue
                observed.append(event)
                if event.get("type") == "turn/end" and event["data"]["turn"] == completed_turn:
                    if event["data"]["reason"] != {"kind": expected_automatic_reason}:
                        raise AssertionError("scope automatic turn ended with an unexpected reason")
                    completed = True
                if coverage_revision is not None:
                    data = event.get("data", {})
                    if event.get("type") == "scope-agent-context/evaluation" and data.get("decision") == "blocked-current":
                        evaluated = data.get("projection", {}).get("taskRevision") == coverage_revision
                    if event.get("type") == "scope-agent-context/state" and data.get("mode") == "paused":
                        paused = data.get("pauseReason") == "coverage"
                if completed and evaluated and paused:
                    break
            last = session.run(last_prompt)
        finally:
            deadline.cancel()
            deadline.join()
    return first, last, observed


def semantic_idle_snapshot_result(
    records: list[dict[str, object]], first: RunResult, last: RunResult, observed: list[dict[str, object]],
    audit: list[dict[str, object]],
) -> dict[str, object]:
    """Check actual automatic responses, suppressed evidence and independent Python wire delivery."""
    dispatches = [event["data"] for event in records if event.get("type") == "scope-agent-context/request"]
    wire_dispatches = [event["data"] for event in observed if event.get("type") == "scope-agent-context/request"]
    if [(item["turn"], item["step"]) for item in dispatches] != [(2, 1), (3, 1), (4, 1), (5, 1)]:
        raise AssertionError("the initial report, correction, failure and withdrawal must each receive one automatic response")
    if dispatches != wire_dispatches:
        raise AssertionError("Python notifications lost exact semantic request evidence")
    suppressed = [event for event in records if event.get("type") == "scope-agent-context/evaluation"
                  and event["data"]["decision"] == "suppress-unchanged"]
    if len(suppressed) != 1 or suppressed[0]["data"]["projection"]["taskRevision"] != 4:
        raise AssertionError("only the unrelated report must be suppressed")
    suppression = suppressed[0]
    data = suppression["data"]
    baseline = next(event for event in records if event.get("seq") == data["baseline"]["requestSeq"])
    if baseline["type"] != "scope-agent-context/request" or baseline["data"]["turn"] != 2:
        raise AssertionError("suppression must point to an actual completed automatic request")
    current, previous = data["projection"], baseline["data"]["projection"]
    if current["activation"] != previous["activation"] or current["projectionId"] == previous["projectionId"]:
        raise AssertionError("current exact projection must change while recipient evidence stays identical")
    if current["activation"]["kind"] != "recipient-evidence" or current["activation"]["coverage"] != "complete":
        raise AssertionError("suppression requires complete semantic recipient evidence")
    if not any(item["reason"] == "recipient-irrelevant" for item in current["omittedSources"]):
        raise AssertionError("suppressed unrelated report must remain in source accounting")
    preceding_states = [event["data"] for event in records if event.get("type") == "scope-agent-context/state"
                        and event["seq"] < suppression["seq"]]
    if preceding_states[-1]["usedBudget"] != 1 or data["activationId"] is not None:
        raise AssertionError("an unrelated report must not reserve another automatic turn")
    wire_suppressed = [event["data"] for event in observed if event.get("type") == "scope-agent-context/evaluation"
                       and event["data"]["decision"] == "suppress-unchanged"]
    if wire_suppressed != [data]:
        raise AssertionError("Python wire must preserve the complete suppression decision")
    contexts = [event["data"] for event in records if event.get("type") == "user/message"
                and event["data"]["source"]["kind"] == "development-task-context"]
    if len(contexts) != 6 or contexts[-1]["source"]["form"] != "disconnected":
        raise AssertionError("the six requests must retain current context and final departure")
    projections = [item["source"]["projection"] for item in contexts[:-1]]
    revisions = [item["taskRevision"] for item in projections]
    if revisions != [2, 3, 5, 6, 7]:
        raise AssertionError("unrelated revision must not create another automatic model request")
    if any("UNRELATED_ADMIN" in item["text"] for item in projections):
        raise AssertionError("the unrelated report body leaked into receiving context")
    if "RETRY_LIMIT_1" not in projections[2]["text"] or "FAILED_RETRY_9" not in projections[3]["text"]:
        raise AssertionError("correction and failure must reach actual automatic requests")
    terminal = projections[-1]
    if any(marker in terminal["text"] for marker in ("RETRY_LIMIT_3", "RETRY_LIMIT_1", "FAILED_RETRY_9", "src/retry.ts")):
        raise AssertionError("withdrawal must remove prior report bodies from current context")
    if len([item for item in terminal["omittedSources"] if item["reason"] == "withdrawn"]) != 4:
        raise AssertionError("withdrawal must account for every admitted report")
    users = [event for event in records if event.get("type") == "user/message" and event["data"]["source"]["kind"] == "user"]
    pulses = [event for event in records if event.get("type") == "user/message" and event["data"]["source"]["kind"] == "scope-agent-pulse"]
    if len(users) != 2 or len(pulses) != 4:
        raise AssertionError("automatic responses must use finite permission without intermediate human prompts")
    state = [event["data"] for event in records if event.get("type") == "scope-agent-context/state"][-1]
    if state["mode"] != "left" or state["usedBudget"] != 4 or state["pendingActivation"] is not None:
        raise AssertionError("departure must retain spent allowance and end scheduling")
    requests = [event for event in audit if event.get("type") == "context/semantic-request"]
    results = [event for event in audit if event.get("type") == "context/semantic-result"]
    if len(requests) != 4 or len(results) != 4:
        raise AssertionError("suppression can still spend an auxiliary call; empty or withdrawn-only evidence cannot")
    for request, result in zip(requests, results, strict=True):
        output = result["data"]
        if output["version"] != 2 or output["requestSeq"] != request["seq"] or output["key"] != request["data"]["key"]:
            raise AssertionError("semantic audit must retain version 2 results for their exact requests")
        if output["status"] != "completed" or output["projection"]["activation"]["kind"] != "recipient-evidence":
            raise AssertionError("semantic audit must retain completed evidence")
    if results[0]["data"]["projection"]["activation"] != results[1]["data"]["projection"]["activation"]:
        raise AssertionError("the unrelated audited summary must preserve completed evidence")
    if any(str(event.get("type", "")).startswith("context/semantic-") for event in records):
        raise AssertionError("auxiliary audit must remain separate from the receiving Session")
    if first.finish_reason != "completed" or last.finish_reason != "completed":
        raise AssertionError("explicit join and leave requests must complete")
    return {"first": {"text": first.final_response, "finishReason": first.finish_reason},
            "last": {"text": last.final_response, "finishReason": last.finish_reason},
            "contextRevisions": revisions, "suppressedRevision": 4, "spentBeforeSuppression": 1,
            "automaticRequests": len(dispatches), "automaticPulses": len(pulses), "humanRequests": len(users),
            "usedBudget": state["usedBudget"], "mode": state["mode"], "controlledSummaryCalls": len(requests),
            "auditResultVersion": 2, "realModelCalls": 0, "withdrawnSources": 4,
            "wirePreservesExactEvidence": True}


def automatic_withdrawal_snapshot_result(
    records: list[dict[str, object]], first: RunResult, last: RunResult, observed: list[dict[str, object]],
) -> dict[str, object]:
    """Check revocation after an actual tool and identical automatic request evidence over the Python wire."""
    requests = [event["data"] for event in records if event.get("type") == "scope-agent-context/request"]
    wire_requests = [event["data"] for event in observed if event.get("type") == "scope-agent-context/request"]
    if [(item["turn"], item["step"]) for item in requests] != [(2, 1)] or wire_requests != requests:
        raise AssertionError("revocation must stop further automatic requests and preserve the one actual request")
    ends = [event["data"] for event in records if event.get("type") == "turn/end"]
    if [(item["turn"], item["reason"]["kind"]) for item in ends] != [(1, "completed"), (2, "blocked"), (3, "completed")]:
        raise AssertionError("only the automatic continuation must be blocked; ordinary turns must complete")
    wire_ends = [event["data"] for event in observed if event.get("type") == "turn/end"]
    if not any(item == ends[1] for item in wire_ends):
        raise AssertionError("Python notifications omitted the blocked automatic turn")
    outcomes = [event["data"] for event in records if event.get("type") == "tool/result"]
    if len(outcomes) != 1 or outcomes[0]["message"]["content"][0]["isError"]:
        raise AssertionError("the actual authorized file read must finish before the automatic continuation is blocked")
    users = [event for event in records if event.get("type") == "user/message" and event["data"]["source"]["kind"] == "user"]
    pulses = [event for event in records if event.get("type") == "user/message" and event["data"]["source"]["kind"] == "scope-agent-pulse"]
    if len(users) != 2 or len(pulses) != 1:
        raise AssertionError("revocation must not fabricate ordinary input or renew the automatic pulse")
    state = [event["data"] for event in records if event.get("type") == "scope-agent-context/state"][-1]
    if state["mode"] != "paused" or state["pauseReason"] != "terminal" or state["usedBudget"] != 1:
        raise AssertionError("revocation must preserve the consumed allowance and terminal pause")
    contexts = [event["data"]["source"] for event in records if event.get("type") == "user/message"
                and event["data"]["source"]["kind"] == "scope-agent-context"]
    if contexts[-1] != {"kind": "scope-agent-context", "version": 1, "form": "withdrawn", "reason": "revoked"}:
        raise AssertionError("the ordinary request must receive withdrawal instead of the old snapshot")
    if first.finish_reason != "completed" or last.finish_reason != "completed":
        raise AssertionError("ordinary work must remain available after automatic authority ends")
    return {"first": {"text": first.final_response, "finishReason": first.finish_reason},
            "last": {"text": last.final_response, "finishReason": last.finish_reason},
            "automaticRequests": len(requests), "automaticTurnReason": ends[1]["reason"]["kind"],
            "automaticPulses": len(pulses), "ordinaryInputs": len(users), "allowedRead": True,
            "mode": state["mode"], "pauseReason": state["pauseReason"], "usedBudget": state["usedBudget"],
            "finalContext": contexts[-1], "wirePreservesAutomaticRequestAndBlock": True}


def joint_automatic_snapshot_result(
    records: list[dict[str, object]], first: RunResult, last: RunResult, observed: list[dict[str, object]],
) -> dict[str, object]:
    """Verify durable v2 consent, unchanged sandbox rejection and exact Python event delivery."""
    joins = [event["data"] for event in records if event.get("type") == "scope-agent-context/join-read"]
    wire_joins = [event["data"] for event in observed if event.get("type") == "scope-agent-context/join-read"]
    if [(item["version"], item["phase"]) for item in joins] != [(2, "planned"), (2, "adopted"), (2, "ended")]:
        raise AssertionError("joint adoption must preserve its original v2 consent through departure")
    wire_joins.extend(event["data"] for event in last.events if event.get("type") == "scope-agent-context/join-read")
    if wire_joins != joins:
        raise AssertionError("Python must retain planned, adopted and ended consent in its notification intervals")
    policy = joins[0]["plan"]["automatic"]
    if any(item["plan"]["automatic"] != policy for item in joins):
        raise AssertionError("joint retries or departure changed original automatic consent")
    if policy["goal"] != "Inspect the frontend interface within my existing file permission.":
        raise AssertionError("owner responsibility replaced the recipient's local goal")
    users = [event for event in records if event.get("type") == "user/message" and event["data"]["source"]["kind"] == "user"]
    pulses = [event for event in records if event.get("type") == "user/message" and event["data"]["source"]["kind"] == "scope-agent-pulse"]
    if len(users) != 2 or len(pulses) != 1:
        raise AssertionError("the single automatic response must not receive another human prompt")
    requests = [event["data"] for event in records if event.get("type") == "scope-agent-context/request"]
    if [(item["turn"], item["step"]) for item in requests] != [(2, 1), (2, 2), (2, 3)]:
        raise AssertionError("joint automatic response must retain every actual request")
    if [event["data"] for event in observed if event.get("type") == "scope-agent-context/request"] != requests:
        raise AssertionError("Python notifications lost automatic request evidence")
    outcomes = [event["data"] for event in records if event.get("type") == "tool/result"]
    if len(outcomes) != 2 or outcomes[0]["message"]["content"][0]["isError"]:
        raise AssertionError("the permitted read must succeed through the normal tool pipeline")
    if outcomes[1].get("error", {}).get("code") != "FS_SANDBOX_DENIED":
        raise AssertionError("the original file sandbox must reject the actual attempted write")
    permissions = [event["data"] for event in records if event.get("type") == "permission/preset"]
    if permissions != [{"preset": "read-only"}]:
        raise AssertionError("joint permission changed the local execution preset")
    state = [event["data"] for event in records if event.get("type") == "scope-agent-context/state"][-1]
    if state["mode"] != "paused" or state["pauseReason"] != "user" or state["usedBudget"] != 1:
        raise AssertionError("the original policy must remain paused with its consumed allowance before departure")
    if joins[-1]["leaveAdopted"] is not True or joins[-1]["plan"]["bindingId"] != state["binding"]["id"]:
        raise AssertionError("departure must end exactly the owned reading binding")
    contexts = [event["data"]["source"] for event in records if event.get("type") == "user/message"
                and event["data"]["source"]["kind"] == "scope-agent-context"]
    if contexts[-1] != {"kind": "scope-agent-context", "version": 1, "form": "withdrawn", "reason": "left"}:
        raise AssertionError("the final model request must withdraw the departed scope")
    if first.finish_reason != "completed" or last.finish_reason != "completed":
        raise AssertionError("both explicit control turns must complete")
    return {"first": {"text": first.final_response, "finishReason": first.finish_reason},
            "last": {"text": last.final_response, "finishReason": last.finish_reason},
            "joinPhases": [item["phase"] for item in joins], "joinVersion": 2,
            "goal": policy["goal"], "activationLimit": policy["activationLimit"],
            "automaticUserInputs": 0, "automaticPulses": 1, "automaticRequests": len(requests),
            "allowedRead": True, "deniedWrite": "FS_SANDBOX_DENIED", "filePreset": "read-only",
            "modeBeforeDeparture": state["mode"], "finalContext": contexts[-1], "usedBudget": state["usedBudget"],
            "wirePreservesJoinConsentAndRequestEvidence": True}


def owner_idle_snapshot_result(
    records: list[dict[str, object]], first: RunResult, last: RunResult, observed: list[dict[str, object]],
) -> dict[str, object]:
    """Verify exact local messages, automatic request anchors and preserved consumed budget."""
    contexts = [event for event in records if event.get("type") == "user/message"
                and event["data"]["source"]["kind"] == "development-task-context"]
    sources = [event["data"]["source"] for event in contexts]
    if len(sources) != 5 or [source.get("version") for source in sources] != [3, 3, 3, 3, 1]:
        raise AssertionError("owner idle run must record three projections, a coverage withdrawal and a disconnect")
    if sources[-1]["form"] != "disconnected":
        raise AssertionError("leaving the Task must remove its current context")
    texts = [event["data"]["content"][0]["text"] for event in contexts]
    if ["PEER_AUTOMATIC_TRIGGER" in text for text in texts] != [False, True, True, False, False]:
        raise AssertionError("peer update must enter automatic requests and disappear on local leave")
    if any("OWNER_AUTOMATIC_RESULT" in text for text in texts):
        raise AssertionError("own ordinary contribution must be omitted from received context")
    users = [event for event in records if event.get("type") == "user/message" and event["data"]["source"]["kind"] == "user"]
    pulses = [event for event in records if event.get("type") == "user/message" and event["data"]["source"]["kind"] == "scope-agent-pulse"]
    if len(users) != 2 or len(pulses) != 1:
        raise AssertionError("the middle turn must require only its authorized automatic pulse")
    requests = [event["data"] for event in records if event.get("type") == "scope-agent-context/request"]
    if [(item["turn"], item["step"]) for item in requests] != [(2, 1), (2, 2)]:
        raise AssertionError("request evidence must retain both actual automatic requests")
    wire_requests = [event["data"] for event in observed if event.get("type") == "scope-agent-context/request"]
    if wire_requests != requests:
        raise AssertionError("Python notification stream must preserve complete local request evidence")
    blocked = [event["data"] for event in observed if event.get("type") == "scope-agent-context/evaluation"
               and event["data"]["decision"] == "blocked-current"]
    if len(blocked) != 1 or blocked[0]["projection"]["taskRevision"] != 6 or blocked[0]["activationId"] is not None:
        raise AssertionError("current incomplete evidence must block without another activation")
    if not any(item["reason"] == "budget" for item in blocked[0]["projection"]["omittedSources"]):
        raise AssertionError("the blocked projection must identify its budget omission")
    pauses = [event["data"] for event in observed if event.get("type") == "scope-agent-context/state"
              and event["data"]["pauseReason"] == "coverage"]
    if len(pauses) != 1 or pauses[0]["usedBudget"] != 1 or sources[-2]["form"] != "withdrawn":
        raise AssertionError("coverage pause must withdraw context and retain the spent reservation")
    state = [event["data"] for event in records if event.get("type") == "scope-agent-context/state"][-1]
    if state["mode"] != "left" or state["usedBudget"] != 1 or state["pendingActivation"] is not None:
        raise AssertionError("local leave must retain consumed budget and remove automatic authority")
    calls = [event for event in records if event.get("type") == "tool/call"]
    if len(calls) != 1 or calls[0]["data"]["name"] != "write":
        raise AssertionError("the authorized automatic turn must perform one actual file Write")
    if first.finish_reason != "completed" or last.finish_reason != "completed":
        raise AssertionError("both manually driven turns must complete")
    return {"first": {"text": first.final_response, "finishReason": first.finish_reason},
            "last": {"text": last.final_response, "finishReason": last.finish_reason},
            "automaticUserInputs": 0, "automaticPulses": 1,
            "automaticRequests": [{"turn": item["turn"], "step": item["step"]} for item in requests],
            "contextRevisions": [source.get("projection", {}).get("taskRevision") for source in sources],
            "blockedCurrentRevision": 6, "coveragePauses": len(pauses), "fileWrites": 1, "finalMode": state["mode"], "usedBudget": state["usedBudget"],
            "wirePreservesExactLocalRequestEvidence": True}


def dual_contribution_snapshot_result(records: list[dict[str, object]], turns: list[RunResult]) -> dict[str, object]:
    """Check unchanged local responsibility and exact withdrawal through the Python SDK stream."""
    contexts = [event for event in records if event.get("type") == "user/message"
                and event["data"]["source"]["kind"] == "development-task-context"]
    wire_contexts = [event for turn in turns for event in turn.events if event.get("type") == "user/message"
                     and event["data"]["source"]["kind"] == "development-task-context"]
    if len(contexts) != 4 or [event["data"] for event in contexts] != [event["data"] for event in wire_contexts]:
        raise AssertionError("Python wire must preserve four exact local context revisions")
    sources = [event["data"]["source"] for event in contexts]
    if len({source["taskId"] for source in sources}) != 1 or len({source["bindingId"] for source in sources}) != 1:
        raise AssertionError("remote contribution replaced the original local Task or assignment")
    if any(source["bindingEpoch"] != sources[0]["bindingEpoch"] for source in sources):
        raise AssertionError("capture management changed the local assignment epoch")
    if [source["revision"] for source in sources] != [2, 3, 4, 5]:
        raise AssertionError("local context must advance for two real Writes and local withdrawal")
    for event in contexts:
        text = event["data"]["content"][0]["text"]
        if "Keep the existing local implementation responsibility." not in text:
            raise AssertionError("the original local goal disappeared from model-visible context")
        if "DUAL_SHARED_RESULT" in text or "LOCAL_ONLY_RESULT" in text:
            raise AssertionError("self-published tool bodies must not be reinjected as other-source facts")
    if [sum(item["reason"] == "self-published" for item in source["omittedSources"]) for source in sources] != [0, 1, 2, 0]:
        raise AssertionError("both tool reports need local self-publication provenance")
    withdrawn = [item for item in sources[-1]["omittedSources"] if item["reason"] == "withdrawn"]
    if len(withdrawn) != 2 or "ended" not in contexts[-1]["data"]["content"][0]["text"]:
        raise AssertionError("stopLocal must retain exact current withdrawal evidence")
    if any(event.get("type", "").startswith("scope-agent-context/") for event in records):
        raise AssertionError("contribution-only authorization must not install remote reading or automatic work")
    calls = [event["data"] for event in records if event.get("type") == "tool/call"]
    if [(call["turn"], call["name"]) for call in calls] != [(2, "write"), (3, "write")]:
        raise AssertionError("ordinary history must precede two real Writes without recall tools")
    expected_responses = [
        "The existing local Task and ordinary work history are retained.",
        "One real Write reached both independently authorized Tasks.",
        "Remote sharing ended; local collection received the next Write.",
        "Both captures ended independently; the local Task and history remain.",
    ]
    if [turn.final_response for turn in turns] != expected_responses or any(turn.finish_reason != "completed" for turn in turns):
        raise AssertionError("the Python runtime did not complete the four controlled local turns")
    return {"turns": [{"text": turn.final_response, "finishReason": turn.finish_reason} for turn in turns],
            "contextRevisions": [source["revision"] for source in sources], "realWriteTurns": [2, 3],
            "withdrawnSources": len(withdrawn), "localAssignmentPreserved": True,
            "wirePreservesExactContextMessages": True, "remoteReadingEvents": 0}


def owner_participation_snapshot_result(records: list[dict[str, object]], turns: list[RunResult]) -> dict[str, object]:
    """Check owner-local contribution and independent peer work in the actual Python SDK stream."""
    contexts = [event for event in records if event.get("type") == "user/message"
                and event["data"]["source"]["kind"] == "development-task-context"]
    wire_contexts = [event for turn in turns for event in turn.events if event.get("type") == "user/message"
                     and event["data"]["source"]["kind"] == "development-task-context"]
    if len(contexts) != 4 or [event["data"] for event in contexts] != [event["data"] for event in wire_contexts]:
        raise AssertionError("Python wire must retain all four exact owner context messages")
    texts = [event["data"]["content"][0]["text"] for event in contexts]
    if any("REMOTE_PEER_READY" not in text for text in texts[:3]) or "REMOTE_PEER_READY" in texts[-1]:
        raise AssertionError("peer evidence must persist after owner stop and withdraw after peer stop")
    if any("OWNER_LOCAL_READY" in text for text in texts):
        raise AssertionError("the owner's own work must not be injected back as another source")
    sources = [event["data"]["source"] for event in contexts]
    if any(source["backend"]["id"] != "text" for source in sources):
        raise AssertionError("owner context must use the production text provider")
    if not any(item["reason"] == "self-published" for item in sources[1]["omittedSources"]):
        raise AssertionError("the self-publication omission needs original source attribution")
    withdrawn = [item for item in sources[-1]["omittedSources"] if item["reason"] == "withdrawn"]
    if len(withdrawn) != 2:
        raise AssertionError("both ended captures must be excluded from current context")
    calls = [event["data"] for event in records if event.get("type") == "tool/call"]
    if len(calls) != 1 or calls[0]["name"] != "write":
        raise AssertionError("the owner must perform one real write and need no recall tool")
    if [turn.final_response for turn in turns] != ["Both existing Agents received the other source.",
                                                 "Owner sharing ended; peer sharing remains.",
                                                 "Both source captures ended; historical evidence remains."]:
        raise AssertionError("the Python runtime did not consume the complete owner-participation model script")
    if any(turn.finish_reason != "completed" for turn in turns):
        raise AssertionError("all Python-controlled owner turns must complete")
    return {"turns": [{"text": turn.final_response, "finishReason": turn.finish_reason} for turn in turns],
            "contextRevisions": [source["revision"] for source in sources], "ownerFileCalls": len(calls),
            "withdrawnSources": len(withdrawn), "wirePreservesExactContextMessages": True}


def native_contribution_snapshot_result(records: list[dict[str, object]], turns: list[RunResult]) -> dict[str, object]:
    """Check the actual Python protocol preserves source-driven native replacement and withdrawal."""
    joins = [event for event in records if event.get("type") == "scope-agent-context/join-read"]
    wire_joins = [event for turn in turns for event in turn.events
                  if event.get("type") == "scope-agent-context/join-read"]
    if [event["data"]["phase"] for event in joins] != ["planned", "adopted"]:
        raise AssertionError("joint reading must durably adopt exactly the original subscription plan")
    if [event["data"] for event in joins] != [event["data"] for event in wire_joins]:
        raise AssertionError("Python wire must preserve the exact durable join adoption events")
    if joins[0]["data"]["plan"] != joins[1]["data"]["plan"]:
        raise AssertionError("joint adoption must retain its original subscription and binding identities")
    contexts = [event for event in records if event.get("type") == "user/message"
                and event["data"]["source"]["kind"] == "scope-agent-context"]
    wire_contexts = [event for turn in turns for event in turn.events if event.get("type") == "user/message"
                     and event["data"]["source"]["kind"] == "scope-agent-context"]
    if len(contexts) != 3 or [event["data"] for event in contexts] != [event["data"] for event in wire_contexts]:
        raise AssertionError("Python wire must preserve all three exact native recipient context messages")
    projections = [event["data"]["source"]["projection"] for event in contexts]
    if [projection["taskRevision"] for projection in projections] != [5, 7, 8]:
        raise AssertionError("native source reports and withdrawal must identify the owner commit revision")
    if any(projection["backend"] != {"id": "text", "revision": "8"} for projection in projections):
        raise AssertionError("native contribution must use the production text provider")
    if contexts[0]["surfaceOp"] != "append" or any(event["surfaceOp"].get("op") != "replace" for event in contexts[1:]):
        raise AssertionError("native updates must replace current context while preserving historical events")
    texts = [event["data"]["content"][0]["text"] for event in contexts]
    if not all(marker in texts[0] for marker in ("NATIVE_ALPHA", "NATIVE_BETA", "NATIVE_CORRECTED", "snapshot-native-source-peer")):
        raise AssertionError("the Python recipient lost an original source report or attribution")
    if not all(marker in texts[1] for marker in ("NATIVE_REPLACEMENT", "NATIVE_BETA", "snapshot-native-source-peer")):
        raise AssertionError("the Python recipient lost the replacement or unchanged file report")
    if any(marker in texts[1] for marker in ("NATIVE_ALPHA", "NATIVE_CORRECTED")):
        raise AssertionError("a complete replacement retained superseded file content")
    superseded = [item for item in projections[1]["omittedSources"] if item["reason"] == "superseded"]
    if len(superseded) != 2:
        raise AssertionError("replacement must retain both superseded source attributions")
    if "failure" not in texts[1] or any("NEVER_APPLIED" in text for text in texts):
        raise AssertionError("failed native Edit must remain failure without claiming the attempted replacement")
    if any(marker in texts[-1] for marker in ("NATIVE_ALPHA", "NATIVE_BETA", "NATIVE_CORRECTED", "NATIVE_REPLACEMENT")):
        raise AssertionError("revoked contribution retained old source reports in current context")
    withdrawn = [item for item in projections[-1]["omittedSources"] if item["reason"] == "withdrawn"]
    if len(withdrawn) != 5 or "revoked" not in texts[-1]:
        raise AssertionError("withdrawal must account for all five source reports")
    if any(event.get("type") == "tool/call" for event in records):
        raise AssertionError("the native recipient must receive reports without a recall tool")
    if any(turn.finish_reason != "completed" for turn in turns):
        raise AssertionError("all three real Python-driven turns must complete")
    if [turn.final_response for turn in turns] != ["Native source changes received.",
                                                 "Failed Edit retained as a failed report.",
                                                 "Withdrawn source reports are no longer current context."]:
        raise AssertionError("the Python runtime did not consume the three recorded model responses")
    return {"turns": [{"text": turn.final_response, "finishReason": turn.finish_reason} for turn in turns],
            "contextRevisions": [5, 7, 8], "selectedSourceCounts": [len(item["selectedSources"]) for item in projections],
            "supersededSources": len(superseded), "withdrawnSources": len(withdrawn),
            "recipientRecallCalls": 0, "joinReadPhases": ["planned", "adopted"],
            "wirePreservesExactContextMessages": True, "wirePreservesJoinRead": True}


def peer_facts_snapshot_result(records: list[dict[str, object]], turns: list[RunResult]) -> dict[str, object]:
    """Check that Python protocol events preserve exact source metadata and each durable replacement."""
    contexts = [event for event in records if event.get("type") == "user/message"
                and event["data"]["source"]["kind"] == "development-task-context"]
    wire_contexts = [event for turn in turns for event in turn.events if event.get("type") == "user/message"
                     and event["data"]["source"]["kind"] == "development-task-context"]
    if len(contexts) != 4 or [event["data"] for event in wire_contexts] != [event["data"] for event in contexts]:
        raise AssertionError("Python wire events lost or changed the four Task context messages")
    if [event["data"]["source"]["revision"] for event in contexts] != [3, 4, 5, 6]:
        raise AssertionError("peer context revisions do not match owner commits")
    if contexts[0]["surfaceOp"] != "append" or any(event["surfaceOp"].get("op") != "replace" for event in contexts[1:]):
        raise AssertionError("peer corrections and withdrawal must replace the current native surface")
    projections = [json.loads(event["data"]["content"][0]["text"].split("<development-task-facts>\n")[1]
                              .split("\n</development-task-facts>")[0]) for event in contexts]
    heads = [projection["artifacts"][0]["chains"][0]["heads"][0] for projection in projections]
    if [head["state"] for head in heads] != ["valid", "valid", "invalid", "revoked"]:
        raise AssertionError("peer correction/invalid/revoked states did not reach the Python SDK")
    if any(head.get("observerNodeId") is not None or head.get("attribution") != "authenticated-peer-report" for head in heads):
        raise AssertionError("peer attribution was lost or converted into local Node identity")
    return {
        "turns": [{"text": turn.final_response, "finishReason": turn.finish_reason} for turn in turns],
        "contextRevisions": [event["data"]["source"]["revision"] for event in contexts],
        "states": [head["state"] for head in heads],
        "observerPeerId": heads[0]["observerPeerId"],
        "capture": heads[0]["capture"],
        "attribution": heads[0]["attribution"],
        "withdrawal": projections[-1]["withdrawals"][0]["peerContribution"],
        "wirePreservesExactContextMessages": True,
    }


def semantic_snapshot_result(
    records: list[dict[str, object]], turns: list[RunResult], audit: list[dict[str, object]],
) -> dict[str, object]:
    """Relate actual Python wire projections to isolated semantic request/result records and withdrawal."""
    contexts = [event for event in records if event.get("type") == "user/message"
                and event["data"]["source"]["kind"] == "development-task-context"]
    wire_contexts = [event for turn in turns for event in turn.events if event.get("type") == "user/message"
                     and event["data"]["source"]["kind"] == "development-task-context"]
    if len(contexts) != 4 or [event["data"] for event in wire_contexts] != [event["data"] for event in contexts]:
        raise AssertionError("Python wire events must preserve all four exact semantic context messages")
    revisions = [event["data"]["source"]["revision"] for event in contexts]
    if revisions != [5, 6, 7, 8] or any(event["data"]["source"]["backend"]["id"] != "semantic" for event in contexts):
        raise AssertionError("Python runtime must consume the real semantic backend at each owner revision")
    if contexts[0]["surfaceOp"] != "append" or any(event["surfaceOp"].get("op") != "replace" for event in contexts[1:]):
        raise AssertionError("semantic updates and withdrawal must replace the current native surface")
    texts = [event["data"]["content"][0]["text"] for event in contexts]
    projections = [json.loads(text.split("<shared-work-updates>\n")[1].split("\n</shared-work-updates>")[0]) for text in texts]
    update_counts = [len(projection["updates"]) for projection in projections]
    if update_counts != [2, 2, 3, 0]:
        raise AssertionError("semantic updates must retain the current complete Write and later reports until source withdrawal")
    if any("WRITE_ALPHA" in text for text in texts[1:]) or any("WRITE_CURRENT" not in text for text in texts[1:3]):
        raise AssertionError("a complete replacement must remove the superseded Write from current semantic text")
    for event, projection in zip(contexts, projections, strict=True):
        source = event["data"]["source"]
        if projection["coverage"] != {"selectedSources": source["selectedSources"], "omittedSources": source["omittedSources"]}:
            raise AssertionError("semantic visible coverage must equal the persisted source attribution")
        omitted = [item for item in source["omittedSources"] if item["reason"] == "recipient-irrelevant"]
        if len(omitted) != 1 or omitted[0]["source"]["publicationId"] != "publication-unrelated-admin":
            raise AssertionError("the controlled irrelevant publication must remain explicitly accounted for")
        for update in projection["updates"]:
            if not update["sources"] or any(reference["source"] not in source["selectedSources"] for reference in update["sources"]):
                raise AssertionError("each semantic update must cite its selected original publication")
    if any("UNRELATED_ADMIN" in text for text in texts):
        raise AssertionError("the irrelevant source body leaked into an adopted semantic projection")
    if any(marker in texts[-1] for marker in ("WRITE_ALPHA", "WRITE_CURRENT", "EDIT_BETA", "FAILURE_GAMMA", "src/retry.ts", "docs/coordination.md")):
        raise AssertionError("source withdrawal must exclude old semantic text and quotes")
    if len([item for item in contexts[-1]["data"]["source"]["omittedSources"] if item["reason"] == "withdrawn"]) != 4:
        raise AssertionError("withdrawal must account for all four original tool observations")
    if len(projections[-1]["mandatory"]) != 1 or projections[-1]["mandatory"][0]["kind"] != "withdrawal":
        raise AssertionError("the controlled model cannot erase the deterministic withdrawal notice")
    requests = [event for event in audit if event.get("type") == "context/semantic-request"]
    results = [event for event in audit if event.get("type") == "context/semantic-result"]
    if len(requests) != 4 or len(results) != 4:
        raise AssertionError("each semantic computation must retain its actual request and completed result")
    audit_links = []
    for request, result, context in zip(requests, results, contexts, strict=True):
        output = result["data"]
        if output["requestSeq"] != request["seq"] or output["key"] != request["data"]["key"] or output["status"] != "completed":
            raise AssertionError("semantic audit result must identify its exact completed model request")
        if request["data"]["purpose"] != "context-summary" or request["data"]["call"]["provider"] != "semantic-snapshot":
            raise AssertionError("semantic runtime must use the dedicated controlled auxiliary route")
        if output["version"] != 2 or output["projection"]["activation"]["kind"] != "recipient-evidence":
            raise AssertionError("current semantic audit must record versioned recipient evidence")
        if output["projection"]["text"] != context["data"]["content"][0]["text"]:
            raise AssertionError("actual native context must equal the durably completed semantic projection")
        audit_links.append({"requestSeq": request["seq"], "status": output["status"],
                            "purpose": request["data"]["purpose"], "usage": output["usage"]})
    if any(str(event.get("type", "")).startswith("context/semantic-") for event in records):
        raise AssertionError("auxiliary model audit events must not be written into the recipient Session")
    return {
        "turns": [{"text": turn.final_response, "finishReason": turn.finish_reason} for turn in turns],
        "contextRevisions": revisions, "backend": "semantic", "updateCounts": update_counts,
        "irrelevantOmissionCounts": [1, 1, 1, 1], "withdrawnSourceCount": 4,
        "controlledSemanticRequests": len(requests), "realModelRequests": 0,
        "auditResults": audit_links, "wirePreservesExactContextMessages": True,
        "isolatedAuditMatchesNativeContext": True,
    }


def smoke_sdk_fs_search(base_url: str, executable: Path) -> None:
    """Exercise real grep and glob spawns through the packaged executable."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-fs-search-") as temporary:
        root = Path(temporary).resolve()
        (root / "needle.txt").write_text(f"{FS_SEARCH_MARKER}\n")
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_profile_patch(root, "fs-search.patch.yml", sessions, [
            {"id": "skill-filesystem", "disabled": True},
            {"id": "tool-fs-search", "config": {"sampleOverCapGlobResults": False}},
        ])
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_bin=str(executable),
            dsh_home=str(dsh_home),
            patches=(str(patch),),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(FS_SEARCH_PROMPT, session_id="fs-search-smoke")

        assert result.final_response == FS_SEARCH_TEXT, result.final_response
        assert_session_log(sessions, root, FS_SEARCH_TEXT, FS_SEARCH_MARKER, "needle.txt")


def smoke_sdk_spawn_node(base_url: str, executable: Path) -> None:
    """A shell command starting with `node` must reach the machine's Node, not the executable."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-spawn-node-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_profile_patch(root, "spawn-node.patch.yml", sessions, [])
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_bin=str(executable),
            dsh_home=str(dsh_home),
            patches=(str(patch),),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(SPAWN_NODE_PROMPT, session_id="spawn-node-smoke")

        assert result.final_response == SPAWN_NODE_TEXT, result.final_response
        assert_session_log(sessions, root, SPAWN_NODE_TEXT, "PKG_EXECPATH=ABSENT")


def smoke_sdk_mcp(base_url: str, executable: Path | None) -> None:
    """Discover and call an external stdio MCP tool through the packaged client."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-mcp-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        server_script = root / "mcp_server.py"
        server_script.write_text(MCP_SERVER_SCRIPT)
        patch = write_mcp_patch(root, sessions, server_script)
        discovery_log = server_script.with_suffix(".log")
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_bin=None if executable is None else str(executable),
            dsh_home=str(dsh_home),
            patches=(str(patch),),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(MCP_PROMPT, session_id="mcp-smoke")

        assert result.final_response == MCP_TEXT, result.final_response
        assert discovery_log.read_text().splitlines() == [
            "initialize",
            "notifications/initialized",
            "tools/list",
            "tools/call",
        ]
        assert_session_log(sessions, root, MCP_TEXT, "mcp__fixture__add", "42")


def smoke_sdk_profile_plugin(base_url: str) -> None:
    """Install an external bundle through Python's dsh command and load it in the SDK."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-profile-plugin-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        plugin = root / "plugin"
        plugin.mkdir()
        (plugin / "package.json").write_text(json.dumps({
            "name": "dsh-python-blackbox-plugin",
            "version": "1.0.0",
            "private": True,
            "type": "module",
            "exports": "./index.js",
            "peerDependencies": {"@deepseek-ai/cordis": "*"},
            "dsh": {"bundle": {"patch": "./cordis.patch.yml"}},
        }, indent=2))
        (plugin / "index.js").write_text(
            "import { Context } from '@deepseek-ai/cordis'\n"
            "export const name = 'python-sdk-blackbox-plugin'\n"
            "export const inject = ['systemPrompt']\n"
            "export function apply(ctx) {\n"
            "  if (!(ctx instanceof Context)) throw new Error('external plugin loaded a second Cordis instance')\n"
            "  ctx.effect(() => ctx.systemPrompt.section({\n"
            "    name: 'python-sdk:blackbox-plugin',\n"
            "    order: 10,\n"
            f"    text: '{PROFILE_PLUGIN_MARKER}',\n"
            "  }))\n"
            "}\n"
        )
        (plugin / "cordis.patch.yml").write_text(json.dumps([{
            "insert": [{"id": "python-sdk-blackbox-plugin", "name": "dsh-python-blackbox-plugin"}],
        }], indent=2))

        dsh = Path(sysconfig.get_path("scripts")) / ("dsh.exe" if IS_WINDOWS else "dsh")
        environment = {**os.environ, "DSH_HOME": str(dsh_home)}
        installed = subprocess.run(
            [str(dsh), "plugin", "--profile", "sdk", "add", f"file:{plugin}"],
            cwd=root,
            env=environment,
            text=True,
            capture_output=True,
            check=False,
        )
        if installed.returncode != 0:
            raise AssertionError(
                f"Python-installed dsh could not add the external profile plugin: "
                f"returncode={installed.returncode} (0x{installed.returncode & 0xffffffff:08x}) "
                f"stdout={installed.stdout!r} stderr={installed.stderr!r}"
            )
        manifest = json.loads((dsh_home / "profiles" / "sdk" / "package.json").read_text())
        if "dsh-python-blackbox-plugin" not in manifest.get("dependencies", {}):
            raise AssertionError(f"dsh plugin did not record the external dependency: {manifest}")
        if "dsh-python-blackbox-plugin" not in manifest["dsh"]["profile"]["bundles"]:
            raise AssertionError(f"dsh plugin did not activate the external bundle: {manifest}")

        harness = DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_home=str(dsh_home),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        )
        try:
            with harness:
                result = harness.run(PROFILE_PLUGIN_PROMPT, session_id="profile-plugin-smoke")
        except Exception as error:
            raise AssertionError(
                f"external profile plugin runtime failed: {harness.client._runtime_diagnostics()}"
            ) from error

        assert result.final_response == PROFILE_PLUGIN_TEXT, result.final_response
        assert_zstd_session_log(dsh_home / "sessions")


def smoke_sdk_snapshot(base_url: str, executable: Path, update_snapshots: bool) -> None:
    """Drive and compare the advanced SDK/executable behavioral snapshot."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-snapshot-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_advanced_profile_patch(root, "snapshot.patch.yml", sessions)
        feedback_patch = write_profile_patch(root, "feedback.patch.yml", sessions, [{"insert": [
            {"id": "snapshot-workflow-order", "name": (
                Path(__file__).resolve().parent / "fixtures/python-snapshot-workflow-order.mjs"
            ).as_uri(), "config": {
                "parentSessionId": SNAPSHOT_SESSION_ID, "prompt": SNAPSHOT_WORKFLOW_CHILD_PROMPT,
            }},
            {"id": "snapshot-message-feedback", "name": "@deepseek-ai/dsh-message-feedback",
             "config": {"maxNoteBytes": 1024}},
            {"id": "snapshot-feedback-producer", "name": (
                Path(__file__).resolve().parent.parent / "snapshots/sdk/text-turn/feedback-producer.mjs"
            ).as_uri()},
        ]}])
        with DeepSeekHarness(
            provider="deepseek-official",
            model="smoke-model",
            cwd=str(root),
            dsh_bin=str(executable),
            dsh_home=str(dsh_home),
            patches=(str(patch), str(feedback_patch)),
            env={
                "DSH_PERMISSION_MODE": "danger-full-access",
                "DSH_TELEMETRY_DISABLED": "1",
            },
            api_key="sk-keyless-smoke",
            base_url=base_url,
            request_timeout_seconds=60,
        ) as harness:
            result = harness.run(SNAPSHOT_PROMPT, session_id=SNAPSHOT_SESSION_ID)

        assert result.final_response == SNAPSHOT_FINAL_TEXT, result.final_response
        feedback_types = [event.get("type") for event in result.events
                          if str(event.get("type")).startswith("feedback/")]
        if feedback_types != ["feedback/record", "feedback/record", "feedback/message-put", "feedback/message-put", "feedback/message-delete"]:
            raise AssertionError(f"advanced snapshot did not exercise all feedback mutations: {feedback_types}")
        methods = [notification.method for notification in result.notifications]
        if methods.count("subagent.started") != 2 or methods.count("subagent.finished") != 2:
            raise AssertionError(f"advanced snapshot emitted unexpected subagent lifecycle: {methods}")
        ptc_events = [event for event in result.events
                      if event.get("type") in ("tool/ptc-dispatch-start", "tool/ptc-dispatch")]
        if [event["type"] for event in ptc_events] != ["tool/ptc-dispatch-start", "tool/ptc-dispatch"]:
            raise AssertionError(f"advanced snapshot emitted unexpected PTC dispatch events: {ptc_events}")
        for event in ptc_events:
            data = event["data"]
            identity = (data.get("rootCallId"), data.get("parentCallId"), data.get("subCallId"))
            if identity != ("advanced-code", "advanced-code", "advanced-code:ptc:1"):
                raise AssertionError(f"advanced snapshot emitted unexpected PTC dispatch identity: {identity}")

        logs = read_session_logs(sessions)
        child_ids = snapshot_child_ids(result)
        expected_ids = {SNAPSHOT_SESSION_ID, *child_ids}
        if set(logs) != expected_ids:
            raise AssertionError(f"advanced snapshot expected parent plus two child logs: {sorted(logs)}")
        if "DIRECT_CHILD_OK" not in render_jsonl(logs[child_ids[0]]):
            raise AssertionError("first advanced child log has no direct-subagent result")
        if "WORKFLOW_CHILD_OK" not in render_jsonl(logs[child_ids[1]]):
            raise AssertionError("second advanced child log has no workflow-subagent result")

        files = build_snapshot_files(result, logs, child_ids, root)
        compare_snapshot_files(
            files, update_snapshots, ADVANCED_SNAPSHOT_DIRECTORY, ADVANCED_SNAPSHOT_FILENAMES,
        )


def smoke_sdk_restart_snapshot(base_url: str, executable: Path, update_snapshots: bool) -> None:
    """Snapshot two isolated sessions across complete SDK runtime restarts."""
    from deepseek_harness import DeepSeekHarness

    with tempfile.TemporaryDirectory(prefix="dsh-sdk-restart-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_advanced_profile_patch(root, "restart.patch.yml", sessions)
        first_request = len(MockModelHandler.requests)

        def run(prompt: str, session_id: str) -> "RunResult":
            with DeepSeekHarness(
                provider="deepseek-official",
                model="smoke-model",
                cwd=str(root),
                dsh_bin=str(executable),
                dsh_home=str(dsh_home),
                patches=(str(patch),),
                env={
                    "DSH_PERMISSION_MODE": "danger-full-access",
                    "DSH_TELEMETRY_DISABLED": "1",
                },
                api_key="sk-keyless-smoke",
                base_url=base_url,
                request_timeout_seconds=60,
            ) as harness:
                return harness.run(prompt, session_id=session_id)

        first = run(RESTART_FIRST_PROMPT, RESTART_FIRST_SESSION_ID)
        second = run(RESTART_SECOND_PROMPT, RESTART_SECOND_SESSION_ID)
        requests = MockModelHandler.requests[first_request:]
        if len(requests) != 2:
            raise AssertionError(f"restart snapshot expected two model requests: {requests}")
        if first.final_response != RESTART_FIRST_TEXT or second.final_response != RESTART_SECOND_TEXT:
            raise AssertionError(
                f"restart snapshot responses differ: {first.final_response!r}, {second.final_response!r}"
            )

        logs = read_session_logs(sessions)
        expected_ids = {RESTART_FIRST_SESSION_ID, RESTART_SECOND_SESSION_ID}
        if set(logs) != expected_ids:
            raise AssertionError(f"restart snapshot expected two durable sessions: {sorted(logs)}")
        for session_id, expected in (
            (RESTART_FIRST_SESSION_ID, RESTART_FIRST_TEXT),
            (RESTART_SECOND_SESSION_ID, RESTART_SECOND_TEXT),
        ):
            records = logs[session_id]
            if sum(record.get("type") == "turn/end" for record in records) != 1:
                raise AssertionError(f"restart snapshot {session_id} has an unexpected turn count")
            if expected not in render_jsonl(records):
                raise AssertionError(f"restart snapshot durable log has no {expected}")

        files = build_restart_snapshot_files(
            first,
            second,
            requests,
            logs,
            root,
            sessions,
        )
        compare_snapshot_files(
            files, update_snapshots, RESTART_SNAPSHOT_DIRECTORY, RESTART_SNAPSHOT_FILENAMES,
        )


def smoke_direct(base_url: str, executable: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="dsh-direct-") as temporary:
        root = Path(temporary).resolve()
        dsh_home = root / "home"
        sessions = dsh_home / "sessions"
        patch = write_profile_patch(root, "direct.patch.yml", sessions, [])
        environment = {
            **os.environ,
            "DSH_HOME": str(dsh_home),
            "DSH_PERMISSION_MODE": "danger-full-access",
            "DSH_TELEMETRY_DISABLED": "1",
            "DEEPSEEK_API_KEY": "sk-keyless-smoke",
            "DEEPSEEK_BASE_URL": base_url,
        }
        peer = RuntimePeer(
            [str(executable), "--profile", "sdk", "--patch", str(patch)],
            root,
            environment,
        )
        try:
            peer.send({"jsonrpc": "2.0", "id": "initialize", "method": "initialize", "params": {"cwd": str(root), "provider": "deepseek-official", "model": "smoke-model"}})
            peer.read_until(lambda message: message.get("id") == "initialize")
            peer.send({
                "jsonrpc": "2.0",
                "id": "prompt",
                "method": "session/prompt",
                "params": {"sessionId": "direct-smoke", "contentBlocks": [{"type": "text", "text": "reply with the smoke text"}]},
            })
            messages = peer.read_until(lambda message: message.get("id") == "prompt")
            if not any(is_idle_notification(message) for message in messages):
                messages.extend(peer.read_until(is_idle_notification))
            event_text = json.dumps(messages)
            if EXPECTED_TEXT not in event_text:
                raise AssertionError(f"direct runtime emitted no final response: {messages}")
            peer.send({"jsonrpc": "2.0", "id": "shutdown", "method": "shutdown"})
            peer.read_until(lambda message: message.get("id") == "shutdown")
        finally:
            peer.close()
        assert_session_log(sessions, root, EXPECTED_TEXT)


def smoke_packaged_runner(executable: Path) -> None:
    """Exercise the private subprocess runner through the single-file entry."""
    with tempfile.TemporaryDirectory(prefix="dsh-packaged-runner-") as temporary:
        root = Path(temporary).resolve()
        target_script = (
            "import os,sys; "
            "ok = (os.getcwd() == os.environ['PACKAGED_RUNNER_EXPECTED_CWD'] "
            "and os.environ.get('DSH_SUBPROCESS_RUNNER') == 'target-collision-restored'); "
            "sys.exit(7 if ok else 9)"
        )
        if not IS_WINDOWS:
            request_path = root / "launch-request.json"
            target_env = dict(os.environ)
            target_env["DSH_SUBPROCESS_RUNNER"] = "target-collision-restored"
            target_env["PACKAGED_RUNNER_EXPECTED_CWD"] = str(root)
            request_path.write_text(
                json.dumps({"cwd": str(root), "env": target_env}),
                encoding="utf-8",
            )
            request_path.chmod(0o600)
            environment = dict(os.environ)
            environment["DSH_SUBPROCESS_RUNNER"] = str(request_path)
            result = subprocess.run(
                [str(executable), "--", sys.executable, "-c", target_script],
                cwd=root,
                env=environment,
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
            if result.returncode != 7 or request_path.exists() or (root / "startup-error.json").exists():
                raise AssertionError(
                    "packaged POSIX runner failed: "
                    f"exit={result.returncode}; stdout={result.stdout!r}; stderr={result.stderr!r}"
                )
            return

        node = shutil.which("node")
        if node is None:
            raise AssertionError("packaged Windows runner smoke requires node on PATH")
        helper = root / "windows-runner-smoke.mjs"
        helper.write_text(
            """import { spawn } from 'node:child_process'
const [runtime, target, cwd, targetScript] = process.argv.slice(2)
const child = spawn(runtime, ['--', target, '-c', targetScript], {
  cwd,
  env: { ...process.env, DSH_SUBPROCESS_RUNNER: 'windows' },
  stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 'pipe'],
})
const messages = []
let stdout = ''
let stderr = ''
child.stdio[4].destroy()
child.stdio[5].on('data', chunk => { stdout += chunk.toString() })
child.stdio[6].on('data', chunk => { stderr += chunk.toString() })
child.on('message', message => { messages.push(message) })
const result = await new Promise((resolve, reject) => {
  child.once('error', reject)
  child.once('spawn', () => {
    child.send({
      type: 'start',
      cwd,
      env: {
        ...process.env,
        DSH_SUBPROCESS_RUNNER: 'target-collision-restored',
        PACKAGED_RUNNER_EXPECTED_CWD: cwd,
      },
    }, error => { if (error) reject(error) })
  })
  child.once('close', (exitCode, signal) => { resolve({ exitCode, signal }) })
})
process.stdout.write(JSON.stringify({ ...result, messages, stdout, stderr }))
""",
            encoding="utf-8",
        )
        helper_result = subprocess.run(
            [node, str(helper), str(executable), sys.executable, str(root), target_script],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        if helper_result.returncode != 0:
            raise AssertionError(f"packaged Windows runner helper failed: {helper_result.stderr}")
        observed = json.loads(helper_result.stdout)
        expected = {
            "exitCode": 0,
            "signal": None,
            "messages": [{"type": "target-exit", "exitCode": 7}],
            "stdout": "",
            "stderr": "",
        }
        if observed != expected:
            raise AssertionError(f"packaged Windows runner returned unexpected facts: {observed}")


def is_idle_notification(message: dict[str, object]) -> bool:
    """Return whether a JSON-RPC notification marks a session idle."""
    params = message.get("params")
    return (
        message.get("method") == "session.status"
        and isinstance(params, dict)
        and params.get("status") == "idle"
    )


class RuntimePeer:
    def __init__(self, argv: list[str], cwd: Path, environment: dict[str, str]) -> None:
        self.process = subprocess.Popen(
            argv,
            cwd=cwd,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.stdout: queue.Queue[str | None] = queue.Queue()
        self.stderr: list[str] = []
        threading.Thread(target=self._read_stdout, daemon=True).start()
        threading.Thread(target=self._read_stderr, daemon=True).start()

    def send(self, message: dict[str, object]) -> None:
        if self.process.stdin is None:
            raise RuntimeError("runtime stdin is unavailable")
        self.process.stdin.write(json.dumps(message) + "\n")
        self.process.stdin.flush()

    def read_until(self, predicate: Callable[[dict[str, object]], bool]) -> list[dict[str, object]]:
        deadline = time.monotonic() + 60
        messages: list[dict[str, object]] = []
        while time.monotonic() < deadline:
            try:
                line = self.stdout.get(timeout=min(0.25, deadline - time.monotonic()))
            except queue.Empty:
                continue
            if line is None:
                raise RuntimeError(f"runtime exited before expected message; stderr: {''.join(self.stderr)}")
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            messages.append(message)
            if predicate(message):
                return messages
        raise TimeoutError(f"runtime timed out; messages={messages}; stderr={''.join(self.stderr)}")

    def close(self) -> None:
        if self.process.stdin is not None and not self.process.stdin.closed:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        if self.process.returncode not in {0, -15}:
            raise RuntimeError(f"runtime exited {self.process.returncode}; stderr: {''.join(self.stderr)}")

    def _read_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.stdout.put(line)
        self.stdout.put(None)

    def _read_stderr(self) -> None:
        assert self.process.stderr is not None
        self.stderr.extend(self.process.stderr)


PERSISTED_SESSION_FILENAME = re.compile(r"^session(?:\.v([1-9]\d*))?\.jsonl(\.zstd)?$")
SNAPSHOT_SESSION_FILENAME = re.compile(
    r"^session(?:\.([1-9]\d*))?(?:\.v([1-9]\d*))?\.jsonl$",
)


def persisted_session_filename_version(path: Path, compressed: bool = False) -> int | None:
    """Return one canonical persistence basename's generation for the selected encoding."""
    match = PERSISTED_SESSION_FILENAME.fullmatch(path.name)
    if match is None or (match.group(2) is not None) != compressed:
        return None
    return int(match.group(1) or 0)


def latest_persisted_session_paths(sessions: Path, compressed: bool = False) -> list[Path]:
    """Select the numeric-highest immutable generation in each physical Session directory."""
    pattern = "*.jsonl.zstd" if compressed else "*.jsonl"
    selected: dict[Path, tuple[int, Path]] = {}
    for path in sessions.rglob(pattern):
        version = persisted_session_filename_version(path, compressed)
        if version is None:
            continue
        previous = selected.get(path.parent)
        if previous is None or version > previous[0]:
            selected[path.parent] = (version, path)
    return sorted((entry[1] for entry in selected.values()), key=lambda path: str(path))


def session_header_version(content: str, label: str) -> int:
    """Read a non-negative physical Session generation from the first JSONL record."""
    first = next((line for line in content.splitlines() if line), None)
    if first is None:
        raise AssertionError(f"{label}: Session log is empty")
    header = json.loads(first)
    version = header.get("version") if isinstance(header, dict) and header.get("type") == "session" else None
    if not isinstance(version, int) or isinstance(version, bool) or version < 0:
        raise AssertionError(f"{label}: Session header has no non-negative integer version")
    return version


def assert_current_session_version(version: int, label: str) -> None:
    """Require generated logs to use the source writer generation, independent of goldens."""
    source = Path(__file__).resolve().parents[1] / "packages/core/session/src/types.ts"
    declarations = re.findall(
        r"^export const SESSION_FORMAT_VERSION = ([0-9]+)$",
        source.read_text(encoding="utf-8"),
        re.MULTILINE,
    )
    if len(declarations) != 1:
        raise AssertionError(f"{source}: expected one literal SESSION_FORMAT_VERSION declaration")
    current_version = int(declarations[0])
    if version != current_version:
        raise AssertionError(
            f"{label}: expected current Session format v{current_version}, got v{version}",
        )


def assert_persisted_session_version(path: Path, content: str) -> int:
    """Require generated persistence filenames and headers to use the current generation."""
    filename_version = persisted_session_filename_version(path)
    if filename_version is None:
        raise AssertionError(f"non-canonical Session persistence filename: {path.name}")
    header_version = session_header_version(content, path.name)
    if filename_version != header_version:
        raise AssertionError(
            f"{path.name}: filename declares Session format v{filename_version}, "
            f"header declares v{header_version}",
        )
    assert_current_session_version(header_version, path.name)
    return header_version


def snapshot_session_filename(index: int, version: int) -> str:
    """Render parent/ordinal snapshot role plus an omitted-v0 generation."""
    if index < 0 or version < 0:
        raise ValueError("snapshot Session index and version must be non-negative")
    ordinal = "" if index == 0 else f".{index}"
    generation = "" if version == 0 else f".v{version}"
    return f"session{ordinal}{generation}.jsonl"


def parse_snapshot_session_filename(name: str) -> tuple[int, int] | None:
    """Parse one canonical parent/ordinal snapshot filename."""
    match = SNAPSHOT_SESSION_FILENAME.fullmatch(name)
    if match is None:
        if name.startswith("session") and name.endswith(".jsonl"):
            raise AssertionError(f"invalid snapshot Session filename: {name}")
        return None
    return int(match.group(1) or 0), int(match.group(2) or 0)


def selected_snapshot_session_files(directory: Path) -> dict[int, Path]:
    """Select one highest-generation expected file per parent/ordinal role."""
    selected: dict[int, tuple[int, Path]] = {}
    for path in directory.iterdir():
        if not path.is_file():
            continue
        parsed = parse_snapshot_session_filename(path.name)
        if parsed is None:
            continue
        index, version = parsed
        content = path.read_text(encoding="utf-8")
        header_version = session_header_version(content, path.name)
        if header_version != version:
            raise AssertionError(
                f"{path.name}: filename declares Session format v{version}, header declares v{header_version}",
            )
        previous = selected.get(index)
        if previous is None or version > previous[0]:
            selected[index] = (version, path)
    return {index: value[1] for index, value in selected.items()}


def assert_session_log(sessions: Path, cwd: Path, *expected_texts: str) -> None:
    logs = latest_persisted_session_paths(sessions)
    if len(logs) != 1:
        raise AssertionError(f"expected one JSONL session log under {sessions}, found {logs}")
    content = logs[0].read_text()
    assert_persisted_session_version(logs[0], content)
    lines = content.splitlines()
    header = json.loads(lines[0])
    if header.get("cwd") != str(cwd):
        raise AssertionError(f"session header cwd is not absolute/canonical: {header}")
    rendered = "\n".join(lines)
    for expected in expected_texts:
        if expected not in rendered:
            raise AssertionError(f"session log has no {expected!r} response: {logs[0]}")


def assert_zstd_session_log(sessions: Path) -> None:
    logs = latest_persisted_session_paths(sessions, compressed=True)
    if len(logs) != 1:
        raise AssertionError(f"expected one Zstandard JSONL session log under {sessions}, found {logs}")
    if not logs[0].read_bytes().startswith(bytes.fromhex("28b52ffd")):
        raise AssertionError(f"session log has no Zstandard magic: {logs[0]}")


def read_session_logs(sessions: Path) -> dict[str, list[dict[str, object]]]:
    """Parse every persisted JSONL session into a map keyed by header id."""
    logs: dict[str, list[dict[str, object]]] = {}
    for path in latest_persisted_session_paths(sessions):
        content = path.read_text(encoding="utf-8")
        assert_persisted_session_version(path, content)
        records = [
            json.loads(line)
            for line in content.splitlines()
            if line
        ]
        if not records or records[0].get("type") != "session":
            raise AssertionError(f"session log has no header: {path}")
        session_id = records[0].get("id")
        if not isinstance(session_id, str):
            raise AssertionError(f"session log header has no string id: {path}")
        if session_id in logs:
            raise AssertionError(f"duplicate persisted session id: {session_id}")
        logs[session_id] = records
    return logs


def snapshot_child_ids(result: "RunResult") -> list[str]:
    """Return the two child session ids in their SDK notification order."""
    child_ids: list[str] = []
    for notification in result.notifications:
        if notification.method != "subagent.started":
            continue
        payload = notification.payload
        if payload.get("parentSessionId") != SNAPSHOT_SESSION_ID:
            continue
        child_id = payload.get("childSessionId")
        if isinstance(child_id, str) and child_id not in child_ids:
            child_ids.append(child_id)
    if len(child_ids) != 2:
        raise AssertionError(f"advanced snapshot expected two child session ids: {child_ids}")
    return child_ids


def build_in_history_snapshot_files(
    result: "RunResult",
    requests: list[dict[str, object]],
    log: list[dict[str, object]],
) -> dict[str, str]:
    """Assert live requests, SDK subscriptions, and persistence retain both prompts."""
    systems = [event for event in result.events if event.get("type") == "system/message"]
    assert len(systems) == 2, systems
    assert [event.get("surfaceOp") for event in systems] == ["append", "append"], systems
    prompts = [message_text(event["data"]["message"]["content"]) for event in systems]
    assert "Python SDK prompt version 1." in prompts[0], prompts
    assert "Python SDK prompt version 2." not in prompts[0], prompts
    assert "Python SDK prompt version 2." in prompts[1], prompts
    assert "Python SDK prompt version 1." not in prompts[1], prompts
    assert prompts[0] != prompts[1], prompts
    assert [event for event in log if event.get("type") == "system/message"] == systems
    subscribed = [
        notification.payload["event"]
        for notification in result.notifications
        if notification.method == "session.event"
        and notification.payload.get("event", {}).get("type") == "system/message"
    ]
    assert subscribed == systems, subscribed
    contexts = [event["data"] for event in result.events if event.get("type") == "request/context"]
    assert contexts and all(context.get("systemPromptUpdate") == "in-history" for context in contexts), contexts
    assert len([event for event in result.events if event.get("type") == "request/header"]) == 1
    assert all(event.get("surfaceOp") in (None, "append") for event in result.events)
    first_tool = next(index for index, event in enumerate(result.events) if event.get("type") == "tool/result")
    assert result.events.index(systems[1]) > first_tool
    assert len(requests) == 3, requests
    request_prompts = []
    for index, request in enumerate(requests):
        messages = request["messages"]
        assert messages[0]["role"] == "system" and message_text(messages[0]["content"]) == prompts[0]
        assert request["tools"] == requests[0]["tools"], "prompt update changed tool schemas"
        positions = [position for position, message in enumerate(messages) if message["role"] == "system"]
        texts = [message_text(messages[position]["content"]) for position in positions]
        assert texts == (prompts[:1] if index == 0 else prompts), texts
        if index > 0:
            assert messages[positions[1] - 1]["role"] == "tool", messages
        request_prompts.append(texts)
    evidence = {
        "requestSystemPrompts": request_prompts,
        "systemMessageOperations": [event["surfaceOp"] for event in systems],
        "subscribedSystemPrompts": prompts,
        "requestContexts": contexts,
    }
    return {"prompt-history.json": json.dumps(evidence, indent=2, ensure_ascii=False) + "\n"}


def build_minimal_snapshot_files(
    requests: list[dict[str, object]],
    cwd: Path,
) -> dict[str, str]:
    """Render the minimal composition's model-visible surface as expected output.

    Every assembled system prompt, advertised tool schema, and system or user message is
    kept verbatim: they carry what the deployment actually shows the model, so a plugin
    that contributes an unintended system section or user message cannot pass unnoticed.
    Assistant and tool payloads keep only their call identity because their text differs
    across the platforms this expected output must replay on. The shipped profile omits
    dynamic runtime context, so every message it emits is compared.
    """
    snapshot = []
    for body in requests:
        messages = body.get("messages")
        if not isinstance(messages, list):
            raise AssertionError(f"minimal model request has no messages: {body}")
        snapshot.append({
            "tools": minimal_snapshot_text(body.get("tools"), cwd),
            "messages": [
                minimal_snapshot_message(message, cwd)
                for message in messages
            ],
        })
    return {"model-visible.json": json.dumps(snapshot, indent=2, ensure_ascii=False) + "\n"}


def minimal_snapshot_message(message: object, cwd: Path) -> dict[str, object]:
    """Reduce one model-visible message to its stable, behavior-carrying parts."""
    if not isinstance(message, dict):
        raise AssertionError(f"minimal model request has an invalid message: {message}")
    role = message.get("role")
    if role in ("system", "user"):
        return {"role": role, "text": minimal_snapshot_text(message_text(message.get("content")), cwd)}
    if role == "assistant":
        calls = message.get("tool_calls")
        if not isinstance(calls, list):
            raise AssertionError(f"minimal assistant message has no tool calls: {message}")
        return {
            "role": role,
            "toolCalls": [
                {"id": call.get("id"), "name": (call.get("function") or {}).get("name")}
                for call in calls
                if isinstance(call, dict)
            ],
        }
    if role == "tool":
        return {"role": role, "toolCallId": message.get("tool_call_id"), "text": "{{tool-result}}"}
    raise AssertionError(f"minimal model request has an unexpected message role: {message}")


def minimal_snapshot_text(value: object, cwd: Path) -> object:
    """Replace the scenario's temporary working directory everywhere it appears."""
    if isinstance(value, str):
        return value.replace(str(cwd), "{{cwd}}")
    if isinstance(value, list):
        return [minimal_snapshot_text(item, cwd) for item in value]
    if isinstance(value, dict):
        return {key: minimal_snapshot_text(item, cwd) for key, item in value.items()}
    return value


def build_snapshot_files(
    result: "RunResult",
    logs: dict[str, list[dict[str, object]]],
    child_ids: list[str],
    cwd: Path,
) -> dict[str, str]:
    """Render the SDK result and three persisted logs into stable expected outputs."""
    replacements = [(str(cwd), "{{cwd}}"), (SNAPSHOT_SESSION_ID, "{{parent}}")]
    replacements.append((snapshot_workflow_run_id(result), "{{workflow-run}}"))
    for index, child_id in enumerate(child_ids, start=1):
        replacements.append((child_id, f"{{{{child-{index}}}}}"))
        agent_id = snapshot_agent_id(result, child_id)
        replacements.append((agent_id, f"{{{{agent-{index}}}}}"))
    command_index = 0
    for record in logs[SNAPSHOT_SESSION_ID]:
        data = record.get("data")
        if record.get("type") == "command/run" and isinstance(data, dict):
            command_index += 1
            replacements.append((data["commandId"], f"{{{{command:{command_index}}}}}"))
        if record.get("type") == "command/done" and isinstance(data, dict):
            anonymous = re.search(r"Anonymous user: ([0-9a-f-]{36})", str(data.get("text")))
            if anonymous is not None:
                replacements.append((anonymous.group(1), "{{anonymous-user}}"))
    feedback_targets = dict.fromkeys(
        record["data"]["item"]["messageId"]
        for record in logs[SNAPSHOT_SESSION_ID]
        if record.get("type") == "feedback/message-put"
    )
    for index, message_id in enumerate(feedback_targets, start=1):
        replacements.append((message_id, f"{{{{message:{index}}}}}"))
    feedback_versions = dict.fromkeys(
        record["data"]["item"]["version"]
        for record in logs[SNAPSHOT_SESSION_ID]
        if record.get("type") == "feedback/message-put"
    )
    for index, version in enumerate(feedback_versions, start=1):
        replacements.append((version, f"{{{{feedback-version:{index}}}}}"))
    replacements.sort(key=lambda pair: len(pair[0]), reverse=True)

    result_value = {
        "session_id": result.session_id,
        "final_response": result.final_response,
        "events": result.events,
        "notifications": [
            {"method": notification.method, "payload": notification.payload}
            for notification in result.notifications
        ],
    }
    normalized_result = normalize_snapshot_value(result_value, replacements)
    parent_records = project_session_snapshot([
        normalize_snapshot_value(record, replacements) for record in logs[SNAPSHOT_SESSION_ID]
    ])
    files = {
        "result.json": json.dumps(normalized_result, indent=2, ensure_ascii=False) + "\n",
        snapshot_session_filename(
            0, session_header_version(render_jsonl(parent_records), "advanced parent"),
        ): render_jsonl(parent_records),
    }
    for index, child_id in enumerate(child_ids, start=1):
        child_records = project_session_snapshot([
            normalize_snapshot_value(record, replacements) for record in logs[child_id]
        ])
        child_content = render_jsonl(child_records)
        files[snapshot_session_filename(
            index, session_header_version(child_content, f"advanced child {index}"),
        )] = child_content
    return files


def build_restart_snapshot_files(
    first: "RunResult",
    second: "RunResult",
    requests: list[dict[str, object]],
    logs: dict[str, list[dict[str, object]]],
    cwd: Path,
    sessions: Path,
) -> dict[str, str]:
    """Render two SDK processes, isolated model histories, and durable logs."""
    replacements = [
        (str(sessions), "{{sessions}}"),
        (str(cwd), "{{cwd}}"),
        (RESTART_FIRST_SESSION_ID, "{{session-1}}"),
        (RESTART_SECOND_SESSION_ID, "{{session-2}}"),
    ]
    result_value = [
        {
            "session_id": result.session_id,
            "final_response": result.final_response,
            "finish_reason": result.finish_reason,
            "eventTypes": [
                event.get("type")
                for event in result.events
            ],
            "notificationMethods": [
                notification.method
                for notification in result.notifications
            ],
        }
        for result in (first, second)
    ]
    request_value = [
        {
            "model": request.get("model"),
            "messages": restart_request_messages(request),
            "toolNames": sorted(advertised_tool_names(request)),
        }
        for request in requests
    ]
    first_records = project_session_snapshot([
        normalize_snapshot_value(record, replacements) for record in logs[RESTART_FIRST_SESSION_ID]
    ])
    second_records = project_session_snapshot([
        normalize_snapshot_value(record, replacements) for record in logs[RESTART_SECOND_SESSION_ID]
    ])
    first_content = render_jsonl(first_records)
    second_content = render_jsonl(second_records)
    return {
        "result.json": json.dumps(
            normalize_snapshot_value(result_value, replacements), indent=2, ensure_ascii=False,
        ) + "\n",
        "requests.json": json.dumps(
            normalize_snapshot_value(request_value, replacements), indent=2, ensure_ascii=False,
        ) + "\n",
        snapshot_session_filename(
            1, session_header_version(first_content, "restart Session 1"),
        ): first_content,
        snapshot_session_filename(
            2, session_header_version(second_content, "restart Session 2"),
        ): second_content,
    }


def restart_request_messages(request: dict[str, object]) -> list[object]:
    """Project model history while tokenizing composition-owned system prose."""
    messages = request.get("messages")
    if not isinstance(messages, list):
        raise AssertionError(f"restart snapshot request has no messages: {request}")
    return [
        {"role": "system", "content": "{{system}}"}
        if isinstance(message, dict) and message.get("role") == "system"
        else message
        for message in messages
    ]


def snapshot_workflow_run_id(result: "RunResult") -> str:
    """Return the one workflow run id emitted by the advanced scenario."""
    run_ids: set[str] = set()
    for event in result.events:
        event_type = event.get("type")
        data = event.get("data")
        if not isinstance(event_type, str) or not event_type.startswith("tool-workflow/"):
            continue
        if isinstance(data, dict) and isinstance(data.get("runId"), str):
            run_ids.add(data["runId"])
    if len(run_ids) != 1:
        raise AssertionError(f"advanced snapshot expected one workflow run id: {sorted(run_ids)}")
    return next(iter(run_ids))


def snapshot_agent_id(result: "RunResult", child_id: str) -> str:
    """Find the successful subagent id paired with one child session."""
    for notification in result.notifications:
        if notification.method != "subagent.finished":
            continue
        payload = notification.payload
        if payload.get("childSessionId") != child_id:
            continue
        if payload.get("provider") != "spawn" or payload.get("status") != "ok":
            raise AssertionError(f"advanced child did not finish successfully: {payload}")
        agent_id = payload.get("agentId")
        if isinstance(agent_id, str):
            return agent_id
    raise AssertionError(f"advanced snapshot has no finished agent for child {child_id}")


def normalize_snapshot_value(
    value: object,
    replacements: list[tuple[str, str]],
) -> object:
    """Scrub volatile values and bulky request headers without losing behavior."""
    if isinstance(value, str):
        normalized = value
        for actual, token in replacements:
            normalized = normalized.replace(actual, token)
        return normalized
    if isinstance(value, list):
        return [normalize_snapshot_value(item, replacements) for item in value]
    if not isinstance(value, dict):
        return value

    normalized = {
        key: normalize_snapshot_value(item, replacements)
        for key, item in value.items()
    }
    if normalized.get("type") == "session" and "createdAt" in normalized:
        normalized["createdAt"] = 0
    if normalized.get("type") == "subagent/catalog":
        data = normalized.get("data")
        if isinstance(data, dict) and "childCreatedAt" in data:
            data["childCreatedAt"] = 0
    if "seq" in normalized and "time" in normalized:
        normalized["time"] = 0
    if normalized.get("type") in ("assistant/message", "assistant/attempt"):
        data = normalized.get("data")
        stream = data.get("stream") if isinstance(data, dict) else None
        if isinstance(stream, list):
            for member in stream:
                if not isinstance(member, dict):
                    continue
                if isinstance(member.get("time"), (int, float)):
                    member["time"] = 0
                if isinstance(member.get("time0"), (int, float)):
                    member["time0"] = 0
                dt = member.get("dt")
                if isinstance(dt, list):
                    member["dt"] = [0] * len(dt)
    if isinstance(normalized.get("id"), str) and normalized.get("role") in ("assistant", "system", "user"):
        if not normalized["id"].startswith("{{message:"):
            normalized["id"] = "{{messageId}}"
    if normalized.get("type") in ("feedback/message-put", "feedback/message-delete"):
        data = normalized.get("data")
        if isinstance(data, dict):
            item = data.get("item") if normalized["type"] == "feedback/message-put" else data
            if isinstance(item, dict):
                if normalized["type"] == "feedback/message-put":
                    item["createdAt"] = 0
                    item["updatedAt"] = 0
    scrub_snapshot_header(normalized)
    scrub_snapshot_system_message(normalized)
    return normalized


def scrub_snapshot_header(value: dict[object, object]) -> None:
    """Tokenize full request-header tool schemas while retaining tool names."""
    data = value.get("data")
    if not isinstance(data, dict):
        return
    if value.get("type") == "request/header":
        header = data.get("header")
        if not isinstance(header, dict):
            return
        tools = header.get("tools")
        if isinstance(tools, list):
            header["tools"] = [
                tool.get("name") if isinstance(tool, dict) else "{{tools}}"
                for tool in tools
            ]


def scrub_snapshot_system_message(value: dict[object, object]) -> None:
    """Tokenize the rendered prompt text of a `system/message` surface node."""
    if value.get("type") != "system/message":
        return
    data = value.get("data")
    message = data.get("message") if isinstance(data, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if not isinstance(content, list):
        return
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            block["text"] = "{{system}}"


def render_jsonl(records: list[object]) -> str:
    """Render parsed JSON values as compact, newline-terminated JSONL."""
    return "".join(
        json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        for record in records
    )


def project_session_snapshot(records: list[dict[str, object]]) -> list[dict[str, object]]:
    """Omit storage sequence/time envelopes from snapshot body records."""
    projected = [dict(record) for record in records]
    for record in projected[1:]:
        for key in ("seq", "time", "seq0", "time0"):
            record.pop(key, None)
    return projected


SESSION_FORMAT_PROVENANCE = "{{sessionFormatVersion}}"


def expand_snapshot_stream_member(member: object) -> list[dict[str, object]]:
    """Expand one compact Assistant stream member into logical provider chunks."""
    if not isinstance(member, dict):
        raise AssertionError(f"snapshot Assistant stream member is not an object: {member!r}")
    member_type = member.get("type")
    if member_type == "chunk":
        chunk = member.get("chunk")
        if not isinstance(chunk, dict):
            raise AssertionError(f"snapshot Assistant chunk member has no chunk: {member!r}")
        return [chunk]
    packed_kinds = {
        "text-chunks": ("texts", "text-delta", "text"),
        "reasoning-chunks": ("texts", "reasoning-delta", "text"),
        "tool-call-chunks": ("args", "tool-call-delta", "argumentsDelta"),
    }
    packed = packed_kinds.get(member_type)
    if packed is None:
        raise AssertionError(f"snapshot Assistant stream has unknown member type: {member_type!r}")
    values_key, chunk_type, value_key = packed
    values = member.get(values_key)
    if not isinstance(values, list):
        raise AssertionError(f"snapshot Assistant stream member has no {values_key}: {member!r}")
    shared = {
        key: member[key]
        for key in ("index", "id", "name")
        if key in member
    }
    return [
        {"type": chunk_type, **shared, value_key: value}
        for value in values
    ]


def expand_snapshot_assistant_event(value: object) -> list[object]:
    """Expand one direct or SDK-wrapped v2 settlement for generation-neutral comparison."""
    if not isinstance(value, dict):
        return [value]
    event = value
    wrapper_key: str | None = None
    wrapper: dict[str, object] | None = None
    if value.get("method") == "session.event":
        for candidate in ("payload", "params"):
            container = value.get(candidate)
            nested = container.get("event") if isinstance(container, dict) else None
            if isinstance(nested, dict):
                event = nested
                wrapper_key = candidate
                wrapper = container
                break
    if event.get("type") not in ("assistant/message", "assistant/attempt"):
        return [value]
    data = event.get("data")
    stream = data.get("stream") if isinstance(data, dict) else None
    if not isinstance(stream, list):
        return [value]

    def wrap(expanded: dict[str, object]) -> object:
        if wrapper_key is None or wrapper is None:
            return expanded
        return {**value, wrapper_key: {**wrapper, "event": expanded}}

    common = {
        key: data[key]
        for key in ("turn", "step")
        if key in data
    }
    expanded = [
        wrap({
            "type": "assistant/chunk",
            "data": {**common, "chunk": chunk},
        })
        for member in stream
        for chunk in expand_snapshot_stream_member(member)
    ]
    if event.get("type") == "assistant/message":
        expanded.append(wrap({
            **event,
            "data": {key: item for key, item in data.items() if key != "stream"},
        }))
    return expanded


def normalize_session_format_comparison(
    value: object,
    source_session_version: int | None = None,
) -> object:
    """Canonicalize only generation provenance that differs across immutable Session files."""
    if isinstance(value, list):
        return [
            normalize_session_format_comparison(expanded, source_session_version)
            for item in value
            for expanded in expand_snapshot_assistant_event(item)
        ]
    if not isinstance(value, dict):
        return value

    normalized = {
        key: normalize_session_format_comparison(item, source_session_version)
        for key, item in value.items()
    }
    if normalized.get("type") == "session" and "version" in normalized:
        normalized["version"] = SESSION_FORMAT_PROVENANCE
        normalized.setdefault("isSeeded", False)
        ordered_header = {
            key: normalized[key]
            for key in ("type", "version", "id", "createdAt", "cwd", "isSeeded", "delegationDepth")
            if key in normalized
        }
        normalized = {
            **ordered_header,
            **{key: item for key, item in normalized.items() if key not in ordered_header},
        }
    if isinstance(normalized.get("type"), str) and "data" in normalized:
        normalized.pop("seq", None)
        normalized.pop("time", None)
    if source_session_version == 1 and normalized.get("type") == "assistant/message":
        normalized.pop("sourceEventSeqs", None)
    return normalized


def normalize_snapshot_comparison_text(name: str, content: str) -> str:
    """Normalize Session generation provenance only while comparing committed expected outputs."""
    if name.startswith("session") and name.endswith(".jsonl"):
        parsed = [json.loads(line) for line in content.splitlines() if line]
        header = parsed[0] if parsed else None
        source_version = header.get("version") if isinstance(header, dict) else None
        if not isinstance(source_version, int):
            raise AssertionError(f"{name}: snapshot Session header has no integer format version")
        records = [
            normalize_session_format_comparison(expanded, source_version)
            for record in parsed
            for expanded in expand_snapshot_assistant_event(record)
        ]
        return render_jsonl(records)
    if name.endswith(".json"):
        return json.dumps(
            normalize_session_format_comparison(json.loads(content)),
            indent=2,
            ensure_ascii=False,
        ) + "\n"
    return content


def compare_snapshot_files(
    files: dict[str, str],
    update: bool,
    directory: Path,
    filenames: tuple[str, ...],
) -> None:
    """Compare ordered artifact roles and Session content across generations, or write generated filenames."""
    scenario = directory.name

    def role_name(name: str) -> str:
        parsed = parse_snapshot_session_filename(name)
        return name if parsed is None else snapshot_session_filename(parsed[0], 0)

    if tuple(map(role_name, files)) != tuple(map(role_name, filenames)):
        raise AssertionError(f"{scenario} snapshot builder produced {tuple(files)}, expected {filenames}")
    for name, content in files.items():
        if parse_snapshot_session_filename(name) is not None:
            assert_current_session_version(session_header_version(content, name), name)
    if update:
        directory.mkdir(parents=True, exist_ok=True)
        for name, content in files.items():
            (directory / name).write_text(content, encoding="utf-8", newline="\n")
        print(f"smoke-python-runtime: updated snapshots in {directory}")

    existing = [path for path in directory.iterdir() if path.is_file()] if directory.is_dir() else []
    expected_non_session = {
        name for name in filenames if parse_snapshot_session_filename(name) is None
    }
    existing_non_session = {
        path.name for path in existing if parse_snapshot_session_filename(path.name) is None
    }
    if existing_non_session != expected_non_session:
        raise AssertionError(
            f"{scenario} snapshot files differ: "
            f"missing={sorted(expected_non_session - existing_non_session)}, "
            f"unexpected={sorted(existing_non_session - expected_non_session)}"
        )
    selected_expected = selected_snapshot_session_files(directory)
    actual_sessions: dict[int, tuple[str, str]] = {}
    for name, content in files.items():
        parsed = parse_snapshot_session_filename(name)
        if parsed is None:
            continue
        index, filename_version = parsed
        header_version = session_header_version(content, name)
        if filename_version != header_version:
            raise AssertionError(
                f"{name}: filename declares Session format v{filename_version}, "
                f"header declares v{header_version}",
            )
        if index in actual_sessions:
            raise AssertionError(f"{scenario} snapshot builder produced duplicate Session role {index}")
        actual_sessions[index] = (name, content)
    if set(selected_expected) != set(actual_sessions):
        raise AssertionError(
            f"{scenario} snapshot Session roles differ: "
            f"expected={sorted(selected_expected)}, actual={sorted(actual_sessions)}",
        )
    for name, actual in files.items():
        parsed = parse_snapshot_session_filename(name)
        expected_path = directory / name if parsed is None else selected_expected[parsed[0]]
        expected_text = expected_path.read_text(encoding="utf-8")
        compared_actual = normalize_snapshot_comparison_text(name, actual)
        compared_expected = normalize_snapshot_comparison_text(expected_path.name, expected_text)
        if compared_actual == compared_expected:
            continue
        diff = "".join(difflib.unified_diff(
            compared_expected.splitlines(keepends=True),
            compared_actual.splitlines(keepends=True),
            fromfile=f"expected/{expected_path.name}",
            tofile=f"actual/{name}",
        ))
        raise AssertionError(
            f"{scenario} executable snapshot mismatch in {name}; "
            "rerun with --update-snapshots after reviewing the behavior\n"
            f"{diff}"
        )


if __name__ == "__main__":
    main()
