"""Offline account conversion and password/owner recovery."""
import getpass
import json
from filelock import FileLock, Timeout
from zluggish_config.accounts import convert_config, recover
from zluggish_config.store import ConfigError, atomic_write, parse


def run(args, location):
    location.storage.mkdir(parents=True, exist_ok=True)
    try:
        with FileLock(str(location.storage / '.server.lock'), timeout=0) as lock:
            if args.action == 'migrate':
                if args.solo_player is not None and args.solo_player < 1:
                    raise ConfigError('--solo-player must be a positive numeric folder ID')
                if args.solo_player is not None and not (location.storage / str(args.solo_player) / 'profile.bin').is_file():
                    raise ConfigError('--solo-player must identify an existing profile.bin')
                raw = parse(location.config.read_text(), location.config)
                options_path = location.storage / 'account-migration.json'
                options = json.loads(options_path.read_text()) if options_path.exists() else {}
                if args.solo_player is not None:
                    options['solo_player'] = args.solo_player
                if args.settings_source:
                    options['settings_source'] = args.settings_source
                elif raw.get('server', {}).get('multiplayer'):
                    options.setdefault('settings_source', 'rider')
                atomic_write(options_path, json.dumps(options), options_path.read_bytes() if options_path.exists() else None)
                convert_config(location)
                from .account_migration import migrate_accounts
                migrate_accounts(location, lock, args.server_dir)
                print('Account/database migration complete. Numeric folders stay in place; restart the server.')
            else:
                password = '' if args.remove_password else getpass.getpass('New local password: ')
                if not args.remove_password and (not password or password != getpass.getpass('Confirm password: ')):
                    raise ConfigError('Enter matching nonempty passwords')
                recover(location.storage, args.user, password, args.admin)
                print('Rider updated; previous sessions revoked.')
    except Timeout:
        raise ConfigError('Stop the server before account migration or recovery') from None
