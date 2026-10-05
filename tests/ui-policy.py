"""Mutating policy checks: run alone, on the isolated development QA database.

No real model service may be enabled. All-user resets intentionally advance QA
usage epochs; account cleanup and all modified site settings are restored even
when a check fails. Historical audit rows are retained by the application.
"""
import json
import re
import secrets
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlencode

from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:3210'
OUT = Path('test-results')
WINDOWS = (
    ('5h', 'fiveHour', 'quota5h', 'quota5hEnabled', '5 小时'),
    ('1d', 'oneDay', 'quota1d', 'quota1dEnabled', '1 天'),
    ('7d', 'sevenDay', 'quota7d', 'quota7dEnabled', '7 天'),
)
POLICY_KEYS = [key for _, _, limit, enabled, _ in WINDOWS for key in (limit, enabled)]
RESTORE_KEYS = POLICY_KEYS + [
    'allowedEmailDomains', 'requireEmailVerification', 'localDemoMode', 'registrationEnabled',
]

with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    admin = browser.new_context(storage_state=str(OUT / 'admin-state.json'), viewport={'width': 1440, 'height': 1000})
    user = browser.new_context(viewport={'width': 1440, 'height': 1000})
    other = browser.new_context()
    management, page = admin.new_page(), user.new_page()
    errors, accounts = [], []
    original, settings_changed = None, False
    username = 'QuotaQA' + secrets.token_hex(4)
    other_name = 'QuotaQB' + secrets.token_hex(4)
    password = 'Quota!' + secrets.token_urlsafe(20)
    for surface in (management, page):
        surface.on('pageerror', lambda error: errors.append(str(error)))

    def read(context, path):
        response = context.request.get(BASE + path)
        assert response.ok, (path, response.status, response.text())
        return response.json()

    def mutate(context, path, payload=None, method='POST'):
        response = context.request.fetch(BASE + path, method=method, data=payload, headers={'Origin': BASE, 'Content-Type': 'application/json'})
        assert response.ok, (path, response.status, response.text())
        return response.json()

    def quota(context=user):
        return read(context, '/api/quota')

    def audit(name):
        result = read(admin, '/api/admin/audit?' + urlencode({'query': name, 'days': 7, 'pageSize': 100}))
        assert result['entries']['total'] == len(result['entries']['items'])
        assert result['stats']['pending'] == 0
        return result

    def set_windows(enabled, limits=None):
        limits = limits or {}
        payload = {}
        for short, _, limit_key, enabled_key, _ in WINDOWS:
            payload[limit_key] = limits.get(short, 0)
            payload[enabled_key] = short in enabled
        mutate(admin, '/api/admin/settings', payload, 'PATCH')

    def assert_windows(state, enabled):
        for short, key, _, _, _ in WINDOWS:
            assert state[key]['enabled'] is (short in enabled), (key, state)
            assert state[key]['reserved'] == 0, state
            if short not in enabled:
                assert state[key]['remaining'] is None and state[key]['resetsAt'] is None, state

    def assert_one_turn(before, after):
        for _, key, _, _, _ in WINDOWS:
            assert after[key]['used'] == before[key]['used'] + 1, (key, before, after)
            assert after[key]['reserved'] == 0, after

    def send_success(context, conversation_id, content):
        response = context.request.post(BASE + '/api/conversations/' + conversation_id + '/messages', data={
            'content': content, 'requestId': 'policy-' + secrets.token_hex(12),
        }, headers={'Origin': BASE})
        assert response.ok, (response.status, response.text())
        assert 'text/event-stream' in response.headers.get('content-type', '')
        events = []
        for frame in response.text().replace('\r\n', '\n').split('\n\n'):
            data = '\n'.join(line[5:].lstrip(' ') for line in frame.split('\n') if line.startswith('data:'))
            if data:
                events.append(json.loads(data))
        assert events and events[-1]['type'] == 'done', events
        assert any(event['type'] == 'message' for event in events), events
        assert not any(event['type'] == 'error' for event in events), events

    def send_blocked(context, conversation_id, content='额度耗尽后的请求', label=None):
        before = quota(context)
        response = context.request.post(BASE + '/api/conversations/' + conversation_id + '/messages', data={
            'content': content, 'requestId': 'policy-block-' + secrets.token_hex(12),
        }, headers={'Origin': BASE})
        assert response.status == 429 and response.json()['error']['code'] == 'QUOTA_EXCEEDED', (response.status, response.text())
        if label:
            assert label in response.json()['error']['message'], response.json()
        assert quota(context) == before, 'Rejected requests must not change usage or reservations'

    def select_option(trigger, label):
        trigger.click()
        management.get_by_role('option', name=label, exact=isinstance(label, str)).click()

    def open_user_quota():
        management.get_by_role('button', name=username + ' 的 AI 配额', exact=True).click()
        dialog = management.get_by_role('dialog', name='调整用户配额')
        expect(dialog.locator('#user-quota-5h')).to_be_visible()
        return dialog

    def save_user_quota(dialog):
        dialog.get_by_role('button', name='保存配额', exact=True).click()
        expect(dialog).not_to_be_visible()

    def prepare_reset(scope, window, target=None):
        management.get_by_role('button', name='重置使用量', exact=True).click()
        dialog = management.get_by_role('dialog', name='重置对话用量')
        select_option(dialog.get_by_role('combobox', name='重置范围', exact=True), scope)
        if target:
            select_option(dialog.get_by_role('combobox', name='选择重置用户', exact=True), re.compile('^' + re.escape(target)))
        select_option(dialog.get_by_role('combobox', name='重置时间窗口', exact=True), window)
        dialog.get_by_role('button', name='查看重置确认', exact=True).click()
        expect(dialog.get_by_role('button', name='确认重置使用量', exact=True)).to_be_visible()
        return dialog

    def confirm_reset(dialog):
        with management.expect_response(lambda response: response.url == BASE + '/api/admin/quotas/reset' and response.request.method == 'POST') as pending:
            dialog.get_by_role('button', name='确认重置使用量', exact=True).click()
        response = pending.value
        assert response.ok, (response.status, response.text())
        result = response.json()
        assert datetime.fromisoformat(result['resetAt'].replace('Z', '+00:00')).tzinfo is not None
        expect(dialog).not_to_be_visible()
        return result

    try:
        original = read(admin, '/api/admin/settings')['settings']
        assert original['developmentMode'], 'This mutating test requires the isolated development QA server'
        assert not read(admin, '/api/providers')['providers'], 'Disable real model services before policy QA'
        assert all(key in original for key in RESTORE_KEYS), 'Server must expose all three optional quota windows'
        management.goto(BASE + '/admin?tab=settings', wait_until='networkidle')
        for short, value, enabled in (('5h', 2, True), ('1d', 4, False), ('7d', 3, True)):
            management.locator('#site-quota-' + short).fill(str(value))
            management.locator('#site-quota-' + short + '-enabled').set_checked(enabled)
        management.locator('#site-email-domains').fill('ALLOWED.EXAMPLE')
        management.locator('input[name=registrationEnabled]').check()
        management.locator('input[name=requireEmailVerification]').uncheck()
        management.locator('input[name=localDemoMode]').check()
        settings_changed = True
        management.get_by_role('button', name='保存站点设置').click()
        expect(management.get_by_role('status')).to_contain_text('站点设置已保存')
        management.reload(wait_until='networkidle')
        for short, value, enabled in (('5h', 2, True), ('1d', 4, False), ('7d', 3, True)):
            expect(management.locator('#site-quota-' + short)).to_have_value(str(value))
            expect(management.locator('#site-quota-' + short + '-enabled')).to_be_checked(checked=enabled)
        expect(management.locator('#site-email-domains')).to_have_value('allowed.example')
        management.locator('.admin-quota-defaults').screenshot(path=str(OUT / 'quota-default-settings.png'))

        page.goto(BASE + '/register', wait_until='networkidle')
        expect(page.locator('#registration-email-domains')).to_contain_text('allowed.example')
        page.locator('#username').fill(username)
        page.locator('#email').fill(username.lower() + '@outside.example')
        page.locator('#password').fill(password)
        page.locator('#confirmPassword').fill(password)
        page.get_by_role('button', name='创建账户', exact=True).click()
        expect(page.locator('.error-message[role=alert]')).to_contain_text('域名')
        page.screenshot(path=str(OUT / 'registration-domain-feedback.png'), full_page=True)
        page.locator('#email').fill(username.lower() + '@ALLOWED.EXAMPLE')
        with page.expect_response(lambda response: response.url == BASE + '/api/auth/register' and response.request.method == 'POST') as pending:
            page.get_by_role('button', name='创建账户', exact=True).click()
        registration = pending.value
        assert registration.ok, (registration.status, registration.text())
        member = registration.json()['user']
        assert member and member['role'] == 'user'
        accounts.append((user, password))
        page.wait_for_url(BASE + '/')
        state = quota()
        assert_windows(state, {'5h', '7d'})
        assert state['fiveHour']['remaining'] == 2 and state['sevenDay']['remaining'] == 3
        print('PASS three window settings save/reload; public email-domain hint; denied domain; allowed registration', flush=True)

        roles = read(user, '/api/characters')['characters']
        assert len(roles) >= 2
        direct = mutate(user, '/api/conversations', {'kind': 'direct', 'characterIds': [roles[0]['id']]})['conversation']
        page.goto(BASE + '/chat/' + direct['id'], wait_until='networkidle')
        assert all(quota()[key]['used'] == 0 for _, key, _, _, _ in WINDOWS), 'A configured greeting must not charge quota'
        baseline = page.locator('.theirs').count()
        for index in range(2):
            page.get_by_role('textbox', name='输入消息').fill(f'第 {index + 1} 次配额验证')
            page.get_by_role('button', name='发送消息', exact=True).click()
            expect(page.locator('.theirs')).to_have_count(baseline + index + 1)
            expect(page.get_by_role('button', name='停止生成')).not_to_be_visible()
        expect(page.locator('.quota-inline-notice')).to_be_visible()
        page.get_by_role('textbox', name='输入消息').fill('额度不足时保留草稿')
        expect(page.get_by_role('button', name='发送消息', exact=True)).to_be_disabled()
        expect(page.get_by_role('textbox', name='输入消息')).to_have_value('额度不足时保留草稿')
        state = quota()
        assert state['fiveHour']['used'] == 2 and state['fiveHour']['remaining'] == 0
        assert state['oneDay']['used'] == 2 and state['oneDay']['remaining'] is None
        assert state['sevenDay']['used'] == 2 and state['sevenDay']['remaining'] == 1
        assert state['fiveHour']['resetsAt'] and state['fiveHour']['reserved'] == 0
        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_function("document.querySelector('.sidebar').getBoundingClientRect().right <= 0")
        page.screenshot(path=str(OUT / 'quota-exhausted-mobile.png'), full_page=True)
        assert page.evaluate('document.documentElement.scrollHeight <= innerHeight + 1 && document.documentElement.scrollWidth <= innerWidth')

        group = mutate(user, '/api/conversations', {'kind': 'group', 'characterIds': [role['id'] for role in roles[:2]], 'title': '配额群聊验证'})['conversation']
        page.goto(BASE + '/chat/' + group['id'], wait_until='networkidle')
        page.get_by_role('textbox', name='输入消息').fill('额度用完后仍能发送普通群消息。')
        page.get_by_role('button', name='发送消息', exact=True).click()
        expect(page.locator('.mine')).to_have_count(1)
        expect(page.get_by_role('button', name='停止生成')).not_to_be_visible()
        assert quota() == state, 'Plain group messages must not change any quota window'
        send_blocked(user, group['id'], '@' + roles[0]['name'] + ' 你好')
        print('PASS successful-turn billing; no greeting charge; exhausted mobile UI; plain group messages; server enforcement', flush=True)

        management.goto(BASE + '/admin?tab=users', wait_until='networkidle')
        dialog = open_user_quota()
        for short, _, _, _, _ in WINDOWS:
            expect(dialog.locator('#user-quota-' + short)).to_have_value('')
            expect(dialog.locator('#user-quota-' + short + '-state')).to_have_text('继承站点')
            dialog.locator('#user-quota-' + short).fill('0')
        management.screenshot(path=str(OUT / 'user-quota-dialog.png'), full_page=True)
        save_user_quota(dialog)
        state = quota()
        assert state['fiveHour']['limit'] == 0 and state['fiveHour']['used'] == 2
        assert state['oneDay']['limit'] == 0 and state['oneDay']['remaining'] is None
        page.goto(BASE + '/settings', wait_until='networkidle')
        expect(page.locator('.quota-card')).to_contain_text('已暂停')
        expect(page.locator('.quota-inactive')).to_have_count(1)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        dialog = open_user_quota()
        for short, _, _, _, _ in WINDOWS:
            dialog.locator('#user-quota-' + short).fill('')
        save_user_quota(dialog)
        mutate(admin, '/api/admin/settings', {'quota5h': 4, 'quota7d': 5}, 'PATCH')
        page.get_by_role('button', name='刷新对话额度').click()
        expect(page.get_by_role('meter', name='5 小时 AI 额度')).to_have_attribute('aria-valuemax', '4')
        page.locator('.quota-card').screenshot(path=str(OUT / 'account-quotas-mobile.png'))
        state = quota()
        assert state['fiveHour']['used'] == 2 and state['fiveHour']['remaining'] == 2
        assert state['sevenDay']['used'] == 2 and state['sevenDay']['remaining'] == 3
        page.goto(BASE + '/chat/' + group['id'], wait_until='networkidle')
        page.get_by_role('textbox', name='输入消息').fill(' '.join('@' + role['name'] for role in roles[:2]) + ' 大家好')
        page.get_by_role('button', name='发送消息', exact=True).click()
        expect(page.locator('.theirs')).to_have_count(2)
        expect(page.get_by_role('button', name='停止生成')).not_to_be_visible()
        assert all(quota()[key]['used'] == 3 for _, key, _, _, _ in WINDOWS)
        print('PASS per-user pause; inherited limits; retained usage; account meters; multi-character group costs one turn', flush=True)

        # Test each independent window through the real message endpoint. The
        # two disabled zero-limit windows must never block a successful turn.
        for short, key, _, _, label in WINDOWS:
            set_windows({short}, {short: quota()[key]['used'] + 1})
            before = quota()
            assert_windows(before, {short})
            assert before[key]['remaining'] == 1
            send_success(user, direct['id'], f'只启用 {label} 窗口的回复')
            after = quota()
            assert_one_turn(before, after)
            assert_windows(after, {short})
            assert after[key]['remaining'] == 0 and after[key]['resetsAt']
            send_blocked(user, direct['id'], label=label)
        print('PASS only 5H / only 1D / only 7D; disabled zero limits do not block; selected window enforces exhaustion', flush=True)

        set_windows(set())
        before, audit_before = quota(), audit(username)
        assert_windows(before, set())
        send_success(user, direct['id'], '所有窗口停用时仍可聊天')
        after, audit_after = quota(), audit(username)
        assert_one_turn(before, after)
        assert_windows(after, set())
        prior_ids = {entry['id'] for entry in audit_before['entries']['items']}
        new_entries = [entry for entry in audit_after['entries']['items'] if entry['id'] not in prior_ids]
        assert len(new_entries) == 1 and new_entries[0]['status'] == 'success' and new_entries[0]['quotaCharged'] == 0
        assert audit_after['stats']['success'] == audit_before['stats']['success'] + 1
        assert audit_after['stats']['chargedTurns'] == audit_before['stats']['chargedTurns']
        page.goto(BASE + '/settings', wait_until='networkidle')
        expect(page.locator('.quota-inactive')).to_have_count(3)
        expect(page.locator('.quota-card')).not_to_contain_text('已暂停')
        page.locator('.quota-card').screenshot(path=str(OUT / 'quota-all-disabled-mobile.png'))
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')

        # Exercise true / false / null overrides via the actual custom selects.
        management.reload(wait_until='networkidle')
        dialog = open_user_quota()
        select_option(dialog.locator('#user-quota-1d-state'), '启用')
        dialog.locator('#user-quota-1d').fill('0')
        save_user_quota(dialog)
        state = quota()
        assert_windows(state, {'1d'})
        assert state['oneDay']['limit'] == 0 and state['oneDay']['used'] == after['oneDay']['used']
        send_blocked(user, direct['id'])
        set_windows({'5h', '1d', '7d'})
        dialog = open_user_quota()
        for short, _, _, _, _ in WINDOWS:
            select_option(dialog.locator('#user-quota-' + short + '-state'), '停用')
        save_user_quota(dialog)
        before = quota()
        assert_windows(before, set())
        send_success(user, direct['id'], '个人停用覆盖全站启用')
        assert_one_turn(before, quota())
        dialog = open_user_quota()
        select_option(dialog.locator('#user-quota-1d-state'), '继承站点')
        save_user_quota(dialog)
        assert_windows(quota(), {'1d'})
        saved_member = next(item for item in read(admin, '/api/admin/users')['users'] if item['id'] == member['id'])
        assert saved_member['quota1dEnabled'] is None and saved_member['quota5hEnabled'] is False and saved_member['quota7dEnabled'] is False
        send_blocked(user, direct['id'])
        dialog = open_user_quota()
        for short, _, _, _, _ in WINDOWS:
            select_option(dialog.locator('#user-quota-' + short + '-state'), '继承站点')
            dialog.locator('#user-quota-' + short).fill('')
        save_user_quota(dialog)
        print('PASS all-off successful usage with zero audit charge; personal enable/disable/inherit overrides; unrestricted mobile card', flush=True)

        set_windows({'5h', '1d', '7d'}, {'5h': 20, '1d': 20, '7d': 20})
        other_member = mutate(other, '/api/auth/register', {'username': other_name, 'email': other_name.lower() + '@allowed.example', 'password': password})['user']
        accounts.append((other, password))
        assert other_member['role'] == 'user'
        other_direct = mutate(other, '/api/conversations', {'kind': 'direct', 'characterIds': [roles[0]['id']]})['conversation']
        send_success(other, other_direct['id'], '为重置隔离验证保留一次用量')
        before_a, before_b = quota(), quota(other)
        audits_before = (audit(username), audit(other_name))
        settings_before = read(admin, '/api/admin/settings')['settings']
        users_before = read(admin, '/api/admin/users')['users']
        stats_before = read(admin, '/api/admin/stats')
        assert all(before_a[key]['used'] > 0 and before_b[key]['used'] == 1 for _, key, _, _, _ in WINDOWS)

        management.reload(wait_until='networkidle')
        dialog = prepare_reset('指定用户', '5 小时', username)
        assert quota() == before_a and quota(other) == before_b, 'Viewing confirmation must not reset usage'
        dialog.screenshot(path=str(OUT / 'quota-reset-confirmation.png'))
        reset = confirm_reset(dialog)
        assert reset['resetUsers'] == 1 and reset['windows'] == ['5h'], reset
        after_a, after_b = quota(), quota(other)
        assert after_a['fiveHour']['used'] == 0 and after_a['fiveHour']['remaining'] == 20
        assert after_a['fiveHour']['enabled'] and after_a['fiveHour']['limit'] == 20 and after_a['fiveHour']['reserved'] == 0
        assert after_a['oneDay'] == before_a['oneDay'] and after_a['sevenDay'] == before_a['sevenDay']
        assert after_b == before_b
        assert (audit(username), audit(other_name)) == audits_before, 'Single-window reset must preserve audit rows and statistics'

        dialog = prepare_reset('全部用户', '1 天')
        assert quota() == after_a and quota(other) == after_b
        dialog.screenshot(path=str(OUT / 'quota-reset-all-confirmation.png'))
        reset = confirm_reset(dialog)
        assert reset['resetUsers'] == stats_before['users'] and reset['windows'] == ['1d'], reset
        all_a, all_b = quota(), quota(other)
        assert all_a['oneDay']['used'] == 0 and all_b['oneDay']['used'] == 0
        for key in ('fiveHour', 'sevenDay'):
            assert all_a[key] == after_a[key] and all_b[key] == after_b[key], (key, all_a, all_b)
        assert (audit(username), audit(other_name)) == audits_before, 'All-user reset must preserve audit rows and statistics'
        reset = mutate(admin, '/api/admin/quotas/reset', {'scope': 'user', 'userId': other_member['id'], 'window': 'all'})
        assert reset['resetUsers'] == 1 and reset['windows'] == ['5h', '1d', '7d']
        cleared_other = quota(other)
        assert all(cleared_other[key]['used'] == 0 and cleared_other[key]['remaining'] == 20 for _, key, _, _, _ in WINDOWS)
        assert quota() == all_a
        assert (audit(username), audit(other_name)) == audits_before
        settings_after = read(admin, '/api/admin/settings')['settings']
        assert all(settings_after[key] == settings_before[key] for key in POLICY_KEYS)
        assert read(admin, '/api/admin/users')['users'] == users_before, 'Resets must preserve every user limit and enable override'
        assert read(admin, '/api/admin/stats') == stats_before, 'Resets must not change account, conversation or message counts'
        send_success(user, direct['id'], '重置后新回复分别计入当前窗口')
        assert_one_turn(all_a, quota())
        assert not errors, errors
        print('PASS targeted and all-user reset confirmations; independent counters; retained audit/statistics/policies; new usage after reset; no JS errors', flush=True)
    finally:
        active_error = sys.exc_info()[1]
        cleanup_errors = []
        for context, account_password in reversed(accounts):
            try:
                mutate(context, '/api/profile', {'password': account_password}, 'DELETE')
            except Exception as error:
                cleanup_errors.append('Temporary account cleanup failed: ' + str(error))
        if settings_changed and original:
            try:
                mutate(admin, '/api/admin/settings', {key: original[key] for key in RESTORE_KEYS}, 'PATCH')
                restored = read(admin, '/api/admin/settings')['settings']
                assert all(restored[key] == original[key] for key in RESTORE_KEYS), 'Original settings were not fully restored'
            except Exception as error:
                cleanup_errors.append('Site settings restoration failed: ' + str(error))
        for context in (other, user, admin):
            context.close()
        browser.close()
        if cleanup_errors:
            print('\n'.join(cleanup_errors), file=sys.stderr, flush=True)
            if active_error is None:
                raise AssertionError('Policy QA cleanup failed')
        elif settings_changed:
            print('PASS temporary accounts deleted; all original quota limits, switches and registration settings restored', flush=True)
