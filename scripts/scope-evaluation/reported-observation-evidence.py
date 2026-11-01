"""Run independent Python decoder assertions without importing or launching the SDK smoke application."""

import ast
import copy
import hashlib
import json
from pathlib import Path
import re
import sys


def main() -> None:
    source = Path(__file__).resolve().parents[1] / "smoke-python-runtime.py"
    module = ast.parse(source.read_text(encoding="utf-8"), filename=str(source))
    names = {"expand_reported_grants", "expand_reported_grant_table", "expand_reported_observation_table",
             "reported_result_warning", "reported_fields", "reported_integer", "reported_digest",
             "reported_length", "reported_permission_source"}
    selected = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name in names]
    assert {node.name for node in selected} == names, "independent decoder definitions missing"
    namespace = {"copy": copy, "hashlib": hashlib, "json": json, "re": re}
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(source), "exec"), namespace)
    cases = json.load(sys.stdin)
    for index, case in enumerate(cases):
        before = copy.deepcopy(case["body"])
        try:
            actual = namespace["expand_reported_grants"](case["body"], case["revision"])
        except AssertionError as error:
            assert "error" in case and case["error"] in str(error), f"case {index}: unexpected rejection: {error}"
        else:
            assert "error" not in case, f"case {index}: malformed table accepted"
            assert actual == case["expected"], f"case {index}: full fields or exact text differ"
        assert case["body"] == before, f"case {index}: decoder mutated its input"
    print(json.dumps({"cases": len(cases), "passed": len(cases)}))


if __name__ == "__main__":
    main()
