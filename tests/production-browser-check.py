"""Repeatable browser regression against an explicitly isolated production server.

Example (run on the same machine as the supplied server):
  python tests/production-browser-check.py --url http://192.168.1.10:3222 \
    --credentials test-results/fresh-production/credentials.json

Credentials may instead come from CHATPONY_E2E_ADMIN_EMAIL/PASSWORD. This script
only accepts HTTP loopback/private-network URLs with an explicit port. Every
model used is created by this run and points to an in-process loopback mock with
a nonempty API key. It never invokes a pre-existing model or sends email.

Settings and pre-existing account quota overrides are restored in finally.
Created conversations/memories are deleted and model resources are archived.
The public API has no user-delete endpoint, so the temporary user is disabled;
its historical quota/audit records and archived resources remain in the isolated
test database. Dispose of that database when finished. Never target live data.
"""

import argparse
import ipaddress
import json
import os
import re
import secrets
import socket
import sys
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect, sync_playwright


class CheckFailure(RuntimeError):
    """A message deliberately limited to non-secret diagnostic information."""


def require(condition, message):
    if not condition:
        raise CheckFailure(message)


def arguments():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--url', required=True, help='Explicitly isolated HTTP server on this machine, with port.')
    parser.add_argument('--credentials', type=Path, help='JSON file with email/password; otherwise use the two CHATPONY_E2E_ADMIN_* variables.')
    parser.add_argument('--artifacts', type=Path, default=Path('test-results/production-browser'), help='Parent directory for a redacted report and non-credential screenshots.')
    parser.add_argument('--chromium', help='Optional Chromium executable; CHATPONY_CHROMIUM is also supported.')
    result = parser.parse_args()
    parsed = urlsplit(result.url)
    require(parsed.scheme == 'http' and parsed.hostname and parsed.port, 'Use an isolated HTTP URL with an explicit port.')
    require(not parsed.username and not parsed.password and parsed.path in ('', '/') and not parsed.query and not parsed.fragment, 'The server URL must contain only scheme, host and port.')
    try:
        addresses = {ipaddress.ip_address(item[4][0]) for item in socket.getaddrinfo(parsed.hostname, parsed.port)}
    except (socket.gaierror, ValueError) as error:
        raise CheckFailure('The isolated server hostname could not be resolved.') from error
    require(addresses and all(address.is_loopback or address.is_private for address in addresses), 'Public-network targets are not permitted.')
    result.url = result.url.rstrip('/')
    if os.environ.get('CHATPONY_E2E_ADMIN_EMAIL') and os.environ.get('CHATPONY_E2E_ADMIN_PASSWORD'):
        result.credentials_value = {'email': os.environ['CHATPONY_E2E_ADMIN_EMAIL'], 'password': os.environ['CHATPONY_E2E_ADMIN_PASSWORD']}
    else:
        require(result.credentials is not None, 'Provide --credentials or CHATPONY_E2E_ADMIN_EMAIL/PASSWORD.')
        try:
            result.credentials_value = json.loads(result.credentials.read_text(encoding='utf-8-sig'))
        except (OSError, ValueError) as error:
            raise CheckFailure('The credential file could not be loaded.') from error
    require(all(isinstance(result.credentials_value.get(key), str) and result.credentials_value[key] for key in ('email', 'password')), 'Credentials must provide nonempty email/password fields.')
    return result


class LocalModel:
    def __init__(self):
        self.initial_key = secrets.token_urlsafe(24)
        self.updated_key = secrets.token_urlsafe(24)
        self.expected_key = self.initial_key
        self.phase = 'initial'
        self.calls = []
        self.lock = threading.Lock()
        state = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                length = int(self.headers.get('Content-Length', '0'))
                if length > 1024 * 1024:
                    self.send_error(413)
                    return
                try:
                    request = json.loads(self.rfile.read(length))
                except ValueError:
                    self.send_error(400)
                    return
                with state.lock:
                    valid = self.headers.get('Authorization') == 'Bearer ' + state.expected_key
                    state.calls.append({'validAuth': valid, 'path': self.path, 'phase': state.phase})
                supported = self.path == '/v1/chat/completions' and request.get('model') == 'production-browser-fixture'
                status = 200 if valid and supported else 401 if not valid else 400
                body = {'choices': [{'message': {'content': '本地生产回归验证通过。'}, 'finish_reason': 'stop'}]} if status == 200 else {'error': {'message': 'Local fixture rejected this request.'}}
                encoded = json.dumps(body, ensure_ascii=False).encode('utf-8')
                self.send_response(status)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def base_url(self):
        return f'http://127.0.0.1:{self.server.server_port}/v1'

    def expect_replacement(self):
        with self.lock:
            self.expected_key = self.updated_key
            self.phase = 'updated'

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class Regression:
    SETTING_KEYS = ['registrationOpen', 'requireEmailVerification', 'emailDomainMode', 'emailDomains', 'automaticMemoryEnabled', 'compressionModelId', 'memorySummaryModelId', 'compressionTriggerRounds', 'compressionKeepRounds', 'bubbleDelimiter', 'hiddenSymbols']

    def __init__(self, args):
        self.args = args
        self.base = args.url
        self.credentials = args.credentials_value
        self.suffix = uuid.uuid4().hex[:10]
        self.name = 'Production regression ' + self.suffix
        self.artifacts = args.artifacts / self.suffix
        self.artifacts.mkdir(parents=True, exist_ok=False)
        self.report = {'ok': False, 'checks': {}, 'cleanup': {}, 'stage': 'starting'}
        self.model = LocalModel()
        self.browser = None
        self.admin = None
        self.admin_logged_in = False
        self.cleanup_admin = None
        self.user = None
        self.user_id = None
        self.user_email = f'production-{self.suffix}@example.test'
        self.user_password = secrets.token_urlsafe(24)
        self.old_settings = None
        self.old_embedding = None
        self.old_users = None
        self.global_changed = False
        self.suppliers = []
        self.models = []
        self.characters = []
        self.conversations = []
        self.page_errors = []

    def stage(self, name):
        self.report['stage'] = name

    def api(self, context, path, method='GET', body=None, expected=200):
        response = context.request.fetch(self.base + '/api' + path, method=method, data=body, headers={'Content-Type': 'application/json'}, timeout=60000)
        require(response.status == expected, f'API {method} {path.split("?")[0]} returned HTTP {response.status}, expected {expected}.')
        result = response.json()
        if expected >= 400:
            return result.get('error', {})
        require('data' in result, 'The API response omitted its data envelope.')
        return result['data']

    def watch(self, page):
        page.on('pageerror', lambda _error: self.page_errors.append('browser-page-error'))
        return page

    def login(self, page, credentials):
        page.goto(self.base, wait_until='networkidle')
        page.get_by_role('button', name='登录 / 注册', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_label('邮箱', exact=True).fill(credentials['email'])
        dialog.get_by_label('密码', exact=True).fill(credentials['password'])
        with page.expect_response(lambda response: response.url.endswith('/api/auth/login') and response.request.method == 'POST') as received:
            dialog.get_by_role('button', name='登录', exact=True).click()
        require(received.value.status == 200, 'Browser login request failed.')
        require('; secure' not in received.value.all_headers().get('set-cookie', '').lower(), 'HTTP login returned a Secure cookie.')
        expect(dialog).not_to_be_visible(timeout=15000)

    def setup(self, playwright):
        self.stage('browser login and persistence')
        executable = self.args.chromium or os.environ.get('CHATPONY_CHROMIUM')
        if not executable:
            bundled = Path(os.environ.get('LOCALAPPDATA', '')) / 'ms-playwright'
            choices = sorted(bundled.glob('chromium-*/chrome-win64/chrome.exe'), reverse=True) if bundled.exists() else []
            executable = str(choices[0]) if choices else None
        options = {'headless': True, 'args': ['--disable-features=OverlayScrollbar']}
        if executable:
            options['executable_path'] = executable
        self.browser = playwright.chromium.launch(**options)
        self.admin = self.browser.new_context(viewport={'width': 1920, 'height': 1080})
        self.admin_page = self.watch(self.admin.new_page())
        self.login(self.admin_page, self.credentials)
        self.admin_logged_in = True
        require(self.api(self.admin, '/bootstrap')['user']['email'] == self.credentials['email'], 'Browser login did not establish the administrator session.')
        self.admin_page.reload(wait_until='networkidle')
        require(self.admin_page.get_by_role('button', name='登录 / 注册', exact=True).count() == 0, 'Refresh lost the HTTP login.')
        tab = self.admin.new_page()
        tab.goto(self.base, wait_until='networkidle')
        require(tab.get_by_role('button', name='登录 / 注册', exact=True).count() == 0, 'A new page lost the HTTP login.')
        tab.close()
        self.report['checks']['httpLoginRefreshAndNewPage'] = True
        self.cleanup_admin = self.browser.new_context()
        self.api(self.cleanup_admin, '/auth/login', 'POST', self.credentials)
        self.old_settings = self.api(self.cleanup_admin, '/admin/settings')
        self.old_embedding = self.api(self.cleanup_admin, '/admin/embeddings')
        self.old_users = self.api(self.cleanup_admin, '/admin/users')
        self.api(self.cleanup_admin, '/admin/settings', 'PATCH', {
            'registrationOpen': True, 'requireEmailVerification': False, 'emailDomainMode': 'any', 'emailDomains': [],
            'automaticMemoryEnabled': False, 'compressionModelId': '', 'memorySummaryModelId': '',
            'compressionTriggerRounds': 200, 'compressionKeepRounds': 8, 'bubbleDelimiter': '', 'hiddenSymbols': [],
        })
        self.api(self.cleanup_admin, '/admin/embeddings', 'PATCH', {'enabled': False})

    def supplier_key(self):
        self.stage('supplier dialog select and credential replacement')
        page = self.admin_page
        page.goto(self.base + '/admin', wait_until='networkidle')
        page.get_by_role('button', name='供应商与模型', exact=True).click()
        page.get_by_role('button', name='添加供应商', exact=True).first.click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_label('供应商名称', exact=True).fill(self.name)
        protocol = dialog.get_by_role('combobox', name='API 协议', exact=True)
        protocol.click()
        expect(page.get_by_role('listbox')).to_be_visible()
        page.get_by_role('option', name='OpenAI Responses', exact=True).click()
        protocol.click()
        page.get_by_role('option', name='OpenAI Completions', exact=True).click()
        dialog.get_by_label('服务地址', exact=True).fill(self.model.base_url)
        dialog.get_by_label('API 密钥', exact=True).fill(self.model.initial_key)
        with page.expect_response(lambda response: response.url.endswith('/api/admin/suppliers') and response.request.method == 'POST') as created:
            dialog.get_by_role('button', name='添加供应商', exact=True).click()
        require(created.value.status == 201, 'Supplier UI creation failed.')
        supplier = created.value.json()['data']
        self.suppliers.append(supplier['id'])
        expect(dialog).not_to_be_visible()
        require(supplier['hasKey'] and 'apiKey' not in supplier, 'Supplier credentials were not saved privately.')
        model = self.api(self.cleanup_admin, '/admin/models', 'POST', {
            'name': self.name, 'supplierId': supplier['id'], 'kind': 'language', 'model': 'production-browser-fixture',
            'active': True, 'contextWindow': 32768, 'maxOutput': 512, 'temperature': None,
        }, expected=201)
        self.models.append(model['id'])
        self.api(self.cleanup_admin, '/admin/models/' + model['id'] + '/test', 'POST', {})
        require(any(call['phase'] == 'initial' and call['validAuth'] for call in self.model.calls), 'The initial nonempty API key was not used.')
        page.get_by_role('button', name='编辑供应商 ' + self.name, exact=True).click()
        dialog = page.get_by_role('dialog')
        self.model.expect_replacement()
        dialog.get_by_label('API 密钥', exact=True).fill(self.model.updated_key)
        with page.expect_response(lambda response: response.url.endswith('/api/admin/suppliers/' + supplier['id']) and response.request.method == 'PATCH') as updated:
            dialog.get_by_role('button', name='保存供应商', exact=True).click()
        require(updated.value.status == 200, 'Supplier API-key replacement failed in the UI.')
        expect(dialog).not_to_be_visible()
        self.api(self.cleanup_admin, '/admin/models/' + model['id'] + '/test', 'POST', {})
        require(any(call['phase'] == 'updated' and call['validAuth'] for call in self.model.calls), 'The updated nonempty API key was not used.')
        require(all(call['validAuth'] for call in self.model.calls), 'A model call used the wrong API key.')
        character = self.api(self.cleanup_admin, '/admin/characters', 'POST', {
            'name': self.name, 'slug': 'production-' + self.suffix, 'description': '本地生产浏览器回归测试角色',
            'personality': '只用于本地生产浏览器回归测试。', 'greeting': '', 'avatar': '', 'color': '#92b296',
            'tags': ['测试'], 'providerId': model['id'], 'active': True,
        }, expected=201)
        self.characters.append(character['id'])
        self.report['checks']['dialogSelectPortal'] = True
        self.report['checks']['nonemptyApiKeyCreatedAndReplacedThroughUI'] = True

    def user_chat(self):
        self.stage('temporary user registration and local model chat')
        self.user = self.browser.new_context(viewport={'width': 1440, 'height': 1000})
        self.user_page = self.watch(self.user.new_page())
        page = self.user_page
        page.goto(self.base, wait_until='networkidle')
        page.get_by_role('button', name='登录 / 注册', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_role('button', name='注册账户', exact=True).click()
        dialog.get_by_label('昵称', exact=True).fill(self.name)
        dialog.get_by_label('邮箱', exact=True).fill(self.user_email)
        dialog.get_by_label('密码', exact=True).fill(self.user_password)
        with page.expect_response(lambda response: response.url.endswith('/api/auth/register')) as registered:
            dialog.get_by_role('button', name='创建账户', exact=True).click()
        require(registered.value.status == 201, 'Temporary user registration failed.')
        self.user_id = registered.value.json()['data']['id']
        expect(dialog).not_to_be_visible(timeout=15000)
        require(self.api(self.user, '/bootstrap')['user']['id'] == self.user_id, 'Registration did not establish a real browser session.')
        self.api(self.cleanup_admin, '/admin/users/' + self.user_id, 'PATCH', {'limit5h': max(10, self.old_settings['defaultLimit5h']), 'limit7d': max(10, self.old_settings['defaultLimit7d'])})
        page.get_by_role('button', name=re.compile('新建对话')).first.click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_role('button', name=re.compile(re.escape(self.name))).click()
        dialog.get_by_role('button', name='开始对话', exact=True).click()
        page.wait_for_url('**/chat/**')
        conversation_id = page.url.rsplit('/', 1)[-1]
        self.conversations.append(conversation_id)
        baseline = self.api(self.user, '/quota')
        page.get_by_label('消息内容').fill('请验证本地模型回复。')
        page.get_by_role('button', name='发送', exact=True).click()
        expect(page.locator('.message-assistant')).to_have_count(1, timeout=45000)
        expect(page.get_by_role('button', name='发送', exact=True)).to_be_visible(timeout=45000)
        require(not page.locator('.chat-error').count(), 'Local model chat failed.')
        usage = self.api(self.user, '/quota')
        require(usage['fiveHour']['used'] == baseline['fiveHour']['used'] + 1 and usage['sevenDay']['used'] == baseline['sevenDay']['used'] + 1, 'Successful local chat did not charge exactly one call.')
        require(all(call['validAuth'] for call in self.model.calls), 'Conversation used an outdated API key.')
        self.report['checks']['temporaryUserRegistrationAndLocalChat'] = True

    def geometry(self):
        self.stage('five-width chat layout')
        metrics = []
        for width, height in [(1440, 1000), (1920, 1080), (2560, 1440), (390, 844), (360, 740)]:
            self.user_page.set_viewport_size({'width': width, 'height': height})
            self.user_page.goto(self.base + '/chat/' + self.conversations[0], wait_until='networkidle')
            expect(self.user_page.locator('.chat-composer')).to_be_visible()
            item = self.user_page.evaluate('''()=>{const t=document.querySelector('.topbar').getBoundingClientRect(),h=document.querySelector('.chat-header').getBoundingClientRect(),c=document.querySelector('.chat-composer').getBoundingClientRect();return {width:innerWidth,gap:h.top-t.bottom,composerTop:c.top,composerBottom:c.bottom,viewport:innerHeight,overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};}''')
            require(abs(item['gap']) < 1, f'Chat top gap is nonzero at width {width}.')
            require(item['composerTop'] >= 0 and item['composerBottom'] <= height + 1, f'Chat composer is outside the viewport at width {width}.')
            require(item['overflow'] <= 1, f'Chat has horizontal overflow at width {width}.')
            metrics.append(item)
        self.report['checks']['chatGeometry'] = metrics
        self.user_page.screenshot(path=str(self.artifacts / 'chat-mobile.png'))
        self.user_page.set_viewport_size({'width': 1920, 'height': 1080})

    def combo_frames(self):
        self.stage('context combobox animation frames')
        page = self.admin_page
        page.goto(self.base + '/admin', wait_until='networkidle')
        page.get_by_role('button', name='对话策略', exact=True).click()
        combo = page.get_by_role('combobox', name='上下文摘要模型', exact=True)
        combo.scroll_into_view_if_needed()
        page.wait_for_timeout(100)
        samples = []
        for _ in range(3):
            before = combo.evaluate('''el=>{const r=el.closest('.admin-settings-fields').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,scrollY};}''')
            combo.evaluate('''el=>{const panel=el.closest('.admin-settings-fields');window.__productionFrames=[];window.__productionCapture=true;function sample(){if(!window.__productionCapture)return;const r=panel.getBoundingClientRect();window.__productionFrames.push({x:r.x,y:r.y,width:r.width,scrollY});requestAnimationFrame(sample)}requestAnimationFrame(sample)}''')
            combo.click()
            expect(page.get_by_role('listbox')).to_be_visible()
            expect(page.get_by_role('option', name='原文截取（不调用模型）', exact=True)).to_be_visible()
            page.wait_for_timeout(220)
            page.keyboard.press('Escape')
            expect(page.get_by_role('listbox')).not_to_be_visible()
            page.wait_for_timeout(220)
            frames = page.evaluate('()=>{window.__productionCapture=false;return window.__productionFrames}')
            require(len(frames) >= 3, 'Combobox frame capture did not run.')
            movement = max(abs(frame[key] - before[key]) for frame in frames for key in ['x', 'y', 'width', 'scrollY'])
            require(movement < 1, 'Combobox opening/closing moved the page between animation frames.')
            samples.append({'frames': len(frames), 'maxMovementPx': movement})
        self.report['checks']['comboboxGeometry'] = samples
        page.screenshot(path=str(self.artifacts / 'context-combobox.png'), full_page=True)

    def global_quotas(self):
        self.stage('global quota UI synchronization')
        before_admin = self.api(self.admin, '/quota')
        before_user = self.api(self.user, '/quota')
        require(before_user['fiveHour']['used'] > 0, 'Quota preservation must test nonzero usage.')
        next5 = self.old_settings['defaultLimit5h'] + 3 if self.old_settings['defaultLimit5h'] <= 999997 else self.old_settings['defaultLimit5h'] - 3
        next7 = self.old_settings['defaultLimit7d'] + 7 if self.old_settings['defaultLimit7d'] <= 999993 else self.old_settings['defaultLimit7d'] - 7
        page = self.admin_page
        page.get_by_role('button', name='平台设置', exact=True).click()
        page.get_by_label('5 小时调用上限', exact=True).fill(str(next5))
        page.get_by_label('7 天调用上限', exact=True).fill(str(next7))
        with page.expect_response(lambda response: response.url.endswith('/api/admin/settings') and response.request.method == 'PATCH') as updated:
            page.get_by_role('button', name='保存平台设置', exact=True).click()
        self.global_changed = updated.value.ok
        require(updated.value.ok, 'Global quota UI save failed.')
        expect(page.get_by_role('button', name='保存平台设置', exact=True)).to_be_disabled()
        users = self.api(self.cleanup_admin, '/admin/users')
        require(all(user['limit5h'] == next5 and user['limit7d'] == next7 for user in users), 'Global quota UI did not synchronize every account.')
        after_admin = self.api(self.admin, '/quota')
        after_user = self.api(self.user, '/quota')
        for window in ['fiveHour', 'sevenDay']:
            require(before_admin[window]['used'] == after_admin[window]['used'] and before_user[window]['used'] == after_user[window]['used'], 'Global quota synchronization reset existing usage.')
        self.report['checks']['globalQuotaUISync'] = {'accounts': len(users), 'usagePreserved': True}

    def password_change(self):
        self.stage('temporary user password change through UI')
        page = self.user_page
        page.goto(self.base + '/settings', wait_until='networkidle')
        old_session = self.browser.new_context(storage_state=self.user.storage_state())
        old_password = self.user_password
        replacement = secrets.token_urlsafe(24)
        page.get_by_label('当前密码', exact=True).fill(old_password)
        page.get_by_label('新密码', exact=True).fill(replacement)
        page.get_by_label('确认新密码', exact=True).fill(replacement)
        with page.expect_response(lambda response: response.url.endswith('/api/account') and response.request.method == 'PATCH') as updated:
            page.get_by_role('button', name='更新密码', exact=True).click()
        require(updated.value.status == 200, 'Temporary user password change failed through the UI.')
        self.user_password = replacement
        expect(page.get_by_role('status').filter(has_text='密码已更新。')).to_be_visible()
        require(self.api(self.user, '/bootstrap')['user']['id'] == self.user_id, 'Password change did not retain the new browser session.')
        self.api(old_session, '/quota', expected=401)
        old_page = self.watch(old_session.new_page())
        old_page.goto(self.base, wait_until='networkidle')
        expect(old_page.get_by_role('button', name='登录 / 注册', exact=True)).to_be_visible()
        old_session.close()
        page.reload(wait_until='networkidle')
        page.get_by_role('button', name='退出当前账户', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_role('button', name='退出登录', exact=True).click()
        expect(dialog).not_to_be_visible()
        expect(page.get_by_role('button', name='登录 / 注册', exact=True)).to_be_visible()
        require(self.api(self.user, '/bootstrap')['user'] is None, 'Temporary user logout did not clear the session.')
        self.api(self.user, '/auth/login', 'POST', {'email': self.user_email, 'password': old_password}, expected=401)
        self.login(page, {'email': self.user_email, 'password': self.user_password})
        require(self.api(self.user, '/bootstrap')['user']['id'] == self.user_id, 'New password did not work through the real login UI.')
        self.report['checks']['passwordUIChangeReloginAndOldCookieRevocation'] = True

    def rejected_cookie(self):
        self.stage('rejected session cookie does not report success')
        rejected = self.browser.new_context()
        page = self.watch(rejected.new_page())

        def remove_cookie(route):
            response = route.fetch()
            headers = {name: value for name, value in response.headers.items() if name.lower() != 'set-cookie'}
            rejected.clear_cookies()
            route.fulfill(status=response.status, headers=headers, body=response.body())

        page.route('**/api/auth/login', remove_cookie)
        page.goto(self.base, wait_until='networkidle')
        page.get_by_role('button', name='登录 / 注册', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_label('邮箱', exact=True).fill(self.user_email)
        dialog.get_by_label('密码', exact=True).fill(self.user_password)
        dialog.get_by_role('button', name='登录', exact=True).click()
        expect(dialog.get_by_role('alert')).to_contain_text('登录会话未能保存')
        expect(dialog).to_be_visible()
        expect(page.get_by_role('status').filter(has_text='欢迎回来。')).not_to_be_visible()
        require(self.api(rejected, '/bootstrap')['user'] is None, 'Cookie rejection still produced an authenticated session.')
        rejected.close()
        self.report['checks']['rejectedCookieDoesNotReportLoginSuccess'] = True

    def cleanup(self):
        failures = []

        def attempt(label, operation):
            try:
                operation()
            except Exception:
                failures.append(label)

        if self.cleanup_admin:
            # Refresh the cleanup-only session in case another UI flow ended its own session.
            attempt('administrator cleanup session', lambda: self.api(self.cleanup_admin, '/auth/login', 'POST', self.credentials))
            if not self.user_id:
                def find_temporary_user():
                    self.user_id = next((user['id'] for user in self.api(self.cleanup_admin, '/admin/users') if user['email'] == self.user_email), None)
                attempt('temporary user lookup', find_temporary_user)
            if self.user_id:
                context = self.browser.new_context()
                try:
                    def clear_user_data():
                        self.api(context, '/auth/login', 'POST', {'email': self.user_email, 'password': self.user_password})
                        for memory in self.api(context, '/memories'):
                            self.api(context, '/memories/' + memory['id'], 'DELETE')
                        for conversation in self.api(context, '/conversations'):
                            self.api(context, '/conversations/' + conversation['id'], 'DELETE')
                        require(not self.api(context, '/memories') and not self.api(context, '/conversations'), 'Temporary user data was not fully cleared.')
                        self.api(context, '/auth/logout', 'POST', {})
                    attempt('temporary conversations and memories', clear_user_data)
                finally:
                    context.close()
            for resource in ['characters', 'models', 'suppliers']:
                def archive_resources(kind=resource):
                    for item in self.api(self.cleanup_admin, '/admin/' + kind):
                        if item['name'] == self.name:
                            self.api(self.cleanup_admin, '/admin/' + kind + '/' + item['id'], 'DELETE')
                    require(not any(item['name'] == self.name for item in self.api(self.cleanup_admin, '/admin/' + kind)), 'A temporary resource remains active.')
                attempt(resource + ' cleanup', archive_resources)
            if self.old_embedding is not None:
                attempt('embedding settings restoration', lambda: self.api(self.cleanup_admin, '/admin/embeddings', 'PATCH', {key: self.old_embedding[key] for key in ['enabled', 'modelId', 'topK', 'minSimilarity']}))
            if self.old_settings is not None:
                restore_keys = self.SETTING_KEYS + (['defaultLimit5h', 'defaultLimit7d'] if self.global_changed else [])
                attempt('platform settings restoration', lambda: self.api(self.cleanup_admin, '/admin/settings', 'PATCH', {key: self.old_settings[key] for key in restore_keys}))
                if self.global_changed and self.old_users is not None:
                    def restore_overrides():
                        for user in self.old_users:
                            self.api(self.cleanup_admin, '/admin/users/' + user['id'], 'PATCH', {'limit5h': user['limit5h'], 'limit7d': user['limit7d']})
                    attempt('existing individual quotas restoration', restore_overrides)
            if self.user_id:
                attempt('temporary user disable', lambda: self.api(self.cleanup_admin, '/admin/users/' + self.user_id, 'PATCH', {'disabled': True}))
            attempt('cleanup session logout', lambda: self.api(self.cleanup_admin, '/auth/logout', 'POST', {}))
        if self.admin and self.admin_logged_in:
            attempt('browser administrator logout', lambda: self.api(self.admin, '/auth/logout', 'POST', {}))
        self.report['cleanup'] = {
            'ok': not failures,
            'failures': failures,
            'temporaryUserDisabled': bool(self.user_id) and 'temporary user disable' not in failures,
            'historicalRecords': 'Disabled test account, soft-deleted resources, quota and audit history remain only in the isolated test database.',
        }
        if self.browser:
            self.browser.close()
        self.model.stop()

    def run(self):
        failure = None
        try:
            with sync_playwright() as playwright:
                try:
                    self.setup(playwright)
                    self.supplier_key()
                    self.user_chat()
                    self.geometry()
                    self.combo_frames()
                    self.global_quotas()
                    self.password_change()
                    self.rejected_cookie()
                    require(not self.page_errors, 'The browser reported a JavaScript page error.')
                    require(self.model.calls and all(item['validAuth'] for item in self.model.calls), 'Mock authentication verification failed.')
                    self.report['checks']['mockRequests'] = len(self.model.calls)
                    self.report['checks']['pageErrors'] = len(self.page_errors)
                    self.report['ok'] = True
                    self.stage('completed')
                except Exception as error:
                    # Playwright exceptions may embed filled form values; do not
                    # persist or print arbitrary exception text or traceback.
                    failure = error
                    network_code = re.search(r'net::ERR_[A-Z_]+', str(error))
                    self.report['failure'] = str(error) if isinstance(error, CheckFailure) else type(error).__name__ + (': ' + network_code.group(0) if network_code else '')
                finally:
                    self.cleanup()
        finally:
            if not self.report['cleanup'].get('ok', False):
                self.report['ok'] = False
            (self.artifacts / 'report.json').write_text(json.dumps(self.report, ensure_ascii=False, indent=2), encoding='utf-8')
            print(json.dumps(self.report, ensure_ascii=True))
        return 0 if self.report['ok'] and failure is None else 1


if __name__ == '__main__':
    try:
        sys.exit(Regression(arguments()).run())
    except CheckFailure as error:
        print(json.dumps({'ok': False, 'failure': str(error)}, ensure_ascii=True))
        sys.exit(1)
