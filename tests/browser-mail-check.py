"""Email verification browser regression; use only an isolated local test instance.

python tests/browser-mail-check.py --url http://localhost:3217
Uses the same test admin environment variables/credential fixture as browser-check.py.
Starts a local SMTP fixture. No message is delivered to an external mail server.
"""
import argparse
import email
import email.policy
import json
import os
import re
import socketserver
import threading
import uuid
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
base = parser.parse_args().url.rstrip('/')
if not re.fullmatch(r'http://(?:localhost|127\.0\.0\.1):\d+', base):
    raise RuntimeError('Use an isolated local test instance.')
credentials = ({'email': os.environ['CHATPONY_E2E_ADMIN_EMAIL'], 'password': os.environ['CHATPONY_E2E_ADMIN_PASSWORD']}
               if os.environ.get('CHATPONY_E2E_ADMIN_EMAIL') and os.environ.get('CHATPONY_E2E_ADMIN_PASSWORD')
               else json.loads(Path('test-results/admin-credentials.json').read_text(encoding='utf-8-sig')))
letters = []


class SMTP(socketserver.StreamRequestHandler):
    def reply(self, text):
        self.wfile.write((text + '\r\n').encode('ascii'))
        self.wfile.flush()

    def handle(self):
        self.reply('220 localhost ChatPony test SMTP')
        while True:
            line = self.rfile.readline()
            if not line:
                return
            command = line.decode('utf-8', errors='replace').strip().upper()
            if command.startswith(('EHLO', 'HELO')):
                self.reply('250-localhost\r\n250-8BITMIME\r\n250 SMTPUTF8')
            elif command.startswith(('MAIL FROM:', 'RCPT TO:', 'RSET', 'NOOP')):
                self.reply('250 OK')
            elif command == 'DATA':
                self.reply('354 End data with <CRLF>.<CRLF>')
                data = bytearray()
                while True:
                    part = self.rfile.readline()
                    if not part or part == b'.\r\n':
                        break
                    data.extend(part[1:] if part.startswith(b'..') else part)
                message = email.message_from_bytes(bytes(data), policy=email.policy.default)
                body = message.get_body(preferencelist=('plain',)) if message.is_multipart() else message
                letters.append({'to': str(message['To']), 'text': body.get_content()})
                self.reply('250 Queued locally')
            elif command == 'QUIT':
                self.reply('221 Bye')
                return
            else:
                self.reply('502 Not implemented')


server = socketserver.ThreadingTCPServer(('127.0.0.1', 0), SMTP)
server.daemon_threads = True
threading.Thread(target=server.serve_forever, daemon=True).start()
errors = []


def api(context, path, method='GET', body=None):
    response = context.request.fetch(base + '/api' + path, method=method, data=body,
                                     headers={'Content-Type': 'application/json'}, timeout=30000)
    result = response.json()
    assert response.ok, (path, response.status, result)
    return result['data']


with sync_playwright() as p:
    bundled = Path('C:/Users/Server/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe')
    executable = os.environ.get('CHATPONY_CHROMIUM') or (str(bundled) if bundled.exists() else None)
    browser = p.chromium.launch(headless=True, **({'executable_path': executable} if executable else {}))
    admin = browser.new_context()
    api(admin, '/auth/login', 'POST', credentials)
    old_mail = api(admin, '/admin/mail')
    old_settings = api(admin, '/admin/settings')
    assert not old_mail['hasPassword'], 'Do not replace an existing SMTP credential.'
    policy_keys = ['requireEmailVerification', 'emailDomainMode', 'emailDomains']
    user = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = user.new_page()
    page.on('pageerror', lambda error: errors.append(str(error)))
    try:
        api(admin, '/admin/mail', 'PATCH', {'host': '127.0.0.1', 'port': server.server_address[1],
            'secure': False, 'requireTLS': False, 'username': '', 'password': '',
            'fromEmail': 'chatpony@example.test', 'fromName': 'ChatPony test'})
        api(admin, '/admin/mail/test', 'POST', {})
        assert not letters, 'Connection test must not send mail.'
        api(admin, '/admin/settings', 'PATCH', {'requireEmailVerification': True,
            'emailDomainMode': 'allowlist', 'emailDomains': ['example.test']})
        page.goto(base, wait_until='networkidle')
        page.get_by_role('button', name='登录 / 注册', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_role('button', name='注册账户', exact=True).click()
        expect(dialog.get_by_label('邮箱验证码', exact=True)).to_be_visible()
        dialog.get_by_label('昵称', exact=True).fill('邮箱验证用户')
        dialog.get_by_label('密码', exact=True).fill('Mail-fixture-password-2026!')
        address = f'mail-{uuid.uuid4().hex[:8]}@example.test'
        dialog.get_by_label('邮箱', exact=True).fill(address.replace('example.test', 'blocked.test'))
        dialog.get_by_role('button', name='发送验证码', exact=True).click()
        expect(dialog.get_by_role('alert')).to_contain_text('域名')
        assert not letters
        dialog.get_by_label('邮箱', exact=True).fill(address)
        dialog.get_by_role('button', name='发送验证码', exact=True).click()
        expect(dialog.get_by_role('status')).to_contain_text('验证码已发送', timeout=15000)
        assert len(letters) == 1
        code = re.search(r'\b(\d{6})\b', letters[0]['text']).group(1)
        expect(dialog.get_by_role('button', name=re.compile('秒后重发'))).to_be_disabled()
        page.screenshot(path='test-results/email-verification-desktop.png')
        dialog.get_by_label('邮箱验证码', exact=True).fill('000000' if code != '000000' else '111111')
        dialog.get_by_role('button', name='创建账户', exact=True).click()
        expect(dialog.get_by_role('alert')).to_contain_text('验证码')
        dialog.get_by_label('邮箱验证码', exact=True).fill(code)
        dialog.get_by_role('button', name='创建账户', exact=True).click()
        expect(dialog).not_to_be_visible(timeout=15000)
        registered = api(user, '/bootstrap')['user']
        assert registered['email'] == address and registered['emailVerifiedAt']
        assert registered['role'] == 'user'
        page.goto(base + '/settings', wait_until='networkidle')
        expect(page.get_by_text('邮箱已验证', exact=True)).to_be_visible()
        before = page.locator('.settings-grid').bounding_box()
        page.get_by_role('combobox', name='时区', exact=True).click()
        expect(page.get_by_role('listbox')).to_be_visible()
        during = page.locator('.settings-grid').bounding_box()
        assert abs(before['x'] - during['x']) < 0.5 and abs(before['width'] - during['width']) < 0.5, (before, during)
        page.screenshot(path='test-results/custom-select-desktop.png')
        page.get_by_role('option', name='Asia/Tokyo', exact=True).click()
        page.get_by_role('button', name='保存资料', exact=True).click()
        expect(page.get_by_role('status').filter(has_text='个人资料已更新')).to_be_visible()
        assert api(user, '/bootstrap')['user']['timezone'] == 'Asia/Tokyo'
        api(admin, '/admin/settings', 'PATCH', {'emailDomainMode': 'blocklist', 'emailDomains': ['example.test']})
        assert api(user, '/bootstrap')['user']['id'] == registered['id'], 'Policy must not revoke existing accounts.'
        assert not errors, errors
        print(json.dumps({'ok': True, 'checks': ['SMTP connection without delivery', 'domain restriction',
            'real local SMTP delivery', 'cooldown UI', 'wrong code rejection', 'verified registration',
            'verified status persistence', 'custom select and form submission', 'stable dropdown layout',
            'existing account unaffected'], 'external_mail_sent': 0, 'page_errors': errors}))
    finally:
        api(admin, '/admin/settings', 'PATCH', {key: old_settings[key] for key in policy_keys})
        api(admin, '/admin/mail', 'PATCH', {**{key: value for key, value in old_mail.items() if key != 'hasPassword'}, 'password': ''})
        browser.close()
        server.shutdown()
        server.server_close()
