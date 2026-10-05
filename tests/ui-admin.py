"""Account/admin browser checks against a dedicated, empty QA database.

Run with the dev server on CHATPONY_QA_URL (default http://127.0.0.1:3210).
Credentials and screenshots stay in gitignored test-results/.
"""

import json
import os
from pathlib import Path
import re
import secrets
import sys

from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get('CHATPONY_QA_URL', 'http://127.0.0.1:3210')
OUT = Path('test-results')
OUT.mkdir(exist_ok=True)
CREDENTIALS = OUT / 'admin-credentials.json'
PHASE = sys.argv[1] if len(sys.argv) > 1 else 'bootstrap'


def settle(page):
    page.wait_for_load_state('networkidle')


def log(message):
    print(message, flush=True)


def choose_option(page, trigger, label):
    trigger.click()
    page.get_by_role('option', name=label, exact=True).click()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))

    if PHASE == 'bootstrap':
        page.goto(BASE + '/register')
        settle(page)
        expect(page.get_by_role('heading', name='欢迎创建 ChatPony')).to_be_visible()
        session = context.request.get(BASE + '/api/session').json()
        assert session.get('bootstrapRequired') is True, 'Use an empty dedicated QA database.'
        credentials = {'email': 'qa-admin@example.test', 'password': 'QaPony!' + secrets.token_urlsafe(18), 'username': 'QA管理员', 'url': BASE}
        page.get_by_label('你的昵称').fill(credentials['username'])
        page.get_by_label('邮箱地址').fill(credentials['email'])
        page.locator('#password').fill(credentials['password'])
        page.locator('#confirmPassword').fill('different-password')
        page.get_by_role('button', name='创建管理员账户', exact=True).click()
        expect(page.locator('.error-message[role="alert"]')).to_contain_text('两次输入的密码不一致')
        page.locator('#confirmPassword').fill(credentials['password'])
        CREDENTIALS.write_text(json.dumps(credentials, ensure_ascii=False), encoding='utf-8')
        with page.expect_response('**/api/auth/register') as response:
            page.get_by_role('button', name='创建管理员账户', exact=True).click()
        log('Registration response: ' + str(response.value.status) + ' ' + response.value.text())
        assert response.value.ok, response.value.text()
        page.wait_for_url('**/admin?tab=settings')
        expect(page.get_by_role('heading', name='站点设置', exact=True)).to_be_visible()
        session = context.request.get(BASE + '/api/session').json()
        assert session['user']['role'] == 'admin'
        assert session['bootstrapRequired'] is False
        CREDENTIALS.write_text(json.dumps(credentials, ensure_ascii=False), encoding='utf-8')
        context.storage_state(path=str(OUT / 'admin-state.json'))
        page.screenshot(path=str(OUT / 'admin-first-settings.png'), full_page=True)
        log('PASS first registration becomes admin, mismatch validation, direct settings redirect. Credentials in test-results/admin-credentials.json')

    else:
        credentials = json.loads(CREDENTIALS.read_text(encoding='utf-8'))
        page.goto(BASE + '/login')
        settle(page)
        page.get_by_label('邮箱地址').fill(credentials['email'])
        page.locator('#password').fill(credentials['password'])
        page.get_by_role('button', name='登录 ChatPony').click()
        page.wait_for_url(BASE + '/')
        page.goto(BASE + '/admin?tab=settings')
        expect(page.get_by_role('heading', name='站点设置', exact=True)).to_be_visible()
        page.locator('#site-url').fill(BASE + '/')
        page.locator('input[name="requireEmailVerification"]').uncheck()
        page.locator('input[name="localDemoMode"]').check()
        page.locator('input[name="allowPrivateApiUrls"]').check()
        page.get_by_role('button', name='保存站点设置').click()
        expect(page.get_by_role('status')).to_contain_text('站点设置已保存')
        stored = context.request.get(BASE + '/api/admin/settings').json()['settings']
        assert stored['localDemoMode'] is True and stored['requireEmailVerification'] is False
        assert stored['maxGroupReplies'] == 6 and stored['maxGroupDepth'] == 3
        log('PASS login and site settings persistence including group limits')

        page.get_by_role('button', name='角色管理', exact=False).click()
        if not context.request.get(BASE + '/api/admin/characters').json()['characters']:
            expect(page.get_by_role('heading', name='为第一位角色，写下设定')).to_be_visible()
        for name in ['联调角色甲', '联调角色乙']:
            if page.get_by_role('heading', name=name, exact=True).count():
                continue
            page.get_by_role('button', name='创建角色', exact=True).click()
            dialog = page.get_by_role('dialog')
            expect(dialog).to_be_visible()
            dialog.locator('#character-name').fill(name)
            dialog.locator('#character-description').fill('隔离测试数据库中的临时角色，用于验证平台功能。')
            dialog.locator('#character-personality').fill('你是用于功能测试的虚构角色，语气温和，只回复当前用户。')
            dialog.locator('#character-subtitle').fill('仅用于本地联调')
            dialog.locator('#character-tags').fill('测试，临时')
            dialog.locator('#character-greeting').fill('你好，很高兴一起测试这个对话空间。')
            dialog.locator('input[name="published"]').check()
            dialog.get_by_role('button', name='保存角色').click()
            expect(dialog).not_to_be_visible()
            expect(page.get_by_role('heading', name=name, exact=True)).to_be_visible()
        page.screenshot(path=str(OUT / 'admin-characters.png'), full_page=True)
        log('PASS creating and publishing administrator-configured characters')

        page.get_by_role('button', name='模型接口', exact=False).click()
        for protocol in ['openai-chat', 'openai-responses', 'anthropic', 'gemini']:
            if page.get_by_role('heading', name=re.compile('^QA ' + re.escape(protocol) + r'(?: edited)?$')).count():
                continue
            page.get_by_role('button', name='添加接口', exact=True).click()
            dialog = page.get_by_role('dialog')
            dialog.locator('#provider-name').fill('QA ' + protocol)
            protocol_names = {'openai-chat': 'OpenAI Completions', 'openai-responses': 'OpenAI Responses', 'anthropic': 'Anthropic Messages', 'gemini': 'Gemini Native'}
            choose_option(page, dialog.locator('#provider-protocol'), protocol_names[protocol])
            dialog.locator('#provider-url').fill('http://127.0.0.1:9/v1')
            dialog.locator('#provider-key').fill('local-test-placeholder')
            dialog.locator('#provider-model').fill('qa-model')
            dialog.get_by_role('button', name='保存接口').click()
            expect(dialog).not_to_be_visible()
            expect(page.get_by_role('heading', name='QA ' + protocol, exact=True)).to_be_visible()
        providers = context.request.get(BASE + '/api/admin/providers').json()['providers']
        assert {provider['protocol'] for provider in providers if provider['name'].startswith('QA ')} == {'openai-chat', 'openai-responses', 'anthropic', 'gemini'}
        first = page.locator('.admin-provider-row').filter(has=page.get_by_role('heading', name=re.compile(r'^QA openai-chat(?: edited)?$')))
        if first.get_by_role('button', name='启用', exact=True).count():
            first.get_by_role('button', name='启用', exact=True).click()
            expect(first.get_by_role('button', name='停用', exact=True)).to_be_visible()
        first.get_by_role('button', name='测试连接').click()
        expect(page.locator('.admin-notice.is-error')).to_be_visible(timeout=45000)
        page.screenshot(path=str(OUT / 'admin-providers-error.png'), full_page=True)
        first.get_by_role('button', name=re.compile(r'^编辑 QA openai-chat')).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.locator('#provider-key')).to_have_value('')
        dialog.locator('#provider-name').fill('QA openai-chat edited')
        dialog.get_by_role('button', name='保存接口').click()
        expect(dialog).not_to_be_visible()
        saved = context.request.get(BASE + '/api/admin/providers').json()['providers']
        assert all(provider['hasApiKey'] is True and 'apiKey' not in provider for provider in saved)
        # Disabled temporary providers allow development demo chat checks without external requests.
        for row in page.locator('.admin-provider-row').all():
            if row.get_by_role('button', name='停用', exact=True).count():
                row.get_by_role('button', name='停用', exact=True).click()
                expect(row.get_by_role('button', name='启用', exact=True)).to_be_visible()
        log('PASS all four provider forms, local connection error, hidden/preserved keys, disabling providers')

        page.goto(BASE + '/settings')
        page.get_by_label('昵称', exact=True).fill('QA管理员已更新')
        page.get_by_role('button', name='保存昵称').click()
        expect(page.get_by_role('status')).to_contain_text('昵称已保存')
        page.locator('#current-password').fill('incorrect-password')
        page.locator('#new-password').fill(credentials['password'])
        page.locator('#confirm-new-password').fill(credentials['password'])
        page.get_by_role('button', name='更新密码').click()
        expect(page.locator('.error-message[role="alert"]')).to_be_visible()
        page.screenshot(path=str(OUT / 'settings-desktop.png'), full_page=True)
        page.set_viewport_size({'width': 390, 'height': 844})
        page.screenshot(path=str(OUT / 'settings-mobile.png'), full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Settings overflow on mobile'
        log('PASS profile save, bad-current-password feedback, mobile settings layout')
        page.goto(BASE + '/admin?tab=settings')
        expect(page.get_by_role('heading', name='站点设置', exact=True)).to_be_visible()
        page.screenshot(path=str(OUT / 'admin-settings-mobile.png'), full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Admin overflow on mobile'
        context.storage_state(path=str(OUT / 'admin-state.json'))
        log('PASS mobile admin layout')

    assert not errors, errors
    log('PASS no uncaught browser exceptions')
    browser.close()
