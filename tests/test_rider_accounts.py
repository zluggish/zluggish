"""Real Flask account/launcher routes, token handoff, imports and legacy conversion."""
import importlib.util
from contextlib import closing
import io
import json
from pathlib import Path
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
from types import SimpleNamespace

from flask import jsonify
from flask_login import LoginManager, current_user, login_required
from werkzeug.security import generate_password_hash, check_password_hash


class RiderAccountsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(__file__).resolve().parents[1]
        server = Path(cls.temp.name)
        for folder in ('data', 'cdn'):
            shutil.copytree(root / folder, server / folder)
        cls.storage = server / 'storage'
        cls.storage.mkdir()
        (cls.storage / 'config.jsonc').write_text(json.dumps({'config_version': 1, 'proxy': {'mode': 'disabled'}}))
        shutil.copyfile(root / 'zwift_offline.py', server / 'zwift_offline.py')
        sys.path.insert(0, str(root / 'protobuf'))
        spec = importlib.util.spec_from_file_location('rider_test_server', server / 'zwift_offline.py')
        cls.zo = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.zo)
        cls.zo.app.config.update(TESTING=True)
        manager = LoginManager(cls.zo.app)
        manager.login_view = 'login'
        manager.user_loader(cls.zo.load_account_identity)
        cls.zo.login_manager = manager

        @cls.zo.app.route('/test/identity')
        @cls.zo.jwt_to_session_cookie
        @login_required
        def identity():
            return jsonify(player_id=current_user.player_id)

    @classmethod
    def tearDownClass(cls):
        with cls.zo.app.app_context():
            cls.zo.db.session.remove()
            cls.zo.db.engine.dispose()
        cls.zo.SERVER_LOCK.release()
        cls.zo.logger.removeHandler(cls.zo.logHandler)
        cls.zo.logHandler.close()
        cls.temp.cleanup()

    def setUp(self):
        for path in self.storage.iterdir():
            if path.is_dir():
                shutil.rmtree(path)
        self.client = self.zo.app.test_client()
        self.zo.online.clear()
        self.zo.player_partial_profiles.clear()
        self.zo.SETTINGS['accounts']['allow_self_registration'] = True
        with self.zo.app.app_context():
            self.zo.db.drop_all()
            self.zo.db.create_all()
            self.zo.db.session.add(self.zo.AccountState(id=1, setup_complete=True))
            self.zo.db.session.add(self.zo.Version(version=4))
            self.zo.db.session.commit()
        (self.storage / 'account-migration.json').unlink(missing_ok=True)

    def add_user(self, player_id=1, first='Alex', last='Rider', password=None, admin=False):
        with self.zo.app.app_context():
            self.zo.db.session.add(self.zo.User(player_id=player_id, first_name=first, last_name=last,
                username='rider%s@example.test' % player_id,
                pass_hash=generate_password_hash(password, 'scrypt') if password else None, is_admin=admin))
            self.zo.db.session.commit()

    def csrf(self, client=None):
        client = client or self.client
        client.get('/login/', follow_redirects=True)
        with client.session_transaction() as sess:
            return sess['csrf_token']

    def select(self, player_id=1, client=None, password=None):
        client = client or self.client
        data = dict(player_id=str(player_id), csrf_token=self.csrf(client))
        if password is not None:
            data['password'] = password
        return client.post('/login/', data=data)

    def profile_data(self, source_id=999, first='Official', last='Rider'):
        return self.zo.profile_pb2.PlayerProfile(id=source_id, first_name=first, last_name=last, total_xp=1200).SerializeToString()

    def tokens(self, client=None):
        client = client or self.client
        code = client.get('/ride').location.split('?code=', 1)[1]
        return client.post('/auth/realms/zwift/protocol/openid-connect/token', data={'code': code}).json

    def stage_file(self, **extra):
        data = {'source': 'files', 'csrf_token': self.csrf(),
                'profile.bin': (io.BytesIO(self.profile_data()), 'profile.bin'), **extra}
        # csrf() returns to picker, so select again to enable subsequent launching.
        return self.client.post('/profile/rider1@example.test/', data=data)

    def test_first_run_uses_add_form_and_requires_setup_secret(self):
        with self.zo.app.app_context():
            self.zo.db.session.get(self.zo.AccountState, 1).setup_complete = False
            self.zo.db.session.commit()
        response = self.client.get('/login/', follow_redirects=True)
        self.assertIn('Create your first rider', response.text)
        token = self.csrf()
        data = dict(display_name=' Robin Smith ', csrf_token=token)
        self.assertEqual(self.client.post('/riders/add/', data=data).status_code, 403)
        from zluggish_config.accounts import setup_secret
        data['setup_token'] = setup_secret(self.storage)
        self.assertEqual(self.client.post('/riders/add/', data=data).status_code, 302)
        with self.zo.app.app_context():
            user = self.zo.User.query.one()
            self.assertEqual(user.player_id, 1)
            self.assertEqual(user.first_name, 'Robin')
            self.assertIsNone(user.pass_hash)
            self.assertTrue(user.is_admin)
        self.assertFalse((self.storage / 'setup-token.txt').exists())
        self.assertIn('Robin', self.client.get('/login/').text)
        self.assertEqual(self.select().status_code, 302)
        response = self.client.get('/api/profiles/me', headers={'Accept': 'application/json'})
        self.assertEqual(response.json['firstName'], 'Robin')
        self.assertNotIn('zoffline', response.text)

    def test_add_rider_optional_password_duplicate_names_and_id_collisions(self):
        self.add_user(admin=True)
        (self.storage / '7').mkdir()
        for password in ('', 'local-password'):
            response = self.client.post('/riders/add/', data=dict(display_name='Alex Rider', password=password,
                confirm_password=password, csrf_token=self.csrf()))
            self.assertEqual(response.status_code, 302)
        with self.zo.app.app_context():
            users = self.zo.User.query.order_by(self.zo.User.player_id).all()
            self.assertEqual([u.player_id for u in users], [1, 8, 9])
            self.assertFalse(users[1].is_admin)
            self.assertIsNone(users[1].pass_hash)
            self.assertTrue(check_password_hash(users[2].pass_hash, 'local-password'))
        self.assertIn('Rider #9', self.client.get('/login/').text)

    def test_registration_permission_and_directory_failure(self):
        self.add_user()
        self.zo.SETTINGS['accounts']['allow_self_registration'] = False
        self.assertEqual(self.client.get('/riders/add/').status_code, 403)
        self.assertNotIn('Add rider', self.client.get('/login/').text)
        self.zo.SETTINGS['accounts']['allow_self_registration'] = True
        with patch.object(self.zo, 'make_profile_dir', return_value=False):
            response = self.client.post('/riders/add/', data=dict(display_name='Robin', csrf_token=self.csrf()))
            self.assertIn('Could not create rider', response.text)
        with self.zo.app.app_context():
            self.assertEqual(self.zo.User.query.count(), 1)
        self.assertFalse((self.storage / '2').exists())

    def test_protected_picker_cannot_be_bypassed(self):
        self.add_user(password='secret')
        self.assertIn('Password for Alex', self.select().text)
        self.assertEqual(self.client.get('/ride').location, '/login/')
        self.assertIn('Invalid password', self.select(password='wrong').text)
        self.assertEqual(self.select(password='secret').status_code, 302)
        self.assertEqual(self.client.get('/ride').status_code, 302)
        self.assertEqual(self.client.post('/login/', data={'player_id': 1}).status_code, 400)
        token = self.csrf()
        for value in ('abc', '-1', '999', '1'*100, '١'):
            self.assertIn('no longer available', self.client.post('/login/', data={'player_id': value, 'csrf_token': token}).text)

    def test_launcher_aliases_always_show_picker_and_switch_revokes_selection(self):
        self.add_user()
        self.add_user(2, first='Robin')
        for rule in self.zo.app.url_map.iter_rules():
            if rule.endpoint == 'launch_zwift' and str(rule) != '/ride':
                self.select()
                self.assertIn('Who’s riding?', self.client.get(str(rule), follow_redirects=True).text)
                self.assertEqual(self.client.get('/ride').location, '/login/')
        response = self.select(2)
        self.assertIn('Riding as Robin Rider', self.client.get(response.location).text)
        with self.client.session_transaction() as sess:
            csrf = sess['csrf_token']
        self.client.post('/riders/switch/', data={'csrf_token': csrf})
        self.assertIsNone(self.client.get_cookie('remember_token'))
        self.assertEqual(self.client.get('/ride').location, '/login/')

    def test_distinct_clients_through_launch_refresh_and_bearer_api(self):
        self.add_user()
        self.add_user(2)
        for client, player in ((self.client, 1), (self.zo.app.test_client(), 2)):
            self.select(player, client=client)
            tokens = self.tokens(client)
            response = client.post('/auth/realms/zwift/protocol/openid-connect/token', data={'refresh_token': tokens['refresh_token']})
            self.assertEqual(response.status_code, 200)
            api = self.zo.app.test_client()
            response = api.get('/test/identity', headers={'Authorization': 'Bearer '+response.json['access_token']})
            self.assertEqual(response.json['player_id'], player)

    def test_password_add_change_remove_revokes_tokens_and_requires_current_password(self):
        self.add_user()
        self.select()
        tokens = self.tokens()
        old_cookie = self.client.get_cookie('remember_token').value
        with self.client.session_transaction() as sess:
            csrf = sess['csrf_token']
        response = self.client.post('/reset/rider1@example.test/', data=dict(csrf_token=csrf, password='secret', confirm_password='secret'))
        self.assertEqual(response.status_code, 302)
        self.assertEqual(self.client.post('/auth/realms/zwift/protocol/openid-connect/token', data={'refresh_token': tokens['refresh_token']}).status_code, 401)
        stale = self.zo.app.test_client()
        stale.set_cookie('remember_token', old_cookie)
        self.assertEqual(stale.get('/test/identity').status_code, 302)
        self.assertEqual(stale.get('/test/identity', headers={'Authorization': 'Bearer '+tokens['access_token']}).status_code, 401)
        self.select(password='secret')
        with self.client.session_transaction() as sess:
            csrf = sess['csrf_token']
        self.assertIn('incorrect', self.client.post('/reset/x/', data=dict(csrf_token=csrf, remove_password='on')).text)
        self.client.post('/reset/x/', data=dict(csrf_token=csrf, remove_password='on', current_password='secret'))
        self.assertEqual(self.select().status_code, 302)

    def test_native_credentials_and_malformed_tokens(self):
        self.add_user(password='secret')
        self.add_user(2)
        path = '/auth/realms/zwift/protocol/openid-connect/token'
        self.assertEqual(self.client.post(path, data=dict(username='rider1@example.test', password='secret')).status_code, 200)
        self.assertEqual(self.client.post(path, data=dict(username='rider2@example.test', password='anything')).status_code, 401)
        for data in ({}, {'code': 'bad'}, {'refresh_token': 'bad'}):
            self.assertEqual(self.client.post(path, data=data).status_code, 401)
        self.assertEqual(self.client.get('/test/identity', headers={'Authorization': 'bad'}).status_code, 401)

    def test_email_recovery_routes_are_removed(self):
        self.add_user(password='secret')
        self.assertEqual(self.client.get('/forgot/').status_code, 404)
        self.assertEqual(self.client.put('/api/users/reset-password-email', data={'username':'rider1@example.test'}).status_code, 404)
        self.assertIn('CLI', self.select().text)
        self.assertEqual(self.client.get('/reset/rider1@example.test/').status_code, 302)

    def test_start_options_are_per_rider_and_require_selection(self):
        self.add_user()
        self.select()
        with self.client.session_transaction() as sess:
            csrf = sess['csrf_token']
        data = dict(map='LONDON', climb='CALENDAR', enableghosts='on', csrf_token=csrf)
        self.assertEqual(self.client.post('/start-zwift', data=data).location, '/ride')
        self.assertTrue(json.loads((self.storage/'1/settings.jsonc').read_text())['ghosts']['enabled'])
        self.client.get('/login/')
        self.assertEqual(self.client.post('/start-zwift', data=data).location, '/login/')
        self.assertFalse((self.storage/'anonymous').exists())

    def test_file_import_preview_normalizes_id_and_updates_names_only_on_confirm(self):
        self.add_user(password='secret')
        self.select(password='secret')
        response = self.stage_file()
        self.assertEqual(response.status_code, 302)
        with self.zo.app.app_context():
            self.assertEqual(self.zo.User.query.one().first_name, 'Alex')
        self.assertFalse((self.storage/'1/profile.bin').exists())
        self.assertIn('Official rider #999', self.client.get(response.location).text)
        with self.client.session_transaction() as sess:
            csrf = sess['csrf_token']
        self.assertEqual(self.client.post(response.location, data=dict(csrf_token=csrf)).status_code, 400)
        response = self.client.post(response.location, data=dict(csrf_token=csrf, confirm='on'))
        self.assertEqual(response.status_code, 302)
        profile = self.zo.profile_pb2.PlayerProfile()
        profile.ParseFromString((self.storage/'1/profile.bin').read_bytes())
        self.assertEqual((profile.id, profile.first_name), (1, 'Official'))
        with self.zo.app.app_context():
            user = self.zo.User.query.one()
            self.assertEqual(user.first_name, 'Official')
            self.assertEqual(user.official_player_id, 999)
            self.assertTrue(check_password_hash(user.pass_hash, 'secret'))
            self.assertFalse(user.is_admin)
        self.assertFalse((self.storage/'999').exists())
        self.assertFalse((self.storage/'1/zwift_credentials.bin').exists())

    def test_import_keep_name_duplicate_source_warning_and_active_ride(self):
        self.add_user()
        self.add_user(2)
        with self.zo.app.app_context():
            self.zo.db.session.get(self.zo.User, 2).official_player_id = 999
            self.zo.db.session.commit()
        self.select()
        response = self.stage_file()
        self.assertIn('Another local rider', self.client.get(response.location).text)
        with self.client.session_transaction() as sess:
            csrf = sess['csrf_token']
        data = dict(csrf_token=csrf, confirm='on', keep_name='on')
        self.assertEqual(self.client.post(response.location, data=data).status_code, 400)
        data['confirm_source'] = 'on'
        self.zo.online[1] = SimpleNamespace(worldTime=self.zo.world_time())
        self.assertEqual(self.client.post(response.location, data=data).status_code, 409)
        self.zo.online.clear()
        self.client.post(response.location, data=data)
        profile = self.zo.profile_pb2.PlayerProfile()
        profile.ParseFromString((self.storage/'1/profile.bin').read_bytes())
        self.assertEqual(profile.first_name, 'Alex')

    def test_corrupt_import_and_failed_publication_preserve_previous_data(self):
        self.add_user()
        self.select()
        response = self.client.post('/profile/x/', data={'source': 'files', 'csrf_token': self.csrf(),
            'profile.bin': (io.BytesIO(b'bad'), 'profile.bin')})
        self.assertEqual(response.status_code, 200)
        self.assertFalse((self.storage/'1/profile.bin').exists())
        before = self.profile_data(1, 'Alex')
        (self.storage/'1/profile.bin').write_bytes(before)
        response = self.stage_file()
        with self.client.session_transaction() as sess:
            csrf = sess['csrf_token']
        with patch.object(self.zo.db.session, 'commit', side_effect=[OSError('disk full'), None]):
            response = self.client.post(response.location, data=dict(csrf_token=csrf, confirm='on'))
        self.assertEqual(response.status_code, 500)
        self.assertEqual((self.storage/'1/profile.bin').read_bytes(), before)

    def test_official_download_does_not_store_credentials_or_opt_into_uploads(self):
        self.add_user()
        self.select()
        with patch.object(self.zo.online_sync, 'login', return_value=('access', 'refresh')), \
             patch.object(self.zo.online_sync, 'query', return_value=self.profile_data()), \
             patch.object(self.zo.online_sync, 'logout'):
            response = self.client.post('/profile/x/', data=dict(csrf_token=self.csrf(), source='zwift',
                username='official@example.test', password='official-secret', zwift_profile='on'))
        self.assertEqual(response.status_code, 302)
        self.assertNotIn('official-secret', self.client.get(response.location).text)
        self.assertFalse((self.storage/'1/zwift_credentials.bin').exists())

    def test_solo_conversion_preserves_numeric_id_and_anonymous_preferences(self):
        folder = self.storage/'42'
        folder.mkdir()
        (folder/'profile.bin').write_bytes(self.profile_data(999, 'Legacy'))
        (folder/'ghost.bin').write_bytes(b'unchanged')
        (self.storage/'anonymous').mkdir()
        (self.storage/'anonymous/settings.jsonc').write_text('{"settings_version":1,"ghosts":{"enabled":true}}')
        with self.zo.app.app_context():
            self.zo.db.session.delete(self.zo.db.session.get(self.zo.AccountState, 1))
            self.zo.db.session.commit()
            self.zo.initialize_accounts()
            self.zo.initialize_accounts()
            user = self.zo.User.query.one()
            self.assertEqual(user.player_id, 42)
            self.assertEqual(user.first_name, 'Legacy')
            self.assertTrue(user.is_admin)
            self.assertIsNone(user.pass_hash)
        self.assertEqual((folder/'ghost.bin').read_bytes(), b'unchanged')
        self.assertTrue(json.loads((folder/'settings.jsonc').read_text())['ghosts']['enabled'])

    def test_ambiguous_and_conflicting_solo_conversion_stops(self):
        from zluggish_config.store import ConfigError
        for player in (2, 3):
            folder = self.storage/str(player)
            folder.mkdir()
            (folder/'profile.bin').write_bytes(self.profile_data())
        with self.zo.app.app_context():
            self.zo.db.session.delete(self.zo.db.session.get(self.zo.AccountState, 1))
            self.zo.db.session.commit()
            with self.assertRaisesRegex(ConfigError, 'Ambiguous'):
                self.zo.initialize_accounts()
            self.zo.db.session.rollback()
        (self.storage/'account-migration.json').write_text('{"solo_player":2}')
        (self.storage/'anonymous').mkdir()
        (self.storage/'anonymous/settings.jsonc').write_text('{"settings_version":1,"ghosts":{"enabled":true}}')
        (self.storage/'2/settings.jsonc').write_text('{"settings_version":1,"ghosts":{"enabled":false}}')
        with self.zo.app.app_context(), self.assertRaisesRegex(ConfigError, 'Conflicting'):
            self.zo.initialize_accounts()

    def test_existing_multiplayer_profiles_do_not_require_solo_mapping(self):
        self.add_user(1, password='secret')
        self.add_user(2)
        for player in (1, 2):
            (self.storage/str(player)).mkdir()
            (self.storage/str(player)/'profile.bin').write_bytes(self.profile_data(player))
        with self.zo.app.app_context():
            self.zo.db.session.delete(self.zo.db.session.get(self.zo.AccountState, 1))
            self.zo.db.session.commit()
            self.zo.initialize_accounts()
            self.assertEqual(self.zo.User.query.count(), 2)

    def test_native_duplicate_signup_rolls_back_folder_and_user(self):
        self.add_user()
        data = dict(email='rider1@example.test', password='secret', profile=dict(firstName='New', lastName='Rider'))
        self.assertEqual(self.client.post('/api/users', json=data).status_code, 400)
        with self.zo.app.app_context():
            self.assertEqual(self.zo.User.query.count(), 1)
        self.assertFalse((self.storage/'2').exists())
        data['email'] = 'native@example.test'
        self.assertEqual(self.client.post('/api/users', json=data).status_code, 200)
        with self.zo.app.app_context():
            user = self.zo.User.query.filter_by(username=data['email']).one()
            self.assertFalse(user.is_admin)
            self.assertTrue(check_password_hash(user.pass_hash, 'secret'))

    def test_second_active_ride_is_rejected(self):
        self.add_user()
        self.select()
        with self.client.session_transaction() as sess:
            csrf = sess['csrf_token']
        self.zo.online[1] = SimpleNamespace(worldTime=self.zo.world_time())
        self.assertEqual(self.client.post('/start-zwift', data=dict(csrf_token=csrf, map='CALENDAR', climb='CALENDAR')).status_code, 409)

    def test_import_recovery_restores_files_and_db_after_interruption(self):
        self.add_user()
        self.select()
        before = self.profile_data(1, 'Original')
        (self.storage/'1/profile.bin').write_bytes(before)
        response = self.stage_file()
        with self.client.session_transaction() as sess:
            stage = self.storage/'1'/sess['pending_import']
        metadata = json.loads((stage/'manifest.json').read_text())
        self.zo.rider_imports.write_bytes(stage/'old-profile.bin', before)
        metadata['state'] = 'publishing'
        self.zo.rider_imports.write_manifest(stage, metadata)
        # Simulate a crash after files and database were changed, before finalization.
        (self.storage/'1/profile.bin').write_bytes(self.profile_data(1, 'Partial'))
        with self.zo.app.app_context():
            user = self.zo.User.query.one()
            user.first_name = 'Partial'
            user.official_player_id = 999
            self.zo.db.session.commit()
            self.zo.recover_profile_imports()
            user = self.zo.User.query.one()
            self.assertEqual(user.first_name, 'Alex')
            self.assertIsNone(user.official_player_id)
            self.zo.recover_profile_imports()
        self.assertEqual((self.storage/'1/profile.bin').read_bytes(), before)
        self.assertFalse(stage.exists())

    def test_partial_category_import_preserves_profile_and_connections(self):
        self.add_user()
        self.select()
        before = self.profile_data(1, 'Alex')
        (self.storage/'1/profile.bin').write_bytes(before)
        (self.storage/'1/zwift_credentials.bin').write_bytes(b'existing-encrypted-credentials')
        achievements = self.zo.profile_pb2.Achievements()
        achievements.achievements.add().id = 123
        response = self.client.post('/profile/x/', data=dict(source='files', csrf_token=self.csrf(),
            **{'achievements.bin': (io.BytesIO(achievements.SerializeToString()), 'achievements.bin')}))
        self.assertEqual(response.status_code, 302)
        with self.client.session_transaction() as sess:
            csrf = sess['csrf_token']
        self.assertEqual(self.client.post(response.location, data=dict(csrf_token=csrf, confirm='on', confirm_source='on')).status_code, 302)
        self.assertEqual((self.storage/'1/profile.bin').read_bytes(), before)
        self.assertEqual((self.storage/'1/zwift_credentials.bin').read_bytes(), b'existing-encrypted-credentials')
        self.assertTrue((self.storage/'1/achievements.bin').exists())


    def test_legacy_sha256_password_upgrades_on_protected_selection(self):
        import hmac
        self.add_user(password='temporary')
        salt = 'legacy-salt'
        digest = hmac.new(salt.encode(), b'old-password', 'sha256').hexdigest()
        with self.zo.app.app_context():
            user = self.zo.User.query.one()
            user.pass_hash = 'sha256$%s$%s' % (salt, digest)
            self.zo.db.session.commit()
        self.assertEqual(self.select(password='old-password').status_code, 302)
        with self.zo.app.app_context():
            self.assertTrue(self.zo.User.query.one().pass_hash.startswith('scrypt:'))
            self.assertTrue(check_password_hash(self.zo.User.query.one().pass_hash, 'old-password'))

    def test_empty_default_folder_adopts_anonymous_preferences(self):
        (self.storage/'1').mkdir()
        (self.storage/'anonymous').mkdir()
        (self.storage/'anonymous/settings.jsonc').write_text('{"settings_version":1,"ghosts":{"enabled":true}}')
        with self.zo.app.app_context():
            state = self.zo.db.session.get(self.zo.AccountState, 1)
            state.setup_complete = False
            self.zo.db.session.commit()
        from zluggish_config.accounts import setup_secret
        data = dict(display_name='First Rider', password='secret', confirm_password='secret',
                    csrf_token=self.csrf(), setup_token=setup_secret(self.storage))
        self.assertEqual(self.client.post('/riders/add/', data=data).status_code, 302)
        self.assertTrue(json.loads((self.storage/'1/settings.jsonc').read_text())['ghosts']['enabled'])
        self.assertEqual(self.select(password='secret').status_code, 302)
        with self.zo.app.app_context():
            with self.assertRaisesRegex(ValueError, 'already'):
                self.zo.create_rider('Intruder', '', owner=True)
            self.assertEqual(self.zo.User.query.count(), 1)

    def test_import_rejects_missing_csrf_and_new_rider_is_escaped(self):
        self.add_user(first='<script>')
        self.select()
        self.assertEqual(self.client.post('/profile/x/', data=dict(source='files')).status_code, 400)
        page = self.client.get('/login/').text
        self.assertIn('&lt;script&gt;', page)
        self.assertNotIn('<strong><script>', page)



class OfflineSchemaTests(unittest.TestCase):
    def test_existing_passwords_and_roles_survive_nullable_schema_migration(self):
        from zluggish_config.accounts import migrate_schema, recover
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'zwift-offline.db'
            old_hash = generate_password_hash('secret')
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('CREATE TABLE user (player_id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, pass_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0)')
                db.execute('INSERT INTO user VALUES (1, ?, ?, 0)', ('local@example.test', old_hash))
            migrate_schema(directory)
            migrate_schema(directory)
            with closing(sqlite3.connect(path)) as db, db:
                self.assertEqual(db.execute('SELECT pass_hash,is_admin,auth_version FROM user').fetchone(), (old_hash, 1, 1))
                self.assertFalse(next(c for c in db.execute('PRAGMA table_info(user)') if c[1]=='pass_hash')[3])
            with closing(sqlite3.connect(path)) as db, db:
                db.execute('CREATE TABLE version (version INTEGER)')
                db.execute('INSERT INTO version VALUES (4)')
                db.execute('CREATE TABLE account_state (id INTEGER PRIMARY KEY, setup_complete INTEGER)')
                db.execute('INSERT INTO account_state VALUES (1,1)')
            recover(directory, 1, 'new')
            with closing(sqlite3.connect(path)) as db, db:
                row = db.execute('SELECT pass_hash, auth_version FROM user').fetchone()
                self.assertTrue(check_password_hash(row[0], 'new'))
                self.assertEqual(row[1], 2)
            self.assertTrue(list(Path(directory).glob('*.bak')))

    def test_config_conversion_preserves_settings_and_respects_server_lock(self):
        from cli.__main__ import main
        from contextlib import redirect_stdout, redirect_stderr
        from filelock import FileLock
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            config = folder/'config.jsonc'
            config.write_text('{"config_version":1,"server":{"multiplayer":true,"family_mode":false,"advertised_ip":"192.0.2.1"},"launcher":{"auto_launch":true},"logging":{"level":"DEBUG"}}')
            args = ['--storage-dir', directory, 'accounts', 'migrate']
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                with FileLock(str(folder/'.server.lock')):
                    self.assertEqual(main(args), 2)
                self.assertEqual(main(args), 0)
                self.assertEqual(main(args), 0)
            converted = json.loads(config.read_text())
            self.assertEqual(converted['server'], {'advertised_ip': '192.0.2.1'})
            self.assertEqual(converted['logging']['level'], 'DEBUG')
            self.assertNotIn('launcher', converted)
            self.assertEqual(json.loads((folder/'account-migration.json').read_text())['settings_source'], 'rider')
            self.assertTrue(list(folder.glob('config.jsonc.accounts-*.bak')))


    def test_server_refuses_old_database_without_writing_and_cli_upgrades_it(self):
        import os
        import subprocess
        from cli.__main__ import main
        from contextlib import redirect_stdout, redirect_stderr
        from zluggish_config.accounts import require_current_schema
        from zluggish_config.store import ConfigError
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            storage = Path(directory)
            config = storage/'config.jsonc'
            config.write_text('{"config_version":1,"proxy":{"mode":"disabled"}}')
            database = storage/'zwift-offline.db'
            old_hash = generate_password_hash('existing-password')
            with closing(sqlite3.connect(database)) as db, db:
                db.execute('CREATE TABLE user (player_id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, pass_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0)')
                db.execute('INSERT INTO user VALUES (1, ?, ?, ?, ?, 0)', ('old@example.test', 'Old', 'Rider', old_hash))
                db.execute('CREATE TABLE version (version INTEGER PRIMARY KEY)')
                db.execute('INSERT INTO version VALUES (3)')
            before = {p: p.read_bytes() for p in storage.iterdir() if p.is_file()}
            result = subprocess.run([sys.executable, str(root/'zwift_offline.py')],
                env={**os.environ, 'ZLUGGISH_STORAGE_DIR': directory, 'ZLUGGISH_CONFIG': str(config)}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn('accounts migrate', result.stderr)
            self.assertEqual(before, {p:p.read_bytes() for p in storage.iterdir() if p.is_file()})
            with self.assertRaisesRegex(ConfigError, 'accounts migrate'):
                require_current_schema(storage)
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(main(['--storage-dir', directory, 'accounts', 'migrate']), 0)
            require_current_schema(storage)
            with closing(sqlite3.connect(database)) as db, db:
                self.assertEqual(db.execute('SELECT pass_hash,is_admin,auth_version FROM user').fetchone(), (old_hash,1,1))
                self.assertEqual(db.execute('SELECT version FROM version').fetchone(), (4,))
                self.assertEqual(db.execute('SELECT setup_complete FROM account_state').fetchone(), (1,))

    def test_solo_profile_is_attached_by_cli_not_startup(self):
        from cli.__main__ import main
        from contextlib import redirect_stdout, redirect_stderr
        from zluggish_config.accounts import require_current_schema
        from zluggish_config.store import ConfigError
        import profile_pb2
        with tempfile.TemporaryDirectory() as directory:
            storage = Path(directory)
            (storage/'config.jsonc').write_text('{"config_version":1,"proxy":{"mode":"disabled"}}')
            (storage/'42').mkdir()
            raw = profile_pb2.PlayerProfile(id=999,first_name='Legacy',last_name='Rider').SerializeToString()
            (storage/'42/profile.bin').write_bytes(raw)
            (storage/'anonymous').mkdir()
            (storage/'anonymous/settings.jsonc').write_text('{"settings_version":1,"ghosts":{"enabled":true}}')
            with self.assertRaisesRegex(ConfigError, 'accounts migrate'):
                require_current_schema(storage)
            self.assertFalse((storage/'zwift-offline.db').exists())
            with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                self.assertEqual(main(['--storage-dir', directory, 'accounts', 'migrate']), 0)
            require_current_schema(storage)
            with closing(sqlite3.connect(storage/'zwift-offline.db')) as db, db:
                self.assertEqual(db.execute('SELECT player_id,first_name,pass_hash,is_admin FROM user').fetchone(),(42,'Legacy',None,1))
            self.assertEqual((storage/'42/profile.bin').read_bytes(), raw)
            self.assertTrue(json.loads((storage/'42/settings.jsonc').read_text())['ghosts']['enabled'])



if __name__ == '__main__':
    unittest.main()
