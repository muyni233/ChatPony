"""Read-only UI checks for quota controls and registration domain hints.

The existing QA database is only read. Unsaved form edits and browser-local
response fixtures exercise state variants without changing site settings.
"""

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get('CHATPONY_QA_URL', 'http://127.0.0.1:3210').rstrip('/')
OUT = Path('test-results')
STATE = OUT / 'admin-state.json'
OUT.mkdir(exist_ok=True)
errors = []
writes = []


def guard(route):
    request = route.request
    if request.method not in ('GET', 'HEAD', 'OPTIONS'):
        writes.append(f'{request.method} {urlparse(request.url).path}')
        route.abort('blockedbyclient')
    else:
        route.continue_()


def context_for(browser, **options):
    context = browser.new_context(**options)
    context.route('**/api/**', guard)
    context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
    return context


def goto(page, path):
    page.goto(BASE + path, wait_until='networkidle')


def no_overflow(page):
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')


def log(message):
    print('PASS ' + message, flush=True)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    try:
        context = context_for(browser, storage_state=str(STATE), viewport={'width': 1440, 'height': 1000})
        settings_response = context.request.get(BASE + '/api/admin/settings')
        assert settings_response.ok, settings_response.text()
        settings = settings_response.json()['settings']
        quota_response = context.request.get(BASE + '/api/quota')
        assert quota_response.ok, quota_response.text()
        quota = quota_response.json()
        page = context.new_page()
        goto(page, '/admin?tab=settings')
        expect(page.locator('#site-quota-5h')).to_have_value(str(settings['quota5h']))
        expect(page.locator('#site-quota-1d')).to_have_value(str(settings['quota1d']))
        expect(page.locator('#site-quota-7d')).to_have_value(str(settings['quota7d']))
        expect(page.locator('[name="maxDailyTurns"]')).to_have_count(0)
        expect(page.locator('#site-audit-retention')).to_have_value(str(settings.get('auditRetentionDays', 90)))
        expect(page.locator('#site-email-domains')).to_have_value('\n'.join(settings['allowedEmailDomains']))
        for key in ('5h', '1d', '7d'):
            expect(page.locator(f'#site-quota-{key}-enabled')).to_be_checked(checked=settings[f'quota{key}Enabled'])
        for selector in ('#site-quota-5h', '#site-quota-1d', '#site-quota-7d'):
            field = page.locator(selector)
            for value in ('0', '1000000'):
                field.fill(value)
                assert field.evaluate('node => node.checkValidity()')
            for value in ('-1', '1.5', '1000001'):
                field.fill(value)
                assert not field.evaluate('node => node.checkValidity()')
            field.fill(str(settings['quota' + selector.rsplit('-', 1)[1]]))
        domains = page.locator('#site-email-domains')
        domains.fill('\n'.join(f'domain{index}.example' for index in range(65)))
        assert not domains.evaluate('node => node.checkValidity()')
        domains.fill('\n'.join(f'domain{index}.example' for index in range(64)))
        assert domains.evaluate('node => node.checkValidity()')
        domains.fill('')
        assert domains.evaluate('node => node.checkValidity()')
        domains.fill('\n'.join(settings['allowedEmailDomains']))
        retention = page.locator('#site-audit-retention')
        for value in ('7', '365'):
            retention.fill(value)
            assert retention.evaluate('node => node.checkValidity()')
        for value in ('6', '366', '7.5'):
            retention.fill(value)
            assert not retention.evaluate('node => node.checkValidity()')
        retention.fill(str(settings.get('auditRetentionDays', 90)))
        page.locator('.admin-site-section').filter(has=page.locator('#site-email-domains')).screenshot(path=str(OUT / 'email-domains-admin-desktop.png'))
        page.locator('.admin-quota-defaults').screenshot(path=str(OUT / 'quota-defaults-desktop.png'))
        no_overflow(page)
        log('Site quota inputs accept 0–1,000,000 whole numbers, replace the daily limit, and domain lists allow at most 64 entries.')

        goto(page, '/admin?tab=users')
        expect(page.get_by_role('columnheader', name='AI 配额', exact=True)).to_be_visible()
        page.locator('.admin-user-quota').first.click()
        dialog = page.get_by_role('dialog', name='调整用户配额')
        expect(dialog).to_be_visible()
        expect(dialog.locator('#user-quota-5h')).to_have_attribute('placeholder', f"继承站点：{settings['quota5h']}")
        expect(dialog.locator('#user-quota-7d')).to_have_attribute('placeholder', f"继承站点：{settings['quota7d']}")
        dialog.locator('#user-quota-5h').fill('0')
        dialog.locator('#user-quota-7d').fill('')
        expect(dialog.get_by_text('使用该用户的独立配额', exact=True)).to_have_count(1)
        expect(dialog.get_by_text('跟随站点默认配额', exact=True)).to_have_count(2)
        dialog.locator('#user-quota-1d-state').click()
        page.get_by_role('option', name='停用', exact=True).click()
        expect(dialog.locator('#user-quota-1d-state')).to_have_text('停用')
        expect(dialog.get_by_text(re.compile('不会重置已经使用的次数'))).to_be_visible()
        page.screenshot(path=str(OUT / 'quota-user-dialog-desktop.png'))
        page.keyboard.press('Escape')
        expect(dialog).not_to_be_visible()
        log('Per-user quota dialog shows inherited defaults, supports independent zero / empty values, and explains usage preservation.')

        page.get_by_role('button', name='重置使用量', exact=True).click()
        reset_dialog = page.get_by_role('dialog', name='重置对话用量', exact=True)
        reset_dialog.get_by_role('combobox', name='重置范围', exact=True).click()
        page.get_by_role('option', name='全部用户', exact=True).click()
        reset_dialog.get_by_role('combobox', name='重置时间窗口', exact=True).click()
        page.get_by_role('option', name='1 天', exact=True).click()
        reset_dialog.get_by_role('button', name='查看重置确认', exact=True).click()
        expect(reset_dialog.get_by_role('heading', name='确认重置所选使用量？', exact=True)).to_be_visible()
        expect(reset_dialog.get_by_text('全部用户（包括管理员与停用账户）', exact=True)).to_be_visible()
        expect(reset_dialog.get_by_role('button', name='确认重置使用量', exact=True)).to_be_enabled()
        page.screenshot(path=str(OUT / 'quota-reset-confirm-desktop.png'))
        page.keyboard.press('Escape')
        expect(reset_dialog).not_to_be_visible()
        log('Reset controls require a separate confirmation showing the selected population and window; no reset was submitted.')

        goto(page, '/settings')
        card = page.locator('.quota-card')
        expect(card.get_by_role('heading', name='AI 对话额度')).to_be_visible()
        expect(card.locator('.quota-window')).to_have_count(3)
        for index, key in enumerate(('fiveHour', 'oneDay', 'sevenDay')):
            window = card.locator('.quota-window').nth(index)
            if not quota[key]['enabled']:
                expect(window.locator('.quota-inactive')).to_have_text('不限制')
            elif quota[key]['limit'] == 0:
                expect(window.locator('.quota-paused')).to_have_text('已暂停')
            else:
                expect(window.locator('.quota-window-count strong')).to_have_text(f"{quota[key]['remaining']:,}")
        card.screenshot(path=str(OUT / 'quota-account-live.png'))
        log('Account card reads real quota remaining counts from the QA API.')

        now = datetime.now(timezone.utc)
        fixture = {
            'fiveHour': {'enabled': True, 'limit': 50, 'used': 35, 'reserved': 2, 'remaining': 13, 'resetsAt': (now + timedelta(hours=1)).isoformat()},
            'oneDay': {'enabled': False, 'limit': 100, 'used': 0, 'reserved': 0, 'remaining': None, 'resetsAt': None},
            'sevenDay': {'enabled': True, 'limit': 500, 'used': 129, 'reserved': 2, 'remaining': 369, 'resetsAt': (now + timedelta(days=2)).isoformat()},
        }
        fixture_status = 200

        def quota_fixture(route):
            assert route.request.method == 'GET'
            route.fulfill(status=fixture_status, content_type='application/json', body=json.dumps(fixture if fixture_status == 200 else {'error': '额度读取测试失败', 'code': 'TEST_FAILURE'}))

        context.route('**/api/quota', quota_fixture)
        card.get_by_role('button', name='刷新对话额度').click()
        expect(card.locator('.quota-window-count strong').first).to_have_text('13')
        expect(card.get_by_text('进行中 2 次', exact=True)).to_have_count(2)
        expect(card.get_by_role('meter').first).to_have_attribute('aria-valuenow', '37')
        expect(card.locator('time')).to_have_count(2)
        card.screenshot(path=str(OUT / 'quota-account-desktop.png'))
        fixture['fiveHour'] = {'enabled': True, 'limit': 0, 'used': 35, 'reserved': 0, 'remaining': 0, 'resetsAt': None}
        card.get_by_role('button', name='刷新对话额度').click()
        expect(card.locator('.quota-paused')).to_have_text('已暂停')
        expect(card.get_by_text('请联系管理员调整额度', exact=True)).to_be_visible()
        fixture_status = 503
        card.get_by_role('button', name='刷新对话额度').click()
        expect(card.get_by_role('alert')).to_contain_text('额度读取测试失败')
        fixture_status = 200
        fixture['fiveHour'] = {'enabled': True, 'limit': 50, 'used': 35, 'reserved': 2, 'remaining': 13, 'resetsAt': (now + timedelta(hours=1)).isoformat()}
        card.get_by_role('button', name='刷新对话额度').click()
        expect(card.get_by_role('alert')).to_have_count(0)
        log('Browser-local fixtures cover used / reserved / remaining, recovery times, paused quotas, and retry after API errors.')

        page.set_viewport_size({'width': 390, 'height': 844})
        no_overflow(page)
        card.screenshot(path=str(OUT / 'quota-account-mobile.png'))
        goto(page, '/admin?tab=users')
        page.locator('.admin-user-quota').first.click()
        dialog = page.get_by_role('dialog', name='调整用户配额')
        expect(dialog.locator('#user-quota-5h')).to_be_visible()
        no_overflow(page)
        page.screenshot(path=str(OUT / 'quota-user-dialog-mobile.png'))
        dialog.get_by_role('button', name='取消', exact=True).click()
        expect(dialog).not_to_be_visible()
        goto(page, '/admin?tab=settings')
        page.locator('.admin-quota-defaults').screenshot(path=str(OUT / 'quota-defaults-mobile.png'))
        page.locator('.admin-site-section').filter(has=page.locator('#site-email-domains')).screenshot(path=str(OUT / 'email-domains-admin-mobile.png'))
        no_overflow(page)
        log('Quota summary, administrator inputs, and edit dialog fit the 390 px mobile layout.')
        context.close()

        guest = context_for(browser, viewport={'width': 1440, 'height': 1000})
        session = guest.request.get(BASE + '/api/session').json()
        session['bootstrapRequired'] = False
        session['site']['registrationEnabled'] = True
        session['site']['allowedEmailDomains'] = ['example.test', 'mail.example.test']

        def session_fixture(route):
            assert route.request.method == 'GET'
            route.fulfill(content_type='application/json', body=json.dumps(session))

        guest.route('**/api/session', session_fixture)
        page = guest.new_page()
        goto(page, '/register')
        expect(page.locator('#registration-email-domains')).to_be_visible()
        expect(page.locator('.auth-domain-list > span')).to_have_count(2)
        expect(page.locator('#email')).to_have_attribute('aria-describedby', 'registration-email-domains')
        expect(page.locator('.auth-story-footer').get_by_role('link', name='预览', exact=True)).to_have_attribute('href', '/preview')
        page.screenshot(path=str(OUT / 'email-domains-register-desktop.png'), full_page=True)
        page.set_viewport_size({'width': 390, 'height': 844})
        no_overflow(page)
        expect(page.locator('.auth-mobile-preview')).to_be_visible()
        page.screenshot(path=str(OUT / 'email-domains-register-mobile.png'), full_page=True)
        goto(page, '/login')
        expect(page.locator('#registration-email-domains')).to_have_count(0)
        session['bootstrapRequired'] = True
        goto(page, '/register')
        expect(page.get_by_role('heading', name='欢迎创建 ChatPony', exact=True)).to_be_visible()
        expect(page.locator('#registration-email-domains')).to_have_count(0)
        log('Domain hints appear only in ordinary registration; login and first-administrator registration stay exempt, and preview links point to /preview.')
        guest.close()
        assert not writes, writes
        assert not errors, errors
        log('No API writes or JavaScript errors; all state fixtures stayed inside the browser.')
    finally:
        browser.close()
