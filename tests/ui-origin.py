"""Site URL recovery against a dedicated, empty production QA database.

Set CHATPONY_QA_URL explicitly. Creates only isolated QA accounts and settings;
never point this script at an existing site. No mail or model call is made.
"""

import os
from pathlib import Path
import secrets

from playwright.sync_api import expect, sync_playwright


BASE = os.environ['CHATPONY_QA_URL'].rstrip('/')
OUT = Path('test-results')
OUT.mkdir(exist_ok=True)
WRONG_URL = 'https://wrong-site.example'
EMAIL = 'origin-admin-' + secrets.token_hex(6) + '@example.test'
PASSWORD = 'Origin-QA!' + secrets.token_urlsafe(20)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def settings():
        return page.evaluate("async () => (await fetch('/api/admin/settings')).json()")['settings']

    def save():
        with page.expect_response('**/api/admin/settings') as response:
            page.get_by_role('button', name='保存站点设置', exact=True).click()
        assert response.value.status == 200, response.value.text()
        expect(page.locator('.admin-notice[role="status"]')).to_contain_text('站点设置已保存')

    try:
        no_script = browser.new_context(java_script_enabled=False)
        static_login = no_script.new_page()
        static_login.goto(BASE + '/login', wait_until='domcontentloaded')
        expect(static_login.locator('.auth-submit')).to_be_disabled()
        expect(static_login.locator('form.auth-form')).to_have_attribute('method', 'post')
        no_script.close()
        print('PASS uninitialized login cannot submit credentials in a query string', flush=True)

        page.add_init_script("""
            const originalFetch = window.fetch.bind(window);
            window.fetch = (input, init) => {
                const url = new URL(typeof input === 'string' ? input : input.url, location.href);
                if (url.pathname === '/api/session' && !sessionStorage.getItem('qa-timeout-complete')) {
                    return new Promise((resolve, reject) => {
                        const abort = () => {
                            sessionStorage.setItem('qa-timeout-complete', '1');
                            reject(new DOMException('Test request cancelled', 'AbortError'));
                        };
                        if (init?.signal?.aborted) abort();
                        else init?.signal?.addEventListener('abort', abort, { once: true });
                    });
                }
                return originalFetch(input, init);
            };
        """)
        page.goto(BASE + '/login', wait_until='domcontentloaded')
        expect(page.locator('.auth-submit')).to_be_disabled()
        expect(page.locator('.error-message[role="alert"]')).to_contain_text(
            '读取账户设置超时', timeout=20000
        )
        expect(page.get_by_role('button', name='重新加载页面', exact=True)).to_be_visible()
        page.get_by_role('button', name='重新加载页面', exact=True).click()
        expect(page.get_by_role('button', name='登录 ChatPony', exact=True)).to_be_enabled()
        print('PASS stalled account settings time out with a working retry', flush=True)

        page.goto(BASE + '/register', wait_until='networkidle')
        session = page.evaluate("async () => (await fetch('/api/session')).json()")
        assert session['bootstrapRequired'] is True, 'Use an empty dedicated QA database.'
        expect(page.get_by_role('heading', name='欢迎创建 ChatPony')).to_be_visible()
        page.get_by_label('你的昵称').fill('地址恢复管理员')
        page.get_by_label('邮箱地址').fill(EMAIL)
        page.locator('#password').fill(PASSWORD)
        page.locator('#confirmPassword').fill(PASSWORD)
        page.get_by_role('button', name='创建管理员账户', exact=True).click()
        page.wait_for_url('**/admin?tab=settings')
        expect(page.locator('#site-url')).to_be_visible()
        expect(page.locator('input[name="allowPrivateApiUrls"]')).to_have_count(0)
        page.locator('#site-url').fill(WRONG_URL)
        save()
        assert settings()['siteUrl'] == WRONG_URL
        page.reload(wait_until='networkidle')
        expect(page.locator('#site-url')).to_have_value(WRONG_URL)
        print('PASS wrong public URL persists without blocking the admin page', flush=True)

        # Prove recovery also works after losing the current browser session.
        context.clear_cookies()
        page.goto(BASE + '/login', wait_until='networkidle')
        page.get_by_label('邮箱地址').fill(EMAIL)
        page.locator('#password').fill(PASSWORD)
        with page.expect_response('**/api/auth/login') as response:
            page.get_by_role('button', name='登录 ChatPony', exact=True).click()
        assert response.value.status == 200, response.value.text()
        page.wait_for_url(BASE + '/')
        page.goto(BASE + '/admin?tab=settings', wait_until='networkidle')
        expect(page.locator('#site-url')).to_have_value(WRONG_URL)
        print('PASS fresh login succeeds while the public URL is incorrect', flush=True)

        before = settings()
        page.get_by_role('button', name='使用当前访问地址', exact=True).click()
        expect(page.locator('#site-url')).to_have_value(BASE)
        expect(page.get_by_role('button', name='保存站点设置', exact=True)).to_be_enabled()
        assert settings() == before, 'Recovery button must not save other settings implicitly.'
        save()
        after = settings()
        assert after['siteUrl'] == BASE
        assert {k: v for k, v in after.items() if k != 'siteUrl'} == {
            k: v for k, v in before.items() if k != 'siteUrl'
        }
        page.locator('.admin-site-section').first.screenshot(path=str(OUT / 'origin-recovery-desktop.png'))
        print('PASS recovery button fills current origin and saving preserves other settings', flush=True)

        page.locator('#site-url').fill('')
        save()
        page.reload(wait_until='networkidle')
        expect(page.locator('#site-url')).to_have_value('')
        assert settings()['siteUrl'] == ''
        page.get_by_role('button', name='使用当前访问地址', exact=True).click()
        save()
        print('PASS mail-link URL is optional and an empty value persists', flush=True)

        page.set_viewport_size({'width': 390, 'height': 844})
        page.reload(wait_until='networkidle')
        expect(page.locator('#site-url')).to_have_value(BASE)
        expect(page.get_by_role('button', name='使用当前访问地址', exact=True)).to_be_visible()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
        page.locator('.admin-site-section').first.screenshot(path=str(OUT / 'origin-recovery-mobile.png'))
        assert not errors, errors
        print('PASS mobile recovery controls, no horizontal overflow or browser errors', flush=True)
    finally:
        browser.close()
