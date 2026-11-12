"""Explicit offline entry point for existing server-model migrations.

Load the server's model definitions using the CLI's storage lock. Its migration
branch never starts listeners or ride/background threads. Ordinary startup only
accepts the current schema or initializes a fresh empty installation.
"""
import importlib.util
from pathlib import Path
import sys

from zluggish_config.store import ConfigError


def migrate_accounts(location, lock, server_dir=None):
    root = Path(server_dir).expanduser().resolve() if server_dir else Path(__file__).resolve().parents[1]
    source = root / 'zwift_offline.py'
    if not source.is_file():
        raise ConfigError('Run accounts migrate in the server Python environment, or provide --server-dir /path/to/zluggish')
    original_path = sys.path[:]
    module = None
    try:
        sys.path[:0] = [str(root), str(root / 'protobuf')]
        spec = importlib.util.spec_from_file_location('_zluggish_account_migration', source)
        module = importlib.util.module_from_spec(spec)
        module._MIGRATE_ACCOUNTS = True
        module._CONFIG_PATHS = location
        module._SERVER_LOCK = lock
        module._LOGS_DIR = str(location.storage / 'logs')
        spec.loader.exec_module(module)
    except SystemExit as exc:
        raise ConfigError('Account migration stopped (exit %s); resolve the reported error before starting the server' % exc.code) from None
    finally:
        if module is not None:
            if hasattr(module, 'db'):
                with module.app.app_context():
                    module.db.session.remove()
                    module.db.engine.dispose()
            if hasattr(module, 'logHandler'):
                module.logger.removeHandler(module.logHandler)
                module.logHandler.close()
        sys.path[:] = original_path
