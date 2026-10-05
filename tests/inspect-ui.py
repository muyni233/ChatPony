"""Read-only browser QA for route gating and shared Select interactions.

Run against an existing QA server with saved administrator cookies. No forms
are submitted, and any non-read API request is blocked and fails the suite.
"""

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
assert STATE.exists(), 'Save QA administrator cookies to test-results/admin-state.json first.'

errors = []
mutations = []
results = []


def log(message):
    results.append(message)
    print('PASS ' + message, flush=True)


def guard(route):
    request = route.request
    if urlparse(request.url).path.startswith('/api/') and request.method not in ('GET', 'HEAD', 'OPTIONS'):
        mutations.append(f'{request.method} {urlparse(request.url).path}')
        route.abort('blockedbyclient')
    else:
        route.continue_()


def readonly_context(browser, **options):
    context = browser.new_context(**options)
    context.route('**/api/**', guard)
    context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
    return context


def goto(page, path):
    page.goto(BASE + path, wait_until='networkidle')


def menu(page):
    return page.locator('[data-pony-select-menu][data-state="open"]')


def settle_menu(page):
    expect(menu(page)).to_be_visible()
    page.wait_for_function("""() => {
        const menu = document.querySelector('[data-pony-select-menu][data-state="open"]');
        return menu && menu.getAnimations().every(animation => animation.playState === 'finished');
    }""")


def assert_no_overflow(page):
    assert not page.evaluate('document.documentElement.scrollWidth > window.innerWidth'), 'Horizontal page overflow.'


def assert_menu_bounds(page):
    box = menu(page).bounding_box()
    viewport = page.viewport_size
    assert box and viewport
    assert box['x'] >= 10, box
    assert box['x'] + box['width'] <= viewport['width'] - 10, box
    assert box['y'] >= 0 and box['y'] + box['height'] <= viewport['height'], box


def check_nested_escape(page, dialog, trigger):
    trigger.focus()
    page.keyboard.press('Enter')
    expect(menu(page)).to_be_visible()
    page.keyboard.press('Escape')
    expect(menu(page)).to_have_count(0)
    expect(dialog).to_be_visible()
    expect(trigger).to_be_focused()
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    try:
        guest = readonly_context(browser, viewport={'width': 1440, 'height': 1000})
        page = guest.new_page()
        for path in ('/', '/conversations', '/groups', '/memories', '/announcements', '/settings', '/admin', '/chat/missing'):
            goto(page, path)
            expect(page).to_have_url(re.compile(r'/login(?:\?.*)?$'))
            expect(page.get_by_role('heading', name='欢迎回来', exact=True)).to_be_visible()
            assert page.locator('.app-shell').count() == 0, path
        page.screenshot(path=str(OUT / 'access-login-desktop.png'), full_page=True)
        log('All eight anonymous platform routes redirect to login without rendering the app shell.')

        for path, heading in (
            ('/register', '从这里，开启对话'),
            ('/forgot-password', '找回你的账户'),
            ('/reset-password', '设置新的密码'),
            ('/verify-email', '确认你的邮箱'),
        ):
            goto(page, path)
            expect(page).to_have_url(BASE + path)
            expect(page.get_by_role('heading', name=heading, exact=True)).to_be_visible()
        log('Registration, recovery, reset, and email verification remain public.')
        page.set_viewport_size({'width': 390, 'height': 844})
        goto(page, '/login')
        assert_no_overflow(page)
        page.screenshot(path=str(OUT / 'access-login-mobile.png'), full_page=True)
        page.get_by_role('link', name='预览', exact=True).click()
        expect(page).to_have_url(BASE + '/preview')
        expect(page.get_by_role('heading', name=re.compile('每一次相遇'))).to_be_visible()
        page.screenshot(path=str(OUT / 'visitor-preview-mobile.png'), full_page=True)
        page.get_by_role('button', name='开始对话', exact=True).first.click()
        expect(page).to_have_url(BASE + '/login')
        log('Explicit preview opens publicly; starting a conversation still requires login.')
        guest.close()

        desktop = readonly_context(browser, storage_state=str(STATE), viewport={'width': 1440, 'height': 1000})
        page = desktop.new_page()
        goto(page, '/')
        expect(page.get_by_role('heading', name=re.compile('每一次相遇'))).to_be_visible()
        assert_no_overflow(page)
        page.screenshot(path=str(OUT / 'home-desktop.png'), full_page=True)
        trigger = page.get_by_role('combobox', name='角色排序')
        trigger.click()
        popup = menu(page)
        expect(popup).to_be_visible()
        styles = popup.evaluate("""node => {
            const style = getComputedStyle(node);
            return { background: style.backgroundColor, borderRadius: style.borderRadius,
                border: style.borderTopWidth, shadow: style.boxShadow,
                animation: style.animationName, duration: style.animationDuration };
        }""")
        assert styles['background'] == 'rgb(255, 254, 246)', styles
        assert styles['borderRadius'] == '8px' and styles['border'] == '1px', styles
        assert styles['shadow'] != 'none', styles
        assert styles['animation'] == 'select-open' and styles['duration'] == '0.19s', styles
        assert popup.get_attribute('data-instant') is None
        settle_menu(page)
        assert_menu_bounds(page)
        # Full-page capture resizes Edge's viewport, which intentionally closes
        # Radix popups. Capture the actual viewport while a menu is open.
        page.screenshot(path=str(OUT / 'custom-select-desktop.png'))
        page.get_by_role('option', name='姓名排序', exact=True).click()
        expect(trigger).to_have_text('姓名排序')
        expect(menu(page)).to_have_count(0)
        log('Desktop Select uses themed popup, pointer entry animation, and pointer selection.')

        trigger.focus()
        page.keyboard.press('Enter')
        expect(menu(page)).to_be_visible()
        expect(menu(page)).to_have_attribute('data-instant', '')
        assert menu(page).evaluate('node => getComputedStyle(node).animationName') == 'none'
        page.keyboard.press('Home')
        expect(page.get_by_role('option', name='推荐排序', exact=True)).to_be_focused()
        page.keyboard.press('Enter')
        expect(trigger).to_have_text('推荐排序')
        expect(menu(page)).to_have_count(0)
        trigger.focus()
        page.keyboard.press('Enter')
        expect(menu(page)).to_be_visible()
        page.keyboard.press('Escape')
        expect(menu(page)).to_have_count(0)
        expect(trigger).to_be_focused()
        log('Keyboard Home / Enter / Escape select and dismiss instantly, returning focus to the trigger.')

        goto(page, '/memories')
        page.get_by_role('button', name='添加记忆', exact=True).click()
        dialog = page.get_by_role('dialog', name='添加一条记忆', exact=True)
        expect(dialog).to_be_visible()
        trigger = dialog.get_by_role('combobox', name='记忆角色')
        trigger.click()
        settle_menu(page)
        assert menu(page).evaluate('node => !!node.closest(\'[role="dialog"]\')')
        option = page.get_by_role('option').first
        expect(option).to_be_visible()
        selected_name = option.inner_text().strip()
        option.click()
        expect(trigger).to_have_text(selected_name)
        expect(dialog).to_be_visible()
        trigger.click()
        settle_menu(page)
        page.screenshot(path=str(OUT / 'select-memory-modal.png'))
        page.keyboard.press('Escape')
        expect(dialog).to_be_visible()
        check_nested_escape(page, dialog, trigger)
        log('Shared Modal Select accepts a choice; the first Escape dismisses only its menu, the next closes the modal.')

        goto(page, '/admin?tab=providers')
        page.get_by_role('button', name='添加接口', exact=True).click()
        dialog = page.get_by_role('dialog', name='添加模型接口', exact=True)
        expect(dialog).to_be_visible()
        trigger = dialog.locator('#provider-protocol')
        trigger.click()
        settle_menu(page)
        assert menu(page).evaluate('node => !!node.closest("dialog")')
        page.get_by_role('option', name='Gemini Native', exact=True).click()
        expect(trigger).to_have_text('Gemini Native')
        expect(dialog).to_be_visible()
        trigger.click()
        settle_menu(page)
        page.screenshot(path=str(OUT / 'select-native-dialog.png'))
        page.keyboard.press('Escape')
        expect(dialog).to_be_visible()
        check_nested_escape(page, dialog, trigger)
        log('Native admin Dialog Select accepts a choice and dismisses in the correct Escape order.')

        mobile = readonly_context(browser, storage_state=str(STATE), viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True)
        phone = mobile.new_page()
        goto(phone, '/')
        expect(phone.get_by_role('heading', name=re.compile('每一次相遇'))).to_be_visible()
        assert_no_overflow(phone)
        phone.screenshot(path=str(OUT / 'home-mobile.png'), full_page=True)
        trigger = phone.get_by_role('combobox', name='角色排序')
        trigger.tap()
        settle_menu(phone)
        assert_menu_bounds(phone)
        phone.screenshot(path=str(OUT / 'custom-select-mobile.png'))
        phone.get_by_role('option', name='姓名排序', exact=True).tap()
        expect(trigger).to_have_text('姓名排序')
        assert_no_overflow(phone)
        phone.get_by_role('button', name='打开导航').tap()
        expect(phone.locator('.sidebar.is-open')).to_be_visible()
        phone.get_by_role('link', name='记忆档案', exact=True).tap()
        expect(phone).to_have_url(BASE + '/memories')
        phone.get_by_role('button', name='添加记忆', exact=True).tap()
        dialog = phone.get_by_role('dialog', name='添加一条记忆', exact=True)
        dialog.get_by_role('combobox', name='记忆角色').tap()
        settle_menu(phone)
        assert_menu_bounds(phone)
        assert_no_overflow(phone)
        phone.screenshot(path=str(OUT / 'select-memory-mobile.png'))
        phone.keyboard.press('Escape')
        expect(dialog).to_be_visible()
        phone.keyboard.press('Escape')
        expect(dialog).not_to_be_visible()
        log('Mobile touch selection, navigation, and nested popup fit within a 390 px viewport.')
        mobile.close()

        reduced = readonly_context(browser, storage_state=str(STATE), viewport={'width': 1024, 'height': 900}, reduced_motion='reduce')
        still = reduced.new_page()
        goto(still, '/')
        # Radix hides the background from the accessibility tree while open.
        trigger = still.locator('button[aria-label="角色排序"]')
        trigger.click()
        expect(menu(still)).to_be_visible()
        assert menu(still).evaluate('node => getComputedStyle(node).animationName') == 'none'
        assert trigger.evaluate('node => getComputedStyle(node).transitionDuration') == '0s'
        assert trigger.locator('.pony-select-chevron').evaluate('node => getComputedStyle(node).transitionDuration') == '0s'
        still.screenshot(path=str(OUT / 'select-reduced-motion.png'))
        still.keyboard.press('Escape')
        expect(menu(still)).to_have_count(0)
        log('Reduced motion disables popup entry and trigger / chevron transitions.')
        reduced.close()

        goto(page, '/')
        expect(page.locator('.app-shell')).to_be_visible()
        destination = page.get_by_role('link', name='我的对话', exact=True)
        desktop.clear_cookies()
        destination.click()
        expect(page).to_have_url(re.compile(r'/login(?:\?.*)?$'))
        expect(page.get_by_role('heading', name='欢迎回来', exact=True)).to_be_visible()
        expect(page.locator('.app-shell')).to_have_count(0)
        log('Clearing local cookies followed by client-side navigation returns to login.')
        desktop.close()

        assert not mutations, mutations
        assert not errors, errors
        log('No API writes, JavaScript errors, configuration changes, or external service calls.')
        (OUT / 'inspect-ui-report.json').write_text(json.dumps({'url': BASE, 'checks': results, 'errors': errors, 'blockedMutations': mutations}, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception:
        if 'page' in locals() and not page.is_closed():
            page.screenshot(path=str(OUT / 'inspect-ui-failure.png'), full_page=True)
        raise
    finally:
        browser.close()
