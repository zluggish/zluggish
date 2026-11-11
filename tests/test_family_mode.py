"""Exercise real Flask routes against a temporary server database and storage.

Run with: python -m unittest discover -s tests -v
"""
import importlib.util
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

from flask import jsonify
from flask_login import LoginManager, current_user, decode_cookie, login_required
from werkzeug.security import check_password_hash, generate_password_hash
import jwt


class FamilyModeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(__file__).resolve().parents[1]
        server = Path(cls.temp.name)
        for folder in ('data', 'cdn'):
            (server / folder).symlink_to(root / folder, target_is_directory=True)
        storage = server / 'storage'
        storage.mkdir()
        (storage / 'multiplayer.txt').touch()
        (storage / 'family_mode.txt').touch()
        shutil.copyfile(root / 'zwift_offline.py', server / 'zwift_offline.py')
        sys.path.insert(0, str(root / 'protobuf'))
        spec = importlib.util.spec_from_file_location('family_test_server', server / 'zwift_offline.py')
        cls.zo = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.zo)
        cls.zo.app.config.update(TESTING=True)
        manager = LoginManager(cls.zo.app)
        manager.login_view = 'login'
        manager.session_protection = None
        manager.user_loader(lambda uid: cls.zo.db.session.get(cls.zo.User, int(uid)))
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
        cls.temp.cleanup()

    def setUp(self):
        self.zo.FAMILY_MODE = True
        self.client = self.zo.app.test_client()
        with self.zo.app.app_context():
            self.zo.db.drop_all()
            self.zo.db.create_all()

    def add_user(self, player_id=1, first='Alex', last='Family', username=None, admin=False):
        with self.zo.app.app_context():
            self.zo.db.session.add(self.zo.User(
                player_id=player_id, first_name=first, last_name=last,
                username=username or 'rider%s@example.test' % player_id,
                pass_hash=generate_password_hash('existing-password', 'scrypt'),
                is_admin=admin, remember=True))
            self.zo.db.session.commit()

    def csrf(self, client=None):
        client = client or self.client
        client.get('/login/')
        # The empty picker has no selection form; account creation has one.
        client.get('/family/add/')
        with client.session_transaction() as sess:
            return sess['family_csrf_token']

    def select(self, player_id, client=None):
        client = client or self.client
        return client.post('/login/', data={'player_id': player_id, 'csrf_token': self.csrf(client)})

    def test_lists_all_users_sorted_and_escaped_with_duplicate_identifiers(self):
        self.add_user(1, 'Zoe', admin=True)
        self.add_user(2, 'Alex')
        self.add_user(3, 'Alex')
        self.add_user(4, '<script>')
        page = self.client.get('/login/').get_data(as_text=True)
        self.assertIn('Who’s riding?', page)
        for player_id in range(1, 5):
            self.assertIn('Rider #%s' % player_id, page)
        self.assertLess(page.index('value="2"'), page.index('value="3"'))
        self.assertLess(page.index('value="3"'), page.index('value="1"'))
        self.assertIn('&lt;script&gt;', page)
        self.assertNotIn('name="password"', page)
        self.assertNotIn('Remember me', page)

    def test_select_and_switch_replace_session_and_cookie(self):
        self.add_user(1)
        self.add_user(2, 'Robin')
        response = self.select(1)
        self.assertEqual(response.status_code, 302)
        self.assertTrue((Path(self.temp.name) / 'storage/1').is_dir())
        old_cookie = self.client.get_cookie('remember_token').value
        response = self.select(2)
        self.assertIn('/user/rider2@example.test/', response.location)
        home = self.client.get(response.location).get_data(as_text=True)
        self.assertIn('Riding as Robin Family', home)
        self.assertIn('Switch rider', home)
        self.assertIn('name="map"', home)
        self.assertIn('name="climb"', home)
        new_cookie = self.client.get_cookie('remember_token').value
        self.assertNotEqual(old_cookie, new_cookie)
        with self.zo.app.app_context():
            self.assertEqual(decode_cookie(new_cookie), '2')
        with self.client.session_transaction() as sess:
            self.assertEqual(sess['_user_id'], 2)
            token = sess.setdefault('family_csrf_token', 'test-token')
        response = self.client.post('/family/switch/', data={'csrf_token': token})
        self.assertEqual(response.status_code, 302)
        self.assertIsNone(self.client.get_cookie('remember_token'))
        self.assertEqual(self.client.get('/ride').location, '/login/')

    def test_clients_keep_separate_identity_through_launch_and_token_refresh(self):
        self.add_user(1)
        self.add_user(2)
        other = self.zo.app.test_client()
        for client, player_id in ((self.client, 1), (other, 2)):
            self.select(player_id, client)
            launch = client.get('/ride')
            self.assertTrue(launch.location.startswith('http://zwift/?code=zwift_refresh_token'))
            code = launch.location.split('?code=', 1)[1]
            tokens = client.post('/auth/realms/zwift/protocol/openid-connect/token', data={'code': code}).json
            refreshed = client.post('/auth/realms/zwift/protocol/openid-connect/token',
                                    data={'refresh_token': tokens['refresh_token']}).json
            # Authenticate a separate API client using only the game token.
            api = self.zo.app.test_client()
            response = api.get('/test/identity', headers={'Authorization': 'Bearer ' + refreshed['access_token']})
            self.assertEqual(response.json['player_id'], player_id)
            payload = jwt.decode(refreshed['access_token'], options={'verify_signature': False})
            with self.zo.app.app_context():
                self.assertEqual(decode_cookie(payload['session_cookie']), str(player_id))

    def test_all_launcher_aliases_show_picker_even_with_auto_launch_and_remember(self):
        self.add_user()
        auto_launch = Path(self.temp.name) / 'storage/auto_launch.txt'
        auto_launch.touch()
        self.addCleanup(auto_launch.unlink)
        aliases = [str(rule) for rule in self.zo.app.url_map.iter_rules()
                   if rule.endpoint == 'launch_zwift' and str(rule) != '/ride']
        self.assertIn('/launcher/ride', aliases)
        for alias in aliases:
            with self.subTest(alias=alias):
                self.select(1)
                response = self.client.get(alias, follow_redirects=True)
                self.assertIn('Who’s riding?', response.get_data(as_text=True))
                self.assertEqual(self.client.get('/ride').location, '/login/')

    def test_invalid_selection_and_cross_site_submission(self):
        self.add_user()
        self.assertEqual(self.client.post('/login/', data={'player_id': 1}).status_code, 400)
        self.assertEqual(self.client.get('/ride').location, '/login/')
        token = self.csrf()
        self.assertEqual(self.client.post('/login/', data={'player_id': 1, 'csrf_token': 'å'}).status_code, 400)
        for value in ('', 'abc', '-1', '999', '1' * 100, '١'):
            response = self.client.post('/login/', data={'player_id': value, 'csrf_token': token})
            self.assertIn('no longer available', response.get_data(as_text=True))
            self.assertEqual(self.client.get('/ride').location, '/login/')

    def test_family_creation_without_password_and_without_admin_privileges(self):
        page = self.client.get('/login/').get_data(as_text=True)
        self.assertIn('No family members yet', page)
        token = self.csrf()
        self.assertEqual(self.client.post('/family/add/', data={'display_name': 'Robin'}).status_code, 400)
        for name in (' ', 'a' * 101):
            response = self.client.post('/family/add/', data={'display_name': name, 'csrf_token': token})
            self.assertIn('Enter a name', response.get_data(as_text=True))
        self.client.post('/family/add/', data={'display_name': ' Robin Family ', 'csrf_token': token})
        with self.zo.app.app_context():
            user = self.zo.User.query.one()
            self.assertEqual((user.first_name, user.last_name), ('Robin', 'Family'))
            self.assertTrue(user.username.endswith('@local.invalid'))
            self.assertFalse(self.zo.is_admin(user))
            self.assertFalse(check_password_hash(user.pass_hash, ''))
            self.assertEqual(user.player_id, 2)
        self.assertEqual(self.select(2).status_code, 302)

    def test_start_requires_selection_and_retains_ride_options(self):
        self.add_user()
        self.select(1)
        with self.client.session_transaction() as sess:
            token = sess.setdefault('family_csrf_token', 'test-token')
        self.assertEqual(self.client.post('/start-zwift', data={'map': 'LONDON'}).status_code, 400)
        response = self.client.post('/start-zwift', data={
            'csrf_token': token, 'map': 'LONDON', 'climb': 'CALENDAR', 'enableghosts': 'on'})
        self.assertEqual(response.location, '/ride')
        self.assertEqual(self.zo.map_override['127.0.0.1'], 'LONDON')
        self.client.get('/login/')
        self.assertEqual(self.client.post('/start-zwift').location, '/login/')

    def test_profile_directory_failure_does_not_change_identity(self):
        self.add_user()
        with patch.object(self.zo, 'make_profile_dir', return_value=False):
            self.assertEqual(self.select(1).status_code, 500)
        self.assertEqual(self.client.get('/ride').location, '/login/')

    def test_normal_login_remember_reset_and_android_still_work(self):
        self.add_user()
        self.zo.FAMILY_MODE = False
        self.assertEqual(self.client.get('/family/add/').status_code, 404)
        page = self.client.get('/login/').get_data(as_text=True)
        self.assertIn('name="password"', page)
        bad = self.client.post('/login/', data={'username': 'rider1@example.test', 'password': 'wrong'})
        self.assertIn('Invalid username or password', bad.get_data(as_text=True))
        response = self.client.post('/login/', data={
            'username': 'rider1@example.test', 'password': 'existing-password', 'remember': 'on'})
        self.assertEqual(response.status_code, 302)
        self.assertIn('/user/', self.client.get('/login/').location)
        response = self.client.post('/reset/rider1@example.test/', data={
            'password': 'new-password', 'confirm_password': 'new-password'})
        self.assertEqual(response.status_code, 302)
        self.zo.FAMILY_MODE = True
        android = self.zo.app.test_client()
        response = android.post('/auth/realms/zwift/protocol/openid-connect/token', data={
            'username': 'rider1@example.test', 'password': 'new-password'})
        self.assertEqual(response.status_code, 200)
        self.assertIn('access_token', response.json)

    def test_family_password_recovery_before_disabling_mode(self):
        token = self.csrf()
        self.client.post('/family/add/', data={'display_name': 'Robin', 'csrf_token': token})
        response = self.select(2)
        with self.zo.app.app_context():
            username = self.zo.User.query.one().username
        settings = self.client.get('/settings/%s/' % username).get_data(as_text=True)
        self.assertIn(username, settings)
        self.assertIn('Set login password', settings)
        self.client.get('/reset/%s/' % username)
        with self.client.session_transaction() as sess:
            token = sess['family_csrf_token']
        response = self.client.post('/reset/%s/' % username, data={
            'csrf_token': token, 'password': 'chosen-password', 'confirm_password': 'chosen-password'})
        self.assertEqual(response.status_code, 302)
        self.zo.FAMILY_MODE = False
        client = self.zo.app.test_client()
        self.assertEqual(client.post('/login/', data={
            'username': username, 'password': 'chosen-password'}).status_code, 302)

    def test_deleted_rider_and_missing_name(self):
        self.add_user(1, first='', last='')
        page = self.client.get('/login/').get_data(as_text=True)
        self.assertIn('rider1@example.test', page)
        token = self.csrf()
        with self.zo.app.app_context():
            self.zo.db.session.delete(self.zo.db.session.get(self.zo.User, 1))
            self.zo.db.session.commit()
        response = self.client.post('/login/', data={'player_id': 1, 'csrf_token': token})
        self.assertIn('no longer available', response.get_data(as_text=True))

    def test_family_mode_requires_multiplayer_at_startup(self):
        server = Path(self.temp.name) / 'zwift_offline.py'
        spec = importlib.util.spec_from_file_location('invalid_family_server', server)
        module = importlib.util.module_from_spec(spec)
        exists = self.zo.os.path.exists
        def without_multiplayer(path):
            return False if str(path).endswith('/multiplayer.txt') else exists(path)
        with patch('os.path.exists', side_effect=without_multiplayer):
            with self.assertLogs('zoffline', level='ERROR') as logs:
                with self.assertRaises(SystemExit) as error:
                    spec.loader.exec_module(module)
        self.assertEqual(error.exception.code, 1)
        self.assertIn('requires storage/multiplayer.txt', logs.output[0])


if __name__ == '__main__':
    unittest.main()
