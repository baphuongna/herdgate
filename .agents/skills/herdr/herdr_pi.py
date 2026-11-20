"""Portable Pi profiles and read-only observation of Herdr/Pi requests."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tomllib
import uuid

MAX_PROFILE_BYTES = 64 * 1024
MAX_SESSION_BYTES = 32 * 1024 * 1024
MAX_ANSWER_CHARS = 24_000
NAME = re.compile(r"[a-z][a-z0-9_-]{0,63}")
MODEL = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9._-]*(?:/[a-zA-Z0-9][a-zA-Z0-9._-]*)+")
PANE = re.compile(r"w[0-9]+:p[0-9]+")
THINKING = {"off", "minimal", "low", "medium", "high", "xhigh", "max"}


class Unverified(Exception):
    """An input or observation cannot be used as evidence."""


def load_profiles(path: Path) -> dict:
    try:
        with path.open("rb") as source:
            data = source.read(MAX_PROFILE_BYTES + 1)
        if len(data) > MAX_PROFILE_BYTES:
            raise Unverified("profile_file_too_large")
        doc = tomllib.loads(data.decode("utf-8"))
    except (OSError, UnicodeError, ValueError) as exc:
        raise Unverified("profile_file_unreadable_or_invalid") from exc
    version = doc.get("schema_version")
    profiles = doc.get("profiles")
    if (set(doc) != {"schema_version", "profiles"} or type(version) is not int
            or version != 1 or not isinstance(profiles, dict) or not profiles):
        raise Unverified("invalid_profile_schema")
    result = {}
    for name, values in sorted(profiles.items()):
        if not NAME.fullmatch(name) or not isinstance(values, dict):
            raise Unverified("invalid_profile")
        if values.keys() - {"notes", "model", "thinking"}:
            raise Unverified("unsupported_profile_field")
        notes = values.get("notes", "")
        if not isinstance(notes, str) or len(notes) > 500:
            raise Unverified("invalid_profile_notes")
        args = []
        if "model" in values:
            model = values["model"]
            if not isinstance(model, str) or len(model) > 200 or not MODEL.fullmatch(model):
                raise Unverified("invalid_profile_model")
            args.extend(["--model", model])
        if "thinking" in values:
            thinking = values["thinking"]
            if not isinstance(thinking, str) or thinking not in THINKING:
                raise Unverified("invalid_profile_thinking")
            args.extend(["--thinking", thinking])
        result[name] = {"name": name, "notes": notes, "kind": "pi", "pi_args": args}
    return result


def marker(request_id: uuid.UUID) -> str:
    return f"[herdr-request:{request_id}]"


def file_signature(info: os.stat_result) -> tuple:
    # Windows stat/fstat can disagree on ctime for the same file.
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def read_snapshot(path: Path) -> bytes:
    if not path.is_absolute() or path.suffix.lower() != ".jsonl" or path.drive.startswith("\\\\"):
        raise Unverified("expected_absolute_local_session_path")
    try:
        info = path.stat()
        if not stat.S_ISREG(info.st_mode):
            raise Unverified("expected_regular_session_file")
        if info.st_size > MAX_SESSION_BYTES:
            raise Unverified("session_too_large")
        with path.open("rb") as source:
            before = os.fstat(source.fileno())
            data = source.read(MAX_SESSION_BYTES + 1)
            after = os.fstat(source.fileno())
        current = path.stat()
    except OSError as exc:
        raise Unverified("session_unreadable") from exc
    if not (file_signature(info) == file_signature(before) == file_signature(after) == file_signature(current)
            and len(data) == before.st_size):
        raise Unverified("session_changed_during_read")
    return data


def text_content(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list) and all(isinstance(item, dict) for item in content):
        texts = [item.get("text") for item in content if item.get("type") == "text"]
        if all(isinstance(value, str) for value in texts):
            return "\n".join(texts)
    raise Unverified("invalid_message_content")


def unique_fields(pairs):
    row = {}
    for key, value in pairs:
        if key in row:
            raise Unverified("duplicate_session_field")
        row[key] = value
    return row


def observe_snapshot(data: bytes, request_id: uuid.UUID, include_answer: bool = False,
                     expected_session: str | None = None) -> dict:
    if not data or not data.endswith(b"\n"):
        raise Unverified("incomplete_session_snapshot")
    entries = set()
    matched = None
    descendants = set()
    parents_with_child = set()
    assistant = None
    boundary = None
    session_id = None
    for i, line in enumerate(data.split(b"\n")[:-1]):
        try:
            row = json.loads(line.decode("utf-8"), object_pairs_hook=unique_fields)
        except (ValueError, RecursionError) as exc:
            raise Unverified("invalid_session_json") from exc
        if not isinstance(row, dict) or not isinstance(row.get("type"), str):
            raise Unverified("invalid_session_entry")
        entry_type = row["type"]
        entry_id = row.get("id")
        if not isinstance(entry_id, str) or not entry_id:
            raise Unverified("invalid_session_entry_id")
        if i == 0:
            version = row.get("version")
            if entry_type != "session" or type(version) is not int or version != 3:
                raise Unverified("unsupported_session_format")
            if expected_session is not None and entry_id != expected_session:
                raise Unverified("unexpected_session_id")
            session_id = entry_id
            continue
        parent = row.get("parentId")
        if (entry_type == "session" or entry_id in entries or "parentId" not in row
                or (parent is not None and (not isinstance(parent, str) or parent not in entries))):
            raise Unverified("invalid_session_tree")
        entries.add(entry_id)
        msg = row.get("message") if entry_type == "message" else {}
        if not isinstance(msg, dict) or (entry_type == "message" and not isinstance(msg.get("role"), str)):
            raise Unverified("invalid_session_message")
        role = msg.get("role")
        if role == "user" and text_content(msg.get("content")).partition("\n")[0].rstrip("\r") == marker(request_id):
            if matched is not None:
                raise Unverified("duplicate_request_marker")
            matched = entry_id
            descendants.add(entry_id)
        elif parent in descendants:
            if parent in parents_with_child:
                raise Unverified("ambiguous_request_branch")
            parents_with_child.add(parent)
            if role == "user":
                boundary = entry_id
            else:
                descendants.add(entry_id)
                if role == "assistant":
                    assistant = (entry_id, msg)

    if session_id is None:
        raise Unverified("missing_session_header")
    result = {"request_id": str(request_id), "session_id": session_id}
    if matched is None:
        return {**result, "status": "request_not_observed"}
    result.update(request_entry_id=matched, status="request_observed")
    if boundary:
        result["next_user_entry_id"] = boundary
    if assistant and assistant[1].get("stopReason") == "stop":
        content = assistant[1].get("content")
        if isinstance(content, list) and any(
                isinstance(block, dict) and block.get("type") == "toolCall" for block in content):
            return result
        answer = text_content(content).strip()
        if answer:
            result.update(status="response_observed", response_entry_id=assistant[0])
            if include_answer:
                result.update(answer=answer[:MAX_ANSWER_CHARS], answer_truncated=len(answer) > MAX_ANSWER_CHARS)
    return result


def pane_binding(pane: str) -> tuple[str, str, Path]:
    if not PANE.fullmatch(pane):
        raise Unverified("expected_explicit_pane_id")
    if os.environ.get("HERDR_ENV") != "1" or not os.environ.get("HERDR_PANE_ID"):
        raise Unverified("not_in_herdr_pane")
    binary = os.environ.get("HERDR_BIN_PATH") or shutil.which("herdr")
    if not binary or (os.name == "nt" and Path(binary).suffix.lower() != ".exe"):
        raise Unverified("herdr_native_binary_unavailable")
    try:
        run = subprocess.run([binary, "agent", "get", pane], capture_output=True, timeout=5, check=True)
        agent = json.loads(run.stdout)["result"]["agent"]
        session = agent["agent_session"]
        terminal = agent["terminal_id"]
        if (agent.get("pane_id") != pane or agent.get("agent") != "pi" or not isinstance(terminal, str)
                or not terminal or session.get("agent") != "pi" or session.get("kind") != "path"
                or session.get("source") != "herdr:pi" or not isinstance(session.get("value"), str)):
            raise Unverified("pane_has_no_reported_pi_session")
        return pane, terminal, Path(session["value"])
    except (OSError, KeyError, TypeError, AttributeError, ValueError, RecursionError, subprocess.SubprocessError) as exc:
        raise Unverified("pane_session_lookup_failed") from exc


def observe(request_id: uuid.UUID, pane: str | None, session_file: Path | None,
            include_answer: bool = False, expected_session: str | None = None) -> dict:
    binding = pane_binding(pane) if pane else None
    path = binding[2] if binding else session_file
    if path is None:
        raise Unverified("missing_session_target")
    result = observe_snapshot(read_snapshot(path), request_id, include_answer, expected_session)
    if binding and pane_binding(binding[0]) != binding:
        raise Unverified("pane_session_changed_during_read")
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    profile = commands.add_parser("profile", help="read a local, explicitly selected TOML profile catalog")
    profile_commands = profile.add_subparsers(dest="action", required=True)
    for action in ("list", "show"):
        sub = profile_commands.add_parser(action)
        sub.add_argument("--file", type=Path, required=True)
        if action == "show":
            sub.add_argument("name")
    commands.add_parser("new-request", help="generate a request ID and prompt marker; never sends it")
    query = commands.add_parser("observe", help="observe a single request without sending or waiting")
    query.add_argument("request_id", type=uuid.UUID)
    target = query.add_mutually_exclusive_group(required=True)
    target.add_argument("--pane", help="explicit local Herdr pane ID")
    target.add_argument("--session-file", type=Path, help="absolute local path to a Pi JSONL session")
    query.add_argument("--expect-session", help="require the expected Pi session header ID")
    query.add_argument("--include-answer", action="store_true", help="allow returning assistant text")
    args = parser.parse_args(argv)
    code = 0
    try:
        if args.command == "profile":
            profiles = load_profiles(args.file)
            if args.action == "list":
                result = {"profiles": [{"name": item["name"], "notes": item["notes"]} for item in profiles.values()]}
            elif args.name in profiles:
                result = {"profile": profiles[args.name]}
            else:
                raise Unverified("unknown_profile")
        elif args.command == "new-request":
            request_id = uuid.uuid4()
            result = {"request_id": str(request_id), "marker": marker(request_id)}
        else:
            result = observe(args.request_id, args.pane, args.session_file, args.include_answer, args.expect_session)
            code = 0 if result["status"] == "response_observed" else 1
    except Unverified as exc:
        result = {"status": "unverified", "reason": str(exc)}
        if args.command == "observe":
            result["request_id"] = str(args.request_id)
        code = 2
    print(json.dumps(result))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
