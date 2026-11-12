"""Server configuration commands."""
import json
import os
import sys
from zluggish_config.schema import SERVER, USER, PELOTON, SOLO_BLOB, defaults
from zluggish_config.store import (load_server, read_document, edit_setting, merge, resolve_server,
                                   sources, ENV, get, database_users, load_user)


def inspect(location):
    effective = load_server(location)
    raw = read_document(location.config, SERVER)
    provenance = sources(effective, [(location.config, raw)])
    for name, (key, _) in ENV.items():
        if name in os.environ:
            provenance[key] = name
    return effective, provenance


def validate_all(location):
    settings = load_server(location)
    for player in database_users(location.storage):
        load_user(location, settings, player)
    load_user(location, settings)
    # Also validate files for missing/deleted riders rather than ignoring mistakes.
    for path in location.storage.glob("*/settings.jsonc"):
        read_document(path, USER)
    for filename, schema in (("peloton.jsonc", PELOTON), ("solo_blob.jsonc", SOLO_BLOB)):
        read_document(location.storage / filename, schema, {})
    return settings


def run(args, location):
    if args.action == "migrate":
        from .migrate import migrate
        print("Stop the server and back up storage before applying migration.", file=sys.stderr)
        report = migrate(location, args.output, args.dry_run)
        print(json.dumps({"dry_run": args.dry_run, **report}, indent=2))
        if not args.dry_run:
            print("Migration complete. Set ZLUGGISH_CONFIG to the output path if external, then restart the server.", file=sys.stderr)
        return
    if args.action == "validate":
        validate_all(location)
        print("Configuration is valid.")
        return
    if args.action in ("set", "reset"):
        # Validate defaults as well as explicitly stored fields.
        def check(candidate):
            resolve_server(candidate, location)
        result = edit_setting(location.config, SERVER, args.key, args.value if args.action == "set" else None,
                     reset=args.action == "reset", dry_run=args.dry_run, check=check)
        print("Validated dry run; no changes written." if args.dry_run else "Configuration saved; restart the server to apply.")
        print(json.dumps({"key": args.key, "configured": get(merge(defaults(SERVER), result), args.key)}, indent=2))
        for name, (key, _) in ENV.items():
            if name in os.environ and (key == args.key or key.startswith(args.key + ".")):
                print(f"Warning: {name} overrides this configured value.", file=sys.stderr)
        return
    effective, provenance = inspect(location)
    if args.action == "get":
        print(json.dumps(get(effective, args.key), indent=2))
    else:
        print(json.dumps({"settings": effective, "sources": provenance} if args.sources else effective, indent=2))
