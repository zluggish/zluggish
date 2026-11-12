"""Shared JSONC loading and editing. No application or legacy configuration imports."""
from contextlib import closing
from copy import deepcopy
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import tempfile

from filelock import FileLock, Timeout
from json5.loader import loads as load_model, ModelLoader
from json5.dumper import dumps as dump_model, ModelDumper
from json5.model import JSONObject, JSONArray, Comment
from json5.tokenizer import tokenize
from jsonschema import Draft202012Validator

from .schema import SERVER, USER, PELOTON, SOLO_BLOB, defaults


class ConfigError(ValueError):
    """An actionable configuration error, safe to display without source values."""


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ConfigError("duplicate object key")
        result[key] = value
    return result


def parse(text, path="configuration"):
    """Use the dependency's lexer, then stdlib JSON for strict JSONC semantics."""
    try:
        tokens = list(tokenize(text))
        significant = [t for t in tokens if t.type not in ("WHITESPACE", "LINE_COMMENT", "BLOCK_COMMENT")]
        trailing = {a.index for previous, a, b in zip(significant, significant[1:], significant[2:])
                    if a.type == "COMMA" and b.type in ("RBRACE", "RBRACKET")
                    and previous.type not in ("COMMA", "LBRACE", "LBRACKET", "COLON")}
        chars = list(text)
        for token in tokens:
            if token.type in ("LINE_COMMENT", "BLOCK_COMMENT") or token.index in trailing:
                chars[token.index:token.end] = [c if c in "\r\n" else " " for c in text[token.index:token.end]]
        value = json.loads("".join(chars), object_pairs_hook=_pairs,
                           parse_constant=lambda _: (_ for _ in ()).throw(ConfigError("non-finite number")))
        # The JSON decoder also accepts overflowing exponents.
        def finite(v):
            if isinstance(v, float) and not math.isfinite(v):
                raise ConfigError("non-finite number")
            if isinstance(v, dict):
                for item in v.values():
                    finite(item)
            elif isinstance(v, list):
                for item in v:
                    finite(item)
        finite(value)
        return value
    except json.JSONDecodeError as exc:
        raise ConfigError(f"{path}:{exc.lineno}:{exc.colno}: invalid JSONC") from None
    except ConfigError as exc:
        raise ConfigError(f"{path}: {exc}") from None
    except Exception:
        # Lexer errors can include source/secret contents; never echo those.
        raise ConfigError(f"{path}: invalid JSONC syntax") from None


def validate(value, schema, path="configuration"):
    if schema is SERVER and (any(k in value.get("server", {}) for k in ("multiplayer", "family_mode")) or "launcher" in value or "mail" in value):
        raise ConfigError(f"{path}: retired account/launcher/mail settings; stop the server and run zluggish accounts migrate")
    error = next(Draft202012Validator(schema).iter_errors(value), None)
    if error:
        key = ".".join(map(str, error.absolute_path)) or "<root>"
        raise ConfigError(f"{path}: {key}: failed {error.validator} validation")
    return value


def merge(base, overrides):
    result = deepcopy(base)
    for key, value in overrides.items():
        result[key] = merge(result.get(key, {}), value) if isinstance(value, dict) else deepcopy(value)
    return result


def read_document(path, schema, fallback=None):
    path = Path(path)
    if not path.exists() and fallback is not None:
        return deepcopy(fallback)
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeError:
        raise ConfigError(f"{path}: expected UTF-8 text") from None
    value = parse(text, path)
    return validate(value, schema, path)


@dataclass(frozen=True)
class Paths:
    storage: Path
    config: Path


def paths(storage=None, config=None, source=None):
    chosen = storage or os.environ.get("ZLUGGISH_STORAGE_DIR")
    if not chosen:
        if getattr(sys, "frozen", False):
            chosen = Path(sys.executable).parent / "storage"
        elif source:
            chosen = Path(source).resolve().parent / "storage"
        else:
            root = Path(__file__).resolve().parent.parent
            if not (root / "standalone.py").is_file():
                raise ConfigError("Select the server installation with --storage-dir or ZLUGGISH_STORAGE_DIR")
            chosen = root / "storage"
    storage = Path(chosen).expanduser().resolve()
    config = Path(config or os.environ.get("ZLUGGISH_CONFIG") or storage / "config.jsonc").expanduser().resolve()
    return Paths(storage, config)


def database_users(storage):
    """Identity lookup only. Preferences in the database belong to CLI migration."""
    db = Path(storage) / "zwift-offline.db"
    if not db.exists():
        return set()
    with closing(sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)) as connection:
        if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user'").fetchone():
            return set()
        return {int(row[0]) for row in connection.execute('SELECT player_id FROM "user"')}


def user_path(location, user=None):
    if user is None:
        raise ConfigError("Select a rider with --user ID; anonymous settings are retired")
    if isinstance(user, bool) or not str(user).isdigit() or int(user) < 1:
        raise ConfigError("--user must be an existing positive player ID")
    if int(user) not in database_users(location.storage):
        raise ConfigError("Unknown player ID")
    return location.storage / str(int(user)) / "settings.jsonc"


ENV = {"ZOFFLINE_SERVER_HOST": ("network.host", str), "LOGLEVEL": ("logging.level", str)}
for _name in ("CDN", "TCP", "UDP", "API"):
    ENV[f"ZOFFLINE_{_name}_HOST"] = (f"network.{_name.lower()}.host", str)
    ENV[f"ZOFFLINE_{_name}_PORT"] = (f"network.{_name.lower()}.port", int)


def strict_bool(value):
    if value.lower() not in ("true", "false"):
        raise ValueError()
    return value.lower() == "true"


ENV["ZOFFLINE_API_USE_CERT"] = ("network.api.use_cert", strict_bool)


def assign(doc, key, value):
    parts = key.split(".")
    for part in parts[:-1]:
        doc = doc.setdefault(part, {})
    doc[parts[-1]] = value


def get(doc, key):
    try:
        for part in key.split("."):
            doc = doc[part]
        return doc
    except (KeyError, TypeError):
        raise ConfigError("Unknown setting key") from None


def load_server(location, environ=None):
    if not location.config.is_file():
        raise ConfigError(f"{location.config}: config missing; stop the server and run "
                          "zluggish config migrate --dry-run, then config migrate --output PATH; "
                          "for a fresh installation copy examples/config.jsonc")
    return resolve_server(read_document(location.config, SERVER), location, environ)


def resolve_server(document, location, environ=None):
    settings = merge(defaults(SERVER), document)
    env = os.environ if environ is None else environ
    for name, (key, convert) in ENV.items():
        if name in env:
            try:
                assign(settings, key, convert(env[name]))
            except ValueError:
                raise ConfigError(f"{name}: invalid environment override") from None
    validate(settings, SERVER, location.config)
    for reference in (settings["ghosts"]["profile_file"], settings["bots"]["riders_file"],
                      settings["integrations"]["discord"]["credentials_file"]):
        path = asset_path(location, reference)
        if path is not None and not path.is_file():
            raise ConfigError(f"{path}: referenced file missing")
    if settings["integrations"]["discord"]["enabled"] and not settings["integrations"]["discord"]["credentials_file"]:
        raise ConfigError("integrations.discord.credentials_file is required when Discord is enabled")
    return settings


def load_user(location, server, user=None):
    document = read_document(user_path(location, user), USER, {}) if user is not None else {}
    return merge(merge(defaults(USER), server["user_defaults"]), document)


def asset_path(location, reference):
    if not reference:
        return None
    path = Path(reference).expanduser()
    return path if path.is_absolute() else location.config.parent / path


def network(settings, service):
    host = settings["network"][service]["host"]
    if host is None:
        host = settings["network"]["host"]
        if service == "api" and not host:
            host = "0.0.0.0"
    return host, settings["network"][service]["port"]


def leaves(doc, prefix=""):
    for key, value in doc.items():
        full = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            yield from leaves(value, full)
        else:
            yield full


def sources(effective, layers):
    result = {key: "default" for key in leaves(effective)}
    for label, document in layers:
        for key in leaves(document):
            result[key] = str(label)
    return result


def schema_key(schema, key):
    if any(part.startswith("$") or part.endswith("_version") for part in key.split(".")):
        raise ConfigError("Metadata cannot be edited as a setting")
    for part in key.split("."):
        try:
            schema = schema["properties"][part]
        except KeyError:
            raise ConfigError("Unknown setting key") from None
    return schema


def _model(value):
    return load_model(json.dumps(value, ensure_ascii=False, allow_nan=False), loader=ModelLoader()).value


def _edit_object(node, before, after):
    """Patch the library's round-trip model; never regenerate unrelated fields."""
    for key in dict.fromkeys([*before, *after]):
        if key in before and key in after and before[key] == after[key]:
            continue
        index = next((i for i, k in enumerate(node.keys) if k.characters == key), None)
        if key not in after:
            old_key, old_value = node.keys.pop(index), node.values.pop(index)
            comments = [v for v in old_key.wsc_before + old_key.wsc_after + old_value.wsc_before + old_value.wsc_after
                        if isinstance(v, Comment)]
            node.leading_wsc.extend(v for comment in comments for v in (comment, "\n"))
            if not node.keys and node.trailing_comma:
                node.leading_wsc.extend(node.trailing_comma.wsc_before + node.trailing_comma.wsc_after)
                node.trailing_comma = None
            continue
        if index is None:
            new_key = _model(key)
            new_value = _model(after[key])
            new_key.wsc_before = ["\n  "]
            new_value.wsc_before = [" "]
            node.keys.append(new_key)
            node.values.append(new_value)
            continue
        old = node.values[index]
        if isinstance(old, JSONObject) and isinstance(after[key], dict):
            _edit_object(old, before[key], after[key])
        elif isinstance(old, JSONArray) and isinstance(after[key], list):
            if len(before[key]) != len(after[key]):
                unused = list(zip(before[key], old.values))
                values = []
                for value in after[key]:
                    match = next((i for i, (previous, _) in enumerate(unused) if previous == value), None)
                    values.append(unused.pop(match)[1] if match is not None else _model(value))
                old.values = values
                if not values:
                    old.trailing_comma = None
                continue
            for i, value in enumerate(after[key]):
                if isinstance(old.values[i], JSONObject) and isinstance(value, dict):
                    _edit_object(old.values[i], before[key][i], value)
                elif before[key][i] != value:
                    replacement = _model(value)
                    replacement.wsc_before, replacement.wsc_after = old.values[i].wsc_before, old.values[i].wsc_after
                    old.values[i] = replacement
        else:
            replacement = _model(after[key])
            replacement.wsc_before, replacement.wsc_after = old.wsc_before, old.wsc_after
            node.values[index] = replacement


def render_edit(text, before, after):
    tree = load_model(text, loader=ModelLoader())
    if dump_model(tree, dumper=ModelDumper()) != text:
        raise ConfigError("Cannot safely preserve this document's formatting; edit it manually")
    _edit_object(tree.value, before, after)
    result = dump_model(tree, dumper=ModelDumper())
    if parse(result) != after:
        raise ConfigError("Cannot safely edit this document; edit it manually")
    return result


def atomic_write(path, text, expected=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists():
            os.chmod(temporary, path.stat().st_mode & 0o777)
        if expected != (path.read_bytes() if path.exists() else None):
            raise OSError(f"{path}: changed during edit; retry")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def edit_document(path, schema, change, initial=None, dry_run=False, check=None):
    """change mutates a fresh dict while holding the per-file lock."""
    path = Path(path)
    def perform():
        original = path.read_bytes() if path.exists() else None
        if original is None and initial is None:
            raise ConfigError(f"{path}: missing; migrate or copy the example first")
        try:
            text = original.decode("utf-8") if original is not None else None
        except UnicodeError:
            raise ConfigError(f"{path}: expected UTF-8 text") from None
        before = parse(text, path) if text is not None else deepcopy(initial)
        validate(before, schema, path)
        after = deepcopy(before)
        change(after)
        validate(after, schema, path)
        if check:
            check(after)
        if after != before:
            text = render_edit(text, before, after) if text is not None else json.dumps(after, indent=2) + "\n"
            if not dry_run:
                atomic_write(path, text, original)
        return after
    if dry_run:
        return perform()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with FileLock(str(path) + ".lock", timeout=5):
            return perform()
    except Timeout:
        raise OSError(f"{path}: busy; retry") from None


def edit_setting(path, schema, key, value=None, reset=False, **kwargs):
    schema_key(schema, key)
    def change(document):
        target = document
        parts = key.split(".")
        for part in parts[:-1]:
            if part not in target and reset:
                return
            target = target.setdefault(part, {})
        if reset:
            target.pop(parts[-1], None)
        else:
            target[parts[-1]] = value
    return edit_document(path, schema, change, **kwargs)


def save_user(location, key, value, user=None):
    # Server and CLI write the exact same documents and enforce the same rules.
    return edit_setting(user_path(location, user), USER, key, value,
                        initial={"$schema": "../user-settings.schema.json", "settings_version": 1})
