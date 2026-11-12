"""CLI for configuration inspection, editing, and offline migration."""
import argparse
from importlib.metadata import version, PackageNotFoundError
import json
import sqlite3
import sys


def json_value(value):
    try:
        result = json.loads(value, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
        json.dumps(result, allow_nan=False)
        return result
    except ValueError:
        raise argparse.ArgumentTypeError('VALUE must be JSON (quote strings, use true/false for booleans)') from None


def parser():
    root = argparse.ArgumentParser(prog="zluggish", description="Manage Zluggish configuration and rider settings. Does not start the server.")
    try:
        current = version("zluggish")
    except PackageNotFoundError:
        current = "0.1.0 (source)"
    root.add_argument("--version", action="version", version=f"%(prog)s {current}")
    root.add_argument("--storage-dir")
    root.add_argument("--config")
    groups = root.add_subparsers(dest="group")
    for group, actions in (("config", ("show", "get", "validate", "set", "reset", "migrate")),
                           ("settings", ("show", "set", "reset"))):
        commands = groups.add_parser(group).add_subparsers(dest="action", required=True)
        for action in actions:
            command = commands.add_parser(action)
            if action in ("get", "set", "reset"):
                command.add_argument("key")
            if action == "set":
                command.add_argument("value", type=json_value)
            if action in ("set", "reset"):
                command.add_argument("--dry-run", action="store_true")
            if action == "show":
                command.add_argument("--sources", action="store_true")
                command.add_argument("--format", choices=["json"], default="json")
            if action == "migrate":
                target = command.add_mutually_exclusive_group(required=True)
                target.add_argument("--dry-run", action="store_true")
                target.add_argument("--output")
            if group == "settings":
                scope = command.add_mutually_exclusive_group(required=True)
                scope.add_argument("--user")
                scope.add_argument("--anonymous", action="store_true")
                scope.add_argument("--peloton", action="store_true")
                scope.add_argument("--solo-blob", action="store_true")
    return root


def main(argv=None):
    root = parser()
    args = root.parse_args(argv)
    if args.group is None:
        root.print_help()
        return 0
    from zluggish_config.store import ConfigError, paths
    try:
        from . import config, settings
        location = paths(args.storage_dir, args.config)
        (config if args.group == "config" else settings).run(args, location)
        return 0
    except ConfigError as exc:
        print(f"zluggish: {exc}", file=sys.stderr)
        return 2
    except (OSError, sqlite3.Error) as exc:
        print(f"zluggish: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
