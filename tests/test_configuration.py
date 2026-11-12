"""Configuration behavior, CLI boundaries, and lossless offline migration."""
from contextlib import redirect_stdout, redirect_stderr
import io
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from filelock import FileLock
from cli.__main__ import main
from cli.migrate import migrate
from zluggish_config.schema import SERVER, USER, SOLO_BLOB, generated
from zluggish_config.store import (ConfigError, paths, parse, read_document, load_server, load_user,
                                    save_user, edit_setting, atomic_write, network, render_edit)

ROOT = Path(__file__).resolve().parents[1]


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.storage = Path(self.temp.name)
        self.location = paths(self.storage)
        self.config = self.storage / 'config.jsonc'
        self.config.write_text('{"config_version": 1, "proxy": {"mode": "disabled"}}\n')
        with sqlite3.connect(self.storage / 'zwift-offline.db') as db:
            db.execute('CREATE TABLE user(player_id INTEGER PRIMARY KEY, enable_ghosts INTEGER)')
            db.executemany('INSERT INTO user VALUES (?, ?)', [(1, 1), (2, 0)])
        db.close()

    def invoke(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = main(['--storage-dir', str(self.storage), *args])
        return code, out.getvalue(), err.getvalue()

    def test_jsonc_comments_trailing_commas_and_strings(self):
        self.assertEqual(parse('{/* block */"url":"https://example.com/*text*/",// line\n"list":[1,2,],}'),
                         {'url': 'https://example.com/*text*/', 'list': [1, 2]})
        for source in ('{,}', '[,]', '{"x":1,,}', '{x:1}', "{'x':1}", '{"x":NaN}',
                       '{"x":Infinity}', '{"x":1e9999}', '{"x":0,"x":1}', '{"x":0x1}', '{"x":+1}', '{"x":.1}'):
            with self.subTest(source=source), self.assertRaises(ConfigError):
                parse(source)

    def test_legacy_markers_have_no_effect_and_missing_config_fails(self):
        for name in ('multiplayer.txt', 'family_mode.txt', 'enable_ghosts.txt', 'disable_proxy.txt'):
            (self.storage / name).touch()
        settings = load_server(self.location, {})
        self.assertFalse(settings['server']['multiplayer'])
        self.assertFalse(load_user(self.location, settings, 1)['ghosts']['enabled'])
        self.config.unlink()
        before = set(self.storage.rglob('*'))
        with self.assertRaisesRegex(ConfigError, 'migrate'):
            load_server(self.location, {})
        self.assertEqual(before, set(self.storage.rglob('*')))

    def test_missing_configuration_stops_server_before_state_creation(self):
        self.config.unlink()
        before = {p: p.read_bytes() for p in self.storage.rglob('*') if p.is_file()}
        result = subprocess.run([sys.executable, str(ROOT / 'zwift_offline.py')],
                                env={**os.environ, 'ZLUGGISH_STORAGE_DIR': str(self.storage),
                                     'ZLUGGISH_CONFIG': str(self.config)}, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIn('migrate', result.stderr)
        self.assertEqual(before, {p: p.read_bytes() for p in self.storage.rglob('*') if p.is_file()})

    def test_environment_and_host_inheritance(self):
        settings = load_server(self.location, {'ZOFFLINE_SERVER_HOST': '::', 'ZOFFLINE_API_PORT': '8443',
                                                'ZOFFLINE_API_USE_CERT': 'false'})
        self.assertEqual(network(settings, 'tcp'), ('::', 3025))
        self.assertEqual(network(settings, 'api'), ('::', 8443))
        self.assertFalse(settings['network']['api']['use_cert'])
        self.assertEqual(network(load_server(self.location, {}), 'api'), ('0.0.0.0', 443))
        for env in ({'ZOFFLINE_API_USE_CERT': 'yes'}, {'ZOFFLINE_TCP_PORT': 'banana'}, {'ZOFFLINE_API_PORT': '0'}):
            with self.subTest(env=env), self.assertRaises(ConfigError):
                load_server(self.location, env)

    def test_user_inheritance_reset_isolation_and_no_database_fallback(self):
        self.config.write_text('{"config_version":1,"user_defaults":{"ghosts":{"enabled":true}}}')
        settings = load_server(self.location, {})
        save_user(self.location, 'ghosts.enabled', False, 1)
        self.assertFalse(load_user(self.location, settings, 1)['ghosts']['enabled'])
        self.assertTrue(load_user(self.location, settings, 2)['ghosts']['enabled'])
        self.assertTrue(load_user(self.location, settings)['ghosts']['enabled'])
        code, _, _ = self.invoke('settings', 'reset', '--user', '1', 'ghosts.enabled')
        self.assertEqual(code, 0)
        self.assertTrue(load_user(self.location, settings, 1)['ghosts']['enabled'])
        self.assertTrue((self.storage / '1/settings.jsonc').exists())
        with self.assertRaises(ConfigError):
            save_user(self.location, 'server.family_mode', True, 1)
        for player in ('../1', '999', '-1', '0'):
            with self.subTest(player=player), self.assertRaises(ConfigError):
                load_user(self.location, settings, player)

    def test_targeted_edit_preserves_comments_format_and_permissions(self):
        source = '{\n  // my switch\n  "config_version": 1,\n  "server": { "multiplayer": false, /* keep */ },\n  "logging": {"level": "INFO"}, // unchanged\n}\n'
        self.config.write_text(source)
        self.config.chmod(0o640)
        edit_setting(self.config, SERVER, 'server.multiplayer', True)
        self.assertEqual(self.config.read_text(), source.replace('"multiplayer": false', '"multiplayer": true'))
        if os.name != 'nt':
            self.assertEqual(self.config.stat().st_mode & 0o777, 0o640)
        edit_setting(self.config, SERVER, 'server.family_mode', True)
        self.assertIn('/* keep */', self.config.read_text())
        edit_setting(self.config, SERVER, 'server.family_mode', reset=True)
        self.assertIn('// unchanged', self.config.read_text())
        self.assertNotIn('family_mode', read_document(self.config, SERVER)['server'])

    def test_array_edit_retains_unrelated_entries_and_comments(self):
        text = '{"pelotons": [\n /* a */ {"pacer": "a", "bots": 1},\n /* b */ {"pacer": "b", "bots": 2},\n]}'
        before = parse(text)
        after = {'pelotons': [before['pelotons'][1]]}
        result = render_edit(text, before, after)
        self.assertIn('/* b */ {"pacer": "b", "bots": 2}', result)
        self.assertEqual(parse(result), after)

    def test_invalid_edits_and_dry_runs_leave_file_unchanged(self):
        original = self.config.read_bytes()
        for key, value in (('server.multiplayer', 'true'), ('unknown', True), ('config_version', 2),
                           ('server.family_mode', True)):
            with self.subTest(key=key), self.assertRaises(ConfigError):
                edit_setting(self.config, SERVER, key, value)
            self.assertEqual(self.config.read_bytes(), original)
        before = set(self.storage.rglob('*'))
        code, _, _ = self.invoke('settings', 'set', '--user', '1', 'ghosts.enabled', 'true', '--dry-run')
        self.assertEqual(code, 0)
        self.assertEqual(before, set(self.storage.rglob('*')))
        self.assertEqual(self.config.read_bytes(), original)

    def test_atomic_writer_detects_external_change(self):
        original = self.config.read_bytes()
        self.config.write_text('{"config_version": 1, "logging":{"level":"DEBUG"}}')
        with self.assertRaisesRegex(OSError, 'changed'):
            atomic_write(self.config, '{}', original)
        self.assertIn('DEBUG', self.config.read_text())
        self.assertFalse(list(self.storage.glob('.config.jsonc.*')))

    def test_cli_inspection_and_validation_do_not_write(self):
        before = {p: p.read_bytes() for p in self.storage.rglob('*') if p.is_file()}
        for args in (('config', 'show', '--sources'), ('config', 'validate'),
                     ('settings', 'show', '--anonymous'), ('settings', 'show', '--peloton')):
            with self.subTest(args=args):
                code, output, _ = self.invoke(*args)
                self.assertEqual(code, 0, output)
        self.assertEqual(before, {p: p.read_bytes() for p in self.storage.rglob('*') if p.is_file()})
        code, output, _ = self.invoke('config', 'show', '--format', 'json')
        self.assertEqual(code, 0)
        self.assertIn('server', json.loads(output))

    def test_config_edit_reports_masking_override(self):
        with patch.dict(os.environ, {'ZOFFLINE_API_PORT': '8443'}):
            code, output, error = self.invoke('config', 'set', 'network.api.port', '9443')
        self.assertEqual(code, 0)
        self.assertIn('ZOFFLINE_API_PORT', error)
        self.assertIn('restart', output)
        self.assertEqual(load_server(self.location, {})['network']['api']['port'], 9443)

    def test_invalid_values_are_not_exposed(self):
        self.config.write_text('{"config_version": 1, "secret":"do-not-display"}')
        code, out, err = self.invoke('config', 'show')
        self.assertEqual(code, 2)
        self.assertNotIn('do-not-display', out + err)
        self.config.write_text('{"config_version": "do-not-display"}')
        self.assertEqual(self.invoke('config', 'validate')[0], 2)

    def test_schema_artifacts_are_current(self):
        for name, schema in generated().items():
            self.assertEqual(json.loads((ROOT / 'zluggish_config/schemas' / name).read_text()), schema)

    def test_installed_cli_from_another_directory(self):
        executable = Path(sys.executable).with_name('zluggish.exe' if os.name == 'nt' else 'zluggish')
        if os.name == 'nt' and not executable.exists():
            executable = Path(sys.executable).parent / 'Scripts' / 'zluggish.exe'
        result = subprocess.run([str(executable), '--storage-dir', str(self.storage),
                                 'config', 'show', '--format', 'json'], cwd=self.temp.name, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('server', json.loads(result.stdout))
        for command in ([sys.executable, '-m', 'cli', '--help'], [sys.executable, '-m', 'cli', '--version']):
            result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('zwift_offline', sys.modules)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.storage = Path(self.temp.name)
        self.location = paths(self.storage)
        with sqlite3.connect(self.storage / 'zwift-offline.db') as db:
            db.execute('CREATE TABLE user(player_id INTEGER, enable_ghosts INTEGER)')
            db.executemany('INSERT INTO user VALUES (?, ?)', [(1, 1), (2, 0)])
        db.close()
        for filename in ('multiplayer.txt', 'family_mode.txt', 'enable_bots.txt', 'cdn-proxy.txt', 'disable_proxy.txt'):
            (self.storage / filename).touch()
        (self.storage / '1').mkdir()
        (self.storage / '1/zwift_upload.txt').touch()
        (self.storage / '1/zwift_click.txt').touch()
        (self.storage / '1/strava_upload_method.txt').write_text('free')
        (self.storage / '1/trainingpeaks_bridge_folder.txt').write_text('/workouts/export')
        (self.storage / 'peloton.txt').write_text('{"pelotons":[{"pacer":"A", "bots":12}]}')
        (self.storage / 'solo_blob.txt').write_text('{"enabled":false,"riders":8,"scatter":true}')

    def test_migration_preserves_effective_values_and_originals(self):
        original = {p: p.read_bytes() for p in self.storage.rglob('*') if p.is_file()}
        with patch.dict(os.environ, {'ZOFFLINE_API_PORT': '9999'}):
            outputs = migrate(self.location, dry_run=True)
            self.assertEqual(original, {p: p.read_bytes() for p in self.storage.rglob('*') if p.is_file()})
            migrate(self.location, output=self.location.config)
        server = load_server(self.location, {})
        self.assertTrue(server['server']['family_mode'])
        self.assertEqual(server['bots'], {'enabled': True, 'multiplier': 1, 'riders_file': ''})
        self.assertEqual(server['proxy']['mode'], 'enabled')
        self.assertEqual(server['network']['api']['port'], 443)
        self.assertTrue(load_user(self.location, server, 1)['ghosts']['enabled'])
        self.assertFalse(load_user(self.location, server, 2)['ghosts']['enabled'])
        rider = load_user(self.location, server, 1)
        self.assertTrue(rider['uploads']['zwift']['enabled'])
        self.assertTrue(rider['devices']['zwift_click']['enabled'])
        self.assertEqual(rider['uploads']['strava']['method'], 'free')
        self.assertEqual(rider['workouts']['trainingpeaks']['bridge_folder'], '/workouts/export')
        for path, content in original.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(parse((self.storage / 'peloton.jsonc').read_text()), parse((self.storage / 'peloton.txt').read_text()))
        self.assertIn(str(self.location.config), outputs['outputs'])
        self.assertEqual(outputs['settings'][str(self.location.config)]['bots']['multiplier'], 1)
        with self.assertRaisesRegex(ConfigError, 'exists'):
            migrate(self.location, output=self.location.config)

    def test_conflicting_rider_output_fails_before_publication(self):
        target = self.storage / '1/settings.jsonc'
        target.write_text('{"settings_version":1,"ghosts":{"enabled":false}}')
        with self.assertRaisesRegex(ConfigError, 'conflicting'):
            migrate(self.location, output=self.location.config)
        self.assertFalse(self.location.config.exists())
        self.assertFalse((self.storage / 'peloton.jsonc').exists())

    def test_interrupted_migration_can_reuse_equivalent_outputs(self):
        from cli import migrate as module
        write = module.atomic_write
        def fail_activation(path, text, *args):
            if path == self.location.config:
                raise OSError('simulated failure')
            return write(path, text, *args)
        with patch.object(module, 'atomic_write', side_effect=fail_activation), self.assertRaises(OSError):
            migrate(self.location, output=self.location.config)
        self.assertFalse(self.location.config.exists())
        migrate(self.location, output=self.location.config)
        self.assertTrue(self.location.config.exists())

    def test_migration_refuses_a_running_server(self):
        with FileLock(str(self.storage / '.server.lock')):
            with self.assertRaisesRegex(OSError, 'running'):
                migrate(self.location, output=self.location.config)
        self.assertFalse(self.location.config.exists())

    def test_external_output_keeps_secret_references_without_copying_values(self):
        (self.storage / 'gmail_credentials.txt').write_text('email\nvery-secret\nexample.test\n')
        (self.storage / 'discord.cfg').write_text('[discord]\ntoken=very-secret\nwebhook=also-secret\nchannel=12\nannounce_players=yes\n')
        output = self.storage / 'external/config.jsonc'
        migrate(self.location, output=output)
        content = output.read_text()
        self.assertNotIn('very-secret', content)
        self.assertNotIn('also-secret', content)
        settings = load_server(paths(self.storage, output), {})
        self.assertEqual(Path(settings['mail']['credentials_file']).as_posix(), '../gmail_credentials.txt')
        self.assertEqual(settings['integrations']['discord']['channel'], 12)
        self.assertTrue((output.parent / 'config.schema.json').exists())

    def test_unsupported_multiplier_and_invalid_bot_config_do_not_publish(self):
        (self.storage / 'enable_bots.txt').write_text('-1')
        with self.assertRaises(ConfigError):
            migrate(self.location, output=self.location.config)
        self.assertFalse(self.location.config.exists())
        (self.storage / 'enable_bots.txt').write_text('not-a-number')
        (self.storage / 'solo_blob.txt').write_text('{"not_a_setting": 1}')
        with self.assertRaises(ConfigError):
            migrate(self.location, output=self.location.config)
        self.assertFalse(self.location.config.exists())


class BotConfigurationTests(unittest.TestCase):
    def setUp(self):
        sys.path.insert(0, str(ROOT / 'protobuf'))
        self.addCleanup(sys.path.remove, str(ROOT / 'protobuf'))
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.storage = Path(self.temp.name)

    def test_solo_blob_chat_preserves_config_and_invalid_reload_keeps_last_simulation(self):
        from solo_blob import SoloBlobManager
        path = self.storage / 'solo_blob.jsonc'
        path.write_text('{\n // keep these options\n "enabled": false, "riders":8, "scatter":true,\n}\n')
        manager = SoloBlobManager(str(self.storage), lambda: [], {}, lambda: 0, lambda: {}, lambda value: None)
        manager.load()
        self.assertIn('ON', manager.chat_command(1, 'record'))
        self.assertIn('// keep these options', path.read_text())
        self.assertTrue(parse(path.read_text())['scatter'])
        self.assertTrue(parse(path.read_text())['record'])
        manager.blobs = previous = {1: object()}
        path.write_text('{"enabled":"wrong-type"}')
        with self.assertLogs('solo_blob', level='WARNING'):
            manager.load()
        self.assertIs(manager.blobs, previous)

    def test_peloton_chat_edits_current_document_and_preserves_other_entries(self):
        from types import SimpleNamespace
        from peloton import PelotonManager
        path = self.storage / 'peloton.jsonc'
        path.write_text('{"pelotons": [\n /* mine */ {"pacer":"A", "bots":1},\n /* other */ {"pacer":"B", "bots":2},\n]}')
        pacers = {1: SimpleNamespace(folder='A', profile=SimpleNamespace(last_name='A')),
                  2: SimpleNamespace(folder='B', profile=SimpleNamespace(last_name='B'))}
        manager = PelotonManager(str(self.storage), pacers, lambda: [], {}, lambda: 0, lambda followers: None)
        with patch.object(manager, '_nearest_pacer_id', return_value=1), patch.object(manager, 'load'):
            self.assertIn('12 bots', manager.chat_command(None, '12'))
            self.assertIn('/* other */ {"pacer":"B", "bots":2}', path.read_text())
            manager.chat_command(None, 'off')
        self.assertEqual(parse(path.read_text())['pelotons'], [{'pacer': 'B', 'bots': 2}])
        self.assertIn('/* other */', path.read_text())
        from zluggish_config.schema import PELOTON
        edit_setting(path, PELOTON, 'pelotons', reset=True)
        self.assertEqual(manager._read_config()['pelotons'], [])



if __name__ == '__main__':
    unittest.main()
