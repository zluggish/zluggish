"""Offline account schema, legacy configuration conversion and owner recovery.

This module deliberately does not import the server or start listeners.
"""
from contextlib import closing
from copy import deepcopy
import json
from pathlib import Path
import re
import secrets
import sqlite3
import time

from .store import ConfigError, atomic_write, parse, validate, render_edit
from .schema import SERVER, generated


def backup(path):
    path = Path(path)
    if path.exists():
        target = path.with_name(path.name + '.accounts-%s.bak' % time.time_ns())
        if path.suffix == '.db':
            with closing(sqlite3.connect(path)) as source, closing(sqlite3.connect(target)) as dest:
                source.backup(dest)
        else:
            target.write_bytes(path.read_bytes())
        return target


def migrate_schema(storage):
    """Run under the storage lifetime lock, before ORM queries against User."""
    path = Path(storage) / 'zwift-offline.db'
    if not path.exists():
        return
    with closing(sqlite3.connect(path)) as connection:
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='version'").fetchone():
            version = connection.execute('SELECT version FROM version LIMIT 1').fetchone()
            if version and version[0] > 4:
                raise ConfigError('Database is from a newer server; upgrade Zluggish before migrating it.')
        row = connection.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='user'").fetchone()
        if not row:
            return
        columns = {r[1]: r for r in connection.execute('PRAGMA table_info(user)')}
        if 'auth_version' in columns and not columns['pass_hash'][3]:
            return
        backup(path)
        with connection:
            connection.execute('BEGIN IMMEDIATE')
            indexes = list(connection.execute("SELECT sql FROM sqlite_master WHERE tbl_name='user' AND type IN ('index', 'trigger') AND sql IS NOT NULL"))
            # Rebuild only when necessary, retaining all old columns and constraints.
            sql = re.sub(r'(pass_hash\s+\w+)\s+NOT NULL', r'\1', row[0], flags=re.I)
            sql = re.sub(r'CREATE TABLE\s+(?:"user"|user)', 'CREATE TABLE user_accounts_new', sql, count=1, flags=re.I)
            connection.execute(sql)
            names = ','.join('"%s"' % name for name in columns)
            connection.execute('INSERT INTO user_accounts_new (%s) SELECT %s FROM user' % (names, names))
            connection.execute('DROP TABLE user')
            connection.execute('ALTER TABLE user_accounts_new RENAME TO user')
            for (statement,) in indexes:
                connection.execute(statement)
            for name, kind in [('auth_version', 'INTEGER NOT NULL DEFAULT 1'), ('official_player_id', 'INTEGER'),
                               ('is_admin', 'INTEGER NOT NULL DEFAULT 0')]:
                if name not in columns:
                    connection.execute('ALTER TABLE user ADD COLUMN %s %s' % (name, kind))
            connection.execute('UPDATE user SET is_admin=1 WHERE player_id=1')


def convert_config(location):
    original = location.config.read_bytes()
    before = parse(original.decode(), location.config)
    raw = deepcopy(before)
    server = raw.get('server', {})
    for key in ('multiplayer', 'family_mode'):
        server.pop(key, None)
    raw.pop('mail', None)
    raw.pop('launcher', None)  # Automatic rider selection is retired.
    validate(raw, SERVER, location.config)
    backup(location.config)
    atomic_write(location.config, render_edit(original.decode(), before, raw), original)
    schema_path = location.config.parent / 'config.schema.json'
    if schema_path.exists():
        backup(schema_path)
        atomic_write(schema_path, json.dumps(generated()['config.schema.json'], indent=2) + '\n', schema_path.read_bytes())


def recover(storage, player_id, password, admin=False):
    from werkzeug.security import generate_password_hash
    require_current_schema(storage)
    path = Path(storage) / 'zwift-offline.db'
    backup(path)
    with closing(sqlite3.connect(path)) as connection, connection:
        if not connection.execute('SELECT 1 FROM user WHERE player_id=?', (player_id,)).fetchone():
            raise ConfigError('Unknown rider ID')
        connection.execute('UPDATE user SET pass_hash=?, auth_version=auth_version+1 WHERE player_id=?',
                           (generate_password_hash(password, 'scrypt') if password else None, player_id))
        if admin:
            connection.execute('UPDATE user SET is_admin=1 WHERE player_id=?', (player_id,))


def setup_secret(storage):
    path = Path(storage) / 'setup-token.txt'
    if not path.exists():
        atomic_write(path, secrets.token_urlsafe(32))
    return path.read_text().strip()


def require_current_schema(storage):
    """Read-only startup gate. Fresh empty installations may create current tables."""
    storage = Path(storage)
    path = storage / 'zwift-offline.db'
    command = 'zluggish --storage-dir "%s" accounts migrate' % storage
    if not path.exists():
        legacy = storage.exists() and (any(p.is_dir() and p.name.isdecimal() for p in storage.iterdir())
                                       or (storage / 'anonymous/settings.jsonc').exists())
        if not legacy:
            return
        raise ConfigError('Legacy rider data needs migration. Stop the server and run: ' + command)
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as connection:
        tables = {r[0] for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if {'user', 'version', 'account_state'} <= tables:
            columns = {r[1]: r for r in connection.execute('PRAGMA table_info(user)')}
            version = connection.execute('SELECT version FROM version LIMIT 1').fetchone()
            if version and version[0] > 4:
                raise ConfigError('Database is from a newer server; upgrade Zluggish before opening it.')
            if (version == (4,) and {'pass_hash', 'auth_version', 'official_player_id'} <= columns.keys()
                    and not columns['pass_hash'][3]
                    and connection.execute('SELECT 1 FROM account_state WHERE id=1').fetchone()):
                return
    raise ConfigError('Account/database upgrade required. Stop the server and run: ' + command)
