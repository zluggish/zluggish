"""The only reader of obsolete configuration. Run offline; originals are untouched."""
from configparser import ConfigParser, Error as IniError
from contextlib import nullcontext, closing
import json
import os
from pathlib import Path
import sqlite3

from filelock import FileLock, Timeout
from zluggish_config.schema import SERVER, USER, PELOTON, SOLO_BLOB, generated, defaults
from zluggish_config.store import ConfigError, atomic_write, parse, validate, read_document


def candidates(location, output):
    storage = location.storage
    server = defaults(SERVER)
    server["$schema"] = "./config.schema.json"
    def exists(name):
        return (storage / name).is_file()
    def text(name):
        return (storage / name).read_text(encoding="utf-8").rstrip("\r\n")
    for filename, section, key in (
        ("multiplayer.txt", "server", "multiplayer"), ("family_mode.txt", "server", "family_mode"),
        ("auto_launch.txt", "launcher", "auto_launch"), ("fake-dns.txt", "dns", "enabled"),
        ("all_time_leaderboards.txt", "leaderboards", "all_time"),
        ("unlock_entitlements.txt", "equipment", "unlock_entitlements"),
        ("unlock_all_equipment.txt", "equipment", "unlock_all"),
    ):
        server[section][key] = exists(filename)
    if exists("server-ip.txt"):
        server["server"]["advertised_ip"] = text("server-ip.txt")
    if exists("garmin_domain.txt"):
        server["integrations"]["garmin"]["domain"] = text("garmin_domain.txt").split("\n")[0]
    server["proxy"]["mode"] = "enabled" if exists("cdn-proxy.txt") else "disabled" if exists("disable_proxy.txt") else "auto"
    if exists("enable_bots.txt"):
        server["bots"]["enabled"] = True
        try:
            server["bots"]["multiplier"] = min(int(text("enable_bots.txt").splitlines()[0]), 100)
        except (ValueError, IndexError):
            server["bots"]["multiplier"] = 1
    # Relative references remain valid even when config output is external.
    def reference(name):
        try:
            return os.path.relpath(storage / name, output.parent)
        except ValueError:  # Separate Windows drives cannot form a relative path.
            return str(storage / name)
    if exists("ghost_profile.txt"):
        server["ghosts"]["profile_file"] = reference("ghost_profile.txt")
    if exists("bot.txt"):
        server["bots"]["riders_file"] = reference("bot.txt")
    if exists("gmail_credentials.txt"):
        server["mail"]["credentials_file"] = reference("gmail_credentials.txt")
    if exists("discord.cfg"):
        cfg = ConfigParser(interpolation=None)
        cfg.read(storage / "discord.cfg", encoding="utf-8")
        discord = server["integrations"]["discord"]
        discord.update(enabled=True, credentials_file=reference("discord.cfg"))
        discord.update(channel=cfg.getint("discord", "channel"),
                       welcome_message=cfg.get("discord", "welcome_message", fallback=""),
                       help_message=cfg.get("discord", "help_message", fallback=""),
                       announce_players=cfg.getboolean("discord", "announce_players", fallback=False))
    validate(server, SERVER, output)
    result = {}
    db = storage / "zwift-offline.db"
    users = {}
    if db.exists():
        with closing(sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)) as connection:
            table = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user'").fetchone()
            if table:
                columns = {row[1] for row in connection.execute('PRAGMA table_info("user")')}
                select = 'SELECT player_id, enable_ghosts FROM "user"' if 'enable_ghosts' in columns else 'SELECT player_id, 1 FROM "user"'
                users = {int(row[0]): bool(row[1]) for row in connection.execute(select)}
    if any(player < 1 for player in users):
        raise ConfigError("Legacy database contains unsupported player IDs")
    def preferences(player, ghosts):
        directory = storage / str(player)
        method = directory / 'strava_upload_method.txt'
        folder = directory / 'trainingpeaks_bridge_folder.txt'
        return {
            "$schema": "../user-settings.schema.json", "settings_version": 1,
            "ghosts": {"enabled": ghosts},
            "uploads": {"zwift": {"enabled": (directory / "zwift_upload.txt").is_file()},
                        "strava": {"method": method.read_text(encoding="utf-8").split('\n')[0].rstrip('\r') if method.exists() else 'paid'}},
            "devices": {"zwift_click": {"enabled": (directory / 'zwift_click.txt').is_file()}},
            "workouts": {"trainingpeaks": {"bridge_folder": folder.read_text(encoding="utf-8").strip() if folder.exists() else ''}},
        }
    for player, ghosts in users.items():
        result[storage / str(player) / "settings.jsonc"] = (USER, preferences(player, ghosts))
    # Match the old single-player launcher's first profile choice exactly.
    anonymous_player = next((int(name) for name in os.listdir(storage)
                             if name.isdigit() and (storage / name / 'profile.bin').is_file()), 1) if storage.exists() else 1
    result[storage / "anonymous" / "settings.jsonc"] = (USER, preferences(anonymous_player, exists("enable_ghosts.txt")))
    for old, new, schema in (("peloton.txt", "peloton.jsonc", PELOTON), ("solo_blob.txt", "solo_blob.jsonc", SOLO_BLOB)):
        if exists(old):
            # These legacy files were JSON. The strict JSON decoder rejects unsupported syntax.
            try:
                value = json.loads((storage / old).read_text(encoding="utf-8"))
            except ValueError:
                raise ConfigError(f"{storage / old}: invalid legacy JSON") from None
            validate(value, schema, storage / old)
            result[storage / new] = (schema, value)
    for path, (schema, value) in result.items():
        validate(value, schema, path)
    # Schema artifacts are also checked for conflicts before any output is written.
    for name, schema in generated().items():
        result[storage / name] = (None, schema)
    result[output.parent / "config.schema.json"] = (None, generated()["config.schema.json"])
    if output in result or output.suffix != ".jsonc":
        raise ConfigError("Choose a .jsonc server output distinct from rider/bot/schema files")
    result[output] = (SERVER, server)  # Publish the activation file last.
    return result


def migrate(location, output=None, dry_run=False):
    output = Path(output).expanduser().resolve() if output else location.config
    if output.exists():
        raise ConfigError(f"{output}: destination exists; migration never overwrites server configuration")
    # Holding the same lifetime lock as the server detects a running new server.
    # Old releases do not hold it: stopping them remains an explicit prerequisite.
    lock = FileLock(str(location.storage / ".server.lock"), timeout=0)
    if not dry_run:
        location.storage.mkdir(parents=True, exist_ok=True)
    try:
        with nullcontext() if dry_run else lock:
            try:
                documents = candidates(location, output)
            except (IniError, ValueError) as exc:
                if isinstance(exc, ConfigError):
                    raise
                raise ConfigError("Invalid legacy configuration; check INI field types and JSON values") from None
            for path, (schema, value) in documents.items():
                if path == output:
                    continue
                if path.exists():
                    existing = parse(path.read_text(encoding="utf-8"), path)
                    if existing != value:
                        raise ConfigError(f"{path}: conflicting output; resolve manually before retrying")
            # Stage all serialized candidates before publishing anything.
            try:
                rendered = {path: json.dumps(value, indent=2, ensure_ascii=False, allow_nan=False) + "\n"
                            for path, (_, value) in documents.items()}
            except ValueError:
                raise ConfigError("Legacy configuration contains non-finite numbers") from None
            written = []
            if not dry_run:
                try:
                    for path, text in rendered.items():
                        if path == output or not path.exists():
                            atomic_write(path, text)
                            written.append(str(path))
                        elif parse(path.read_text(encoding="utf-8"), path) != documents[path][1]:
                            raise OSError(f"{path}: changed during migration; recover before restarting")
                except OSError as exc:
                    raise OSError(f"Migration interrupted; server must stay stopped. Written paths: {written}. {exc}") from None
            return {"outputs": list(map(str, documents)),
                    "settings": {str(path): value for path, (schema, value) in documents.items() if schema is not None}}
    except Timeout:
        raise OSError("Server is running; stop it before migration") from None
