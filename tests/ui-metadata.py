"""Time/calendar settings UI regression on the isolated development QA server.

Exercises real settings saves and the non-persisting preview endpoint. All
original writable settings are restored in finally. No mail or model is called.
"""

from datetime import datetime
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlparse

from playwright.sync_api import Error, expect, sync_playwright

BASE = os.environ.get('CHATPONY_QA_URL', 'http://127.0.0.1:3210').rstrip('/')
OUT = Path('test-results')
STATE = OUT / 'admin-state.json'
PREVIEW = '/api/admin/settings/preview-metadata'
SETTINGS = '/api/admin/settings'
FIELDS = (
    ('promptIncludeDate', 'date', '日期：'),
    ('promptIncludeTime', 'time', '时间：'),
    ('promptIncludeWeekday', 'weekday', '星期：'),
    ('promptIncludeLunarDate', 'lunar', '农历：'),
    ('promptIncludeSolarTerm', 'solar-term', '当前节气：'),
    ('promptIncludeHolidays', 'holidays', '节日：'),
)
METADATA_KEYS = ['promptMetadataEnabled', 'promptTimezone'] + [field[0] for field in FIELDS]


def log(message):
    print('PASS ' + message, flush=True)


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(storage_state=str(STATE), viewport={'width': 1440, 'height': 1000})
    page = context.new_page()
    original, changed = None, False
    errors, unexpected_writes, browser_writes = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))

    def guard(route):
        request = route.request
        path = urlparse(request.url).path
        if request.method not in ('GET', 'HEAD', 'OPTIONS'):
            browser_writes.append((request.method, path))
            if (request.method, path) not in (('POST', PREVIEW), ('PATCH', SETTINGS)):
                unexpected_writes.append((request.method, path))
                route.abort('blockedbyclient')
                return
        route.continue_()

    context.route('**/api/**', guard)

    def read_settings():
        response = context.request.get(BASE + SETTINGS)
        assert response.ok, (response.status, response.text())
        return response.json()['settings']

    def request(method, path, payload):
        return context.request.fetch(BASE + path, method=method, data=payload, headers={'Origin': BASE})

    def choose_timezone(label):
        page.locator('#site-prompt-timezone').click()
        page.get_by_role('option', name=label, exact=True).click()

    def set_fields(enabled):
        for key, slug, _ in FIELDS:
            page.locator('#site-prompt-' + slug).set_checked(key in enabled)

    def preview():
        with page.expect_response(lambda response: response.url == BASE + PREVIEW and response.request.method == 'POST') as pending:
            page.get_by_role('button', name='预览注入内容', exact=True).click()
        response = pending.value
        assert response.ok, (response.status, response.text())
        result = response.json()
        assert datetime.fromisoformat(result['generatedAt'].replace('Z', '+00:00')).tzinfo is not None
        if result['text']:
            expect(page.locator('.metadata-preview pre')).to_have_text(result['text'])
        return result

    def save():
        global changed
        changed = True
        with page.expect_response(lambda response: response.url == BASE + SETTINGS and response.request.method == 'PATCH') as pending:
            page.get_by_role('button', name='保存站点设置', exact=True).click()
        response = pending.value
        assert response.ok, (response.status, response.text())
        expect(page.locator('.admin-notice[role=status]')).to_contain_text('站点设置已保存')
        return response.json()['settings']

    try:
        original = read_settings()
        assert original['developmentMode'], 'Use only the dedicated development QA server.'
        assert all(key in original for key in METADATA_KEYS), 'Start the metadata-capable QA server first.'
        page.goto(BASE + '/admin?tab=settings', wait_until='networkidle')
        section = page.locator('.admin-metadata-section')
        master = page.locator('#site-prompt-metadata-enabled')
        expect(section.get_by_role('heading', name='时间与日历信息')).to_be_visible()
        expect(master).to_be_checked(checked=original['promptMetadataEnabled'])
        for key, slug, _ in FIELDS:
            expect(page.locator('#site-prompt-' + slug)).to_be_checked(checked=original[key])
        master.uncheck()
        expect(section.get_by_text('已关闭，不注入', exact=True)).to_be_visible()
        expect(section.get_by_role('button', name='预览注入内容', exact=True)).to_be_disabled()
        expect(section).to_contain_text('不包含法定调休表')
        expect(section).to_contain_text('明确的时间设定优先')
        assert read_settings() == original
        log('Persisted defaults populate all controls; disabled state is explicit and edits stay unsaved.')

        master.check()
        choose_timezone('协调世界时 · UTC')
        for key, _, label in FIELDS:
            set_fields({key})
            result = preview()
            lines = result['text'].splitlines()
            assert any(line.startswith(label) for line in lines), (key, result)
            for other, _, other_label in FIELDS:
                if other != key:
                    assert not any(line.startswith(other_label) for line in lines), (key, other, result)
            assert read_settings() == original, 'Preview must not save unsaved controls.'
        set_fields(set())
        assert preview()['text'] == ''
        expect(section.get_by_text('未选择任何信息，不注入', exact=True)).to_be_visible()
        log('Each of six information switches controls its preview independently; empty selection injects nothing.')

        choose_timezone('自定义 IANA 时区')
        custom = page.locator('#site-prompt-timezone-custom')
        custom.fill('Mars/Ponyville')
        assert not custom.evaluate('element => element.checkValidity()')
        expect(custom).to_have_attribute('aria-invalid', 'true')
        expect(section.get_by_role('alert')).to_contain_text('无法识别此时区')
        expect(section.get_by_role('button', name='预览注入内容', exact=True)).to_be_disabled()
        writes_before = len(browser_writes)
        page.get_by_role('button', name='保存站点设置', exact=True).click()
        assert len(browser_writes) == writes_before, 'Invalid custom zone must stop form submission.'
        custom.fill('+08:00')
        assert not custom.evaluate('element => element.checkValidity()')
        for method, path in (('POST', PREVIEW), ('PATCH', SETTINGS)):
            response = request(method, path, {'promptMetadataEnabled': False, 'promptTimezone': 'Mars/Ponyville'})
            assert response.status == 400 and response.json()['error']['code'] == 'INVALID_PROMPT_METADATA'
        assert read_settings() == original
        custom.fill('Europe/Berlin')
        assert custom.evaluate('element => element.checkValidity()')
        set_fields({field[0] for field in FIELDS})
        full = preview()
        assert '站点时区：Europe/Berlin' in full['text']
        assert 'Asia/Shanghai' in full['text'] and '不代表法定假期或调休安排' in full['text']
        # Keep the unrelated sticky form footer out of component-only captures.
        section.screenshot(path=str(OUT / 'metadata-desktop.png'), style='.admin-site-footer { visibility: hidden !important; }')
        assert read_settings() == original
        log('Custom IANA validation blocks invalid UI/API values; server preview uses unsaved settings without persistence.')

        saved = save()
        expected = {key: True for key in METADATA_KEYS if key != 'promptTimezone'}
        expected['promptTimezone'] = 'Europe/Berlin'
        assert all(saved[key] == value for key, value in expected.items())
        page.reload(wait_until='networkidle')
        expect(master).to_be_checked()
        expect(page.locator('#site-prompt-timezone')).to_have_text('自定义 IANA 时区')
        expect(custom).to_have_value('Europe/Berlin')
        for _, slug, _ in FIELDS:
            expect(page.locator('#site-prompt-' + slug)).to_be_checked()
        expect(section.locator('pre')).to_have_count(0)
        master.uncheck()
        page.locator('#site-prompt-lunar').uncheck()
        disabled = save()
        assert not disabled['promptMetadataEnabled'] and not disabled['promptIncludeLunarDate']
        assert disabled['promptTimezone'] == 'Europe/Berlin' and disabled['promptIncludeDate']
        page.reload(wait_until='networkidle')
        expect(master).not_to_be_checked()
        expect(section.get_by_text('已关闭，不注入', exact=True)).to_be_visible()
        off = request('POST', PREVIEW, {'promptMetadataEnabled': False})
        assert off.ok and off.json()['text'] == ''
        assert read_settings() == disabled
        log('Full settings PATCH and reload preserve all eight fields; disabling keeps preferences and injects no text.')

        master.check()
        before_fixtures = read_settings()
        fixture_status = 503
        fixture_text = '<script>window.__unsafeMetadata = true</script>\n仅用于文本预览验证'

        def fixture(route):
            body = {'error': {'code': 'TEST_FAILURE', 'message': '预览服务暂时不可用，请重试。'}} if fixture_status == 503 else {'text': fixture_text, 'generatedAt': '2026-10-05T12:00:00.000Z'}
            route.fulfill(status=fixture_status, content_type='application/json', body=json.dumps(body))

        context.route('**' + PREVIEW, fixture)
        page.get_by_role('button', name='预览注入内容', exact=True).click()
        expect(section.get_by_role('alert')).to_contain_text('预览服务暂时不可用')
        fixture_status = 200
        page.get_by_role('button', name='预览注入内容', exact=True).click()
        expect(section.locator('pre')).to_have_text(fixture_text)
        assert page.evaluate('typeof window.__unsafeMetadata') == 'undefined'
        expect(section.get_by_role('alert')).to_have_count(0)
        assert section.locator('pre').evaluate('element => getComputedStyle(element).whiteSpace') == 'pre-wrap'
        page.locator('#site-prompt-lunar').check()
        expect(section.locator('pre')).to_have_count(0)
        context.unroute('**' + PREVIEW, fixture)

        pending_routes = []

        def hold(route):
            pending_routes.append(route)

        context.route('**' + PREVIEW, hold)
        page.get_by_role('button', name='预览注入内容', exact=True).click()
        expect(section.locator('.metadata-preview')).to_have_attribute('aria-busy', 'true')
        expect(section.get_by_role('button', name='正在生成预览…', exact=True)).to_be_disabled()
        page.locator('#site-prompt-time').uncheck()
        expect(section.locator('.metadata-preview')).to_have_attribute('aria-busy', 'false')
        assert pending_routes
        try:
            pending_routes[0].fulfill(content_type='application/json', body=json.dumps({'text': '过期预览不得显示', 'generatedAt': '2026-10-05T12:00:00.000Z'}))
        except Error:
            pass  # An aborted route is already closed in some Edge releases.
        expect(section).not_to_contain_text('过期预览不得显示')
        expect(section.locator('pre')).to_have_count(0)
        context.unroute('**' + PREVIEW, hold)
        assert read_settings() == before_fixtures
        log('Loading/error/retry states work; preview is plain text; changing settings discards completed and in-flight previews.')

        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_function("""() => {
            const sidebar = document.querySelector('.sidebar');
            return !sidebar || (sidebar.getBoundingClientRect().right <= 0 && getComputedStyle(sidebar).visibility === 'hidden');
        }""")
        choose_timezone('中国标准时间 · Asia/Shanghai')
        set_fields({field[0] for field in FIELDS})
        preview()
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        section.screenshot(path=str(OUT / 'metadata-mobile.png'), style='.admin-site-footer { visibility: hidden !important; }')
        page.locator('#site-prompt-timezone').click()
        popup = page.locator('[data-pony-select-menu][data-state=open]')
        expect(popup).to_be_visible()
        page.wait_for_function("""() => document.querySelector('[data-pony-select-menu][data-state=open]').getAnimations().every(animation => animation.playState === 'finished')""")
        box = popup.bounding_box()
        assert box and box['x'] >= 10 and box['x'] + box['width'] <= 380, box
        assert box['y'] >= 0 and box['y'] + box['height'] <= 844, box
        page.screenshot(path=str(OUT / 'metadata-timezones-mobile.png'))
        page.keyboard.press('Escape')
        expect(popup).to_have_count(0)
        assert read_settings() == before_fixtures
        guest = browser.new_context()
        denied = guest.request.post(BASE + PREVIEW, data={'promptMetadataEnabled': True}, headers={'Origin': BASE})
        assert denied.status == 401
        guest.close()
        assert not errors, errors
        assert not unexpected_writes, unexpected_writes
        log('390 px section and custom Select stay in bounds; anonymous preview is denied; no JS errors or unrelated writes.')
    finally:
        active_error = sys.exc_info()[1]
        cleanup_error = None
        if changed and original:
            try:
                payload = {key: value for key, value in original.items() if key not in ('smtpHasPassword', 'developmentMode')}
                response = request('PATCH', SETTINGS, payload)
                assert response.ok, (response.status, response.text())
                assert read_settings() == original, 'Original settings were not fully restored.'
                log('All original site settings restored and verified; no email or AI request was made.')
            except Exception as error:
                cleanup_error = error
        context.close()
        browser.close()
        if cleanup_error:
            print('Settings restoration failed: ' + str(cleanup_error), file=sys.stderr, flush=True)
            if active_error is None:
                raise AssertionError('Metadata QA cleanup failed') from cleanup_error
