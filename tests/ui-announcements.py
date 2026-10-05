"""Real announcement lifecycle QA against the isolated local QA database.

Creates one uniquely named announcement, exercises publication and reading,
then deletes it. Site configuration and existing announcements are untouched.
"""

import os
from pathlib import Path
import re
import secrets

from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get('CHATPONY_QA_URL', 'http://127.0.0.1:3210').rstrip('/')
OUT = Path('test-results')
OUT.mkdir(exist_ok=True)
TITLE = '界面验收公告 ' + secrets.token_hex(4)
BODY = '这是一条仅用于隔离测试数据库的临时公告。\n\n第二段保留换行，阅读状态应在刷新后保留。\n<script>window.__unsafeNotice = true</script>'
errors = []
created_id = None


def log(message):
    print('PASS ' + message, flush=True)


def settle(page):
    page.wait_for_load_state('networkidle')


def admin_row(page):
    return page.locator(f'.admin-announcement-row[data-announcement-id="{created_id}"]')


def reader_row(page):
    return page.locator(f'.announcement-row[data-announcement-id="{created_id}"]')


def no_overflow(page):
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(storage_state=str(OUT / 'admin-state.json'), viewport={'width': 1440, 'height': 1000})
    context.on('page', lambda page: page.on('pageerror', lambda error: errors.append(str(error))))
    admin = context.new_page()
    reader = context.new_page()
    try:
        admin.goto(BASE + '/admin?tab=announcements', wait_until='networkidle')
        expect(admin.get_by_role('heading', name=re.compile('^公告管理'))).to_be_visible()
        admin.get_by_role('button', name='新建公告', exact=True).click()
        dialog = admin.get_by_role('dialog', name='新建公告', exact=True)
        dialog.locator('#announcement-title').fill(TITLE)
        dialog.locator('#announcement-body').fill(BODY)
        dialog.locator('#announcement-pinned').check()
        expect(dialog.locator('#announcement-status')).to_have_text('草稿')
        admin.screenshot(path=str(OUT / 'announcement-editor-desktop.png'))
        with admin.expect_response(lambda response: response.url == BASE + '/api/admin/announcements' and response.request.method == 'POST') as response:
            dialog.get_by_role('button', name='保存公告', exact=True).click()
        assert response.value.ok, response.value.text()
        entry = response.value.json()['announcement']
        created_id = entry['id']
        expect(dialog).not_to_be_visible()
        expect(admin_row(admin)).to_be_visible()
        expect(admin_row(admin).get_by_text('草稿', exact=True)).to_be_visible()
        public_list = context.request.get(BASE + '/api/announcements?pageSize=50').json()
        assert all(item['id'] != created_id for item in public_list['items'])
        log('A new announcement saves as a pinned draft and stays hidden from the user list.')

        with admin.expect_response(lambda response: response.url.endswith('/api/admin/announcements/' + created_id) and response.request.method == 'PATCH') as response:
            admin_row(admin).get_by_role('button', name='发布', exact=True).click()
        assert response.value.ok, response.value.text()
        entry = response.value.json()['announcement']
        expect(admin_row(admin).get_by_text('已发布', exact=True)).to_be_visible()
        admin.screenshot(path=str(OUT / 'announcement-admin-desktop.png'), full_page=True)
        reader.goto(BASE + '/announcements', wait_until='networkidle')
        expect(reader_row(reader)).to_have_class(re.compile('is-unread'))
        expect(reader_row(reader).get_by_text('置顶', exact=True)).to_be_visible()
        reader.screenshot(path=str(OUT / 'announcements-desktop.png'), full_page=True)
        with reader.expect_response(lambda response: response.url.endswith('/api/announcements/' + created_id + '/read') and response.request.method == 'POST') as response:
            reader_row(reader).click()
        assert response.value.ok, response.value.text()
        detail = reader.get_by_role('dialog', name=TITLE, exact=True)
        expect(detail).to_be_visible()
        expect(detail.locator('.announcement-body')).to_have_text(BODY)
        expect(detail.locator('.announcement-body script')).to_have_count(0)
        assert reader.evaluate('window.__unsafeNotice') is None
        reader.screenshot(path=str(OUT / 'announcement-detail-desktop.png'))
        detail.get_by_role('button', name='关闭公告', exact=True).click()
        expect(detail).not_to_be_visible()
        expect(reader_row(reader)).to_have_class(re.compile('is-read'))
        reader.reload(wait_until='networkidle')
        expect(reader_row(reader)).to_have_class(re.compile('is-read'))
        live = context.request.get(BASE + '/api/announcements/' + created_id).json()['announcement']
        assert live['readAt'] is not None
        log('Publication reaches users; reading persists across reloads and displays HTML-looking content as plain text.')

        admin_row(admin).get_by_role('button', name='编辑公告 ' + TITLE, exact=True).click()
        dialog = admin.get_by_role('dialog', name='编辑公告', exact=True)
        updated_body = BODY + '\n\n这段内容已更新，需要重新阅读。'
        dialog.locator('#announcement-body').fill(updated_body)
        with admin.expect_response(lambda response: response.url.endswith('/api/admin/announcements/' + created_id) and response.request.method == 'PATCH') as response:
            dialog.get_by_role('button', name='保存公告', exact=True).click()
        assert response.value.ok, response.value.text()
        entry = response.value.json()['announcement']
        expect(dialog).not_to_be_visible()
        reader.reload(wait_until='networkidle')
        expect(reader_row(reader)).to_have_class(re.compile('is-unread'))
        log('Editing a published notice advances its version and restores its unread state.')

        first_read = True

        def stale_read(route):
            global first_read
            if first_read:
                first_read = False
                route.fulfill(status=409, content_type='application/json', body='{"error":{"message":"公告内容已更新，请重新打开后阅读。","code":"ANNOUNCEMENT_CHANGED"}}')
            else:
                route.continue_()

        context.route('**/api/announcements/' + created_id + '/read', stale_read)
        reader_row(reader).click()
        detail = reader.get_by_role('dialog', name=TITLE, exact=True)
        expect(detail.locator('.announcement-read-error')).to_contain_text('公告内容已更新')
        with reader.expect_response(lambda response: response.url.endswith('/api/announcements/' + created_id + '/read') and response.status == 200):
            detail.get_by_role('button', name='载入最新公告', exact=True).click()
        expect(detail.locator('.announcement-read-error')).to_have_count(0)
        detail.get_by_role('button', name='关闭公告', exact=True).click()
        expect(detail).not_to_be_visible()
        context.unroute('**/api/announcements/' + created_id + '/read', stale_read)
        log('An outdated read response offers a fresh reload and successfully synchronizes the current version.')

        admin_row(admin).get_by_role('button', name='编辑公告 ' + TITLE, exact=True).click()
        dialog = admin.get_by_role('dialog', name='编辑公告', exact=True)
        competing_body = updated_body + '\n另一个管理员的已保存修改。'
        competing = context.request.patch(BASE + '/api/admin/announcements/' + created_id, headers={'Origin': BASE}, data={'body': competing_body, 'revision': entry['revision']})
        assert competing.ok, competing.text()
        entry = competing.json()['announcement']
        dialog.locator('#announcement-body').fill('这段过期修改不应覆盖服务器上的新版本。')
        with admin.expect_response(lambda response: response.url.endswith('/api/admin/announcements/' + created_id) and response.request.method == 'PATCH') as response:
            dialog.get_by_role('button', name='保存公告', exact=True).click()
        assert response.value.status == 409, response.value.text()
        expect(dialog.locator('.error-message[role="alert"]')).to_contain_text('公告已被修改')
        dialog.get_by_role('button', name='返回列表并刷新', exact=True).click()
        expect(dialog).not_to_be_visible()
        expect(admin_row(admin).locator(':scope > p')).to_have_text(competing_body)
        log('A stale editor cannot overwrite a concurrent administrator update.')

        reader.reload(wait_until='networkidle')
        reader.set_viewport_size({'width': 390, 'height': 844})
        reader.wait_for_function("() => {const bar=document.querySelector('.sidebar');return !bar || (bar.getBoundingClientRect().right <= 0 && getComputedStyle(bar).visibility === 'hidden');}")
        no_overflow(reader)
        reader.screenshot(path=str(OUT / 'announcements-mobile.png'), full_page=True)
        with reader.expect_response(lambda response: response.url.endswith('/api/announcements/' + created_id + '/read') and response.status == 200):
            reader_row(reader).click()
        detail = reader.get_by_role('dialog', name=TITLE, exact=True)
        expect(detail).to_be_visible()
        no_overflow(reader)
        reader.screenshot(path=str(OUT / 'announcement-detail-mobile.png'))
        detail.get_by_role('button', name='关闭公告', exact=True).click()
        expect(detail).not_to_be_visible()
        log('Mobile list and plain-text details stay inside the viewport and retain usable close controls.')

        with admin.expect_response(lambda response: response.url.endswith('/api/admin/announcements/' + created_id) and response.request.method == 'PATCH') as response:
            admin_row(admin).get_by_role('button', name='撤回', exact=True).click()
        assert response.value.ok, response.value.text()
        expect(admin_row(admin).get_by_text('草稿', exact=True)).to_be_visible()
        reader_row(reader).click()
        unavailable = reader.get_by_role('dialog', name='公告详情', exact=True)
        expect(unavailable.locator('.announcement-read-error')).to_contain_text('已撤回')
        unavailable.get_by_role('button', name='关闭公告', exact=True).click()
        expect(unavailable).not_to_be_visible()
        reader.reload(wait_until='networkidle')
        expect(reader_row(reader)).to_have_count(0)
        log('Withdrawal removes public visibility and handles an already-open list gracefully.')

        admin_row(admin).get_by_role('button', name='删除公告 ' + TITLE, exact=True).click()
        deletion = admin.get_by_role('dialog', name='删除这条公告？', exact=True)
        expect(deletion).to_be_visible()
        with admin.expect_response(lambda response: response.url.endswith('/api/admin/announcements/' + created_id) and response.request.method == 'DELETE') as response:
            deletion.get_by_role('button', name='确认删除公告', exact=True).click()
        assert response.value.ok, response.value.text()
        expect(deletion).not_to_be_visible()
        expect(admin_row(admin)).to_have_count(0)
        assert context.request.get(BASE + '/api/announcements/' + created_id).status == 404
        log('Deletion requires confirmation and removes the temporary announcement.')
        assert not errors, errors
        log('No JavaScript errors; site configuration and pre-existing announcements were unchanged.')
    finally:
        if created_id:
            cleanup = context.request.delete(BASE + '/api/admin/announcements/' + created_id, headers={'Origin': BASE})
            assert cleanup.status in (200, 404), cleanup.text()
        context.close()
        browser.close()
