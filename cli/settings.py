"""Scoped rider and bot settings commands."""
import json
from zluggish_config.schema import USER, PELOTON, SOLO_BLOB, defaults
from zluggish_config.store import (load_server, user_path, read_document, edit_setting, merge, sources, get)


def run(args, location):
    server = load_server(location)
    if args.peloton or args.solo_blob:
        schema = PELOTON if args.peloton else SOLO_BLOB
        path = location.storage / ("peloton.jsonc" if args.peloton else "solo_blob.jsonc")
        base = defaults(schema)
        initial = {"pelotons": []} if args.peloton else {}
    else:
        schema = USER
        path = user_path(location, args.user)
        base = merge(defaults(USER), server["user_defaults"])
        initial = {"$schema": "../user-settings.schema.json", "settings_version": 1}
    if args.action == "show":
        raw = read_document(path, schema, {})
        effective = merge(base, raw)
        layers = [("server.user_defaults", server["user_defaults"])] if schema is USER else []
        provenance = sources(effective, [*layers, (path, raw)])
        print(json.dumps({"settings": effective, "sources": provenance} if args.sources else effective, indent=2))
    else:
        result = edit_setting(path, schema, args.key, args.value if args.action == "set" else None,
                     reset=args.action == "reset", initial=initial, dry_run=args.dry_run)
        print("Validated dry run; no changes written." if args.dry_run else "Settings saved; applied at the next settings action or bot reload.")
        print(json.dumps({"key": args.key, "effective": get(merge(base, result), args.key)}, indent=2))
