"""User-directory UI regression with browser-local fixtures and no server writes.

The real paginated endpoint is read once. Search, race cancellation, mutations,
quota editing and reset submissions are then intercepted inside this browser.
"""
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import Error, expect, sync_playwright

BASE = os.environ.get('CHATPONY_QA_URL', 'http://127.0.0.1:3210').rstrip('/')
OUT = Path('test-results')
OUT.mkdir(exist_ok=True)
errors, unexpected_writes, queries, mutations, resets, held = [], [], [], [], [], []
get_status, patch_status, legacy = 200, 200, False


def log(message):
    print('PASS ' + message, flush=True)


def no_overflow(page):
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')


def guard(route):
    if route.request.method not in ('GET', 'HEAD', 'OPTIONS'):
        unexpected_writes.append(route.request.method + ' ' + urlparse(route.request.url).path)
        route.abort('blockedbyclient')
    else:
        route.continue_()


def fulfill(route, data, status=200):
    route.fulfill(status=status, content_type='application/json', body=json.dumps(data, ensure_ascii=False))


def choose(page, label, option):
    page.get_by_role('combobox', name=label, exact=True).click()
    page.get_by_role('option', name=option, exact=isinstance(option, str)).click()


def ready(page):
    expect(page.locator('.admin-user-directory')).to_have_attribute('aria-busy', 'false')


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(storage_state=str(OUT / 'admin-state.json'), viewport={'width': 1440, 'height': 1000})
    try:
        response = context.request.get(BASE + '/api/admin/users?page=1&pageSize=50')
        assert response.ok, response.text()
        live = response.json()
        assert {'users', 'total', 'page', 'pageSize'} <= live.keys()
        assert live['page'] == 1 and live['pageSize'] == 50 and len(live['users']) <= 50
        session = context.request.get(BASE + '/api/session').json()['user']
        assert session and session['role'] == 'admin'
        log('The authenticated live endpoint returns bounded pagination metadata.')

        records = [{**session, 'emailVerified': True}]
        for index in range(1, 1005):
            records.append({
                'id': f'fixture-user-{index:04d}', 'username': f'用户{index:04d}',
                'email': f'user{index:04d}@fixture.example', 'role': 'user', 'disabled': False,
                'emailVerified': True, 'createdAt': f'2025-01-{1 + index % 28:02d}T00:00:00.000Z',
                'quota5h': None, 'quota1d': None, 'quota7d': None,
                'quota5hEnabled': None, 'quota1dEnabled': None, 'quota7dEnabled': None,
            })
        oldest = records[-1]
        oldest['username'] = '早期用户1004'

        def users_fixture(route):
            parsed = urlparse(route.request.url)
            if route.request.method == 'PATCH':
                assert parsed.path.startswith('/api/admin/users/')
                payload = route.request.post_data_json
                mutations.append({'id': parsed.path.rsplit('/', 1)[1], 'payload': payload})
                if patch_status != 200:
                    fulfill(route, {'error': {'code': 'LAST_ADMIN', 'message': '至少需要保留一位可用的管理员。'}}, patch_status)
                    return
                record = next(item for item in records if item['id'] == mutations[-1]['id'])
                record.update(payload)
                fulfill(route, {'user': record})
                return
            assert route.request.method == 'GET' and parsed.path == '/api/admin/users'
            params = parse_qs(parsed.query)
            query = params.get('query', [''])[0]
            page_number = int(params.get('page', ['1'])[0])
            page_size = int(params.get('pageSize', ['50'])[0])
            queries.append({'query': query, 'page': page_number, 'pageSize': page_size})
            if get_status != 200:
                fulfill(route, {'error': {'code': 'USER_SEARCH_TEST', 'message': '用户搜索测试失败，请稍后重试。'}}, get_status)
                return
            if query == 'slow-stale-query':
                held.append(route)
                return
            if legacy:
                fulfill(route, {'users': records[:2]})
                return
            items = [item for item in records if query.lower() in ' '.join([item['id'], item['username'], item['email']]).lower()]
            pages = max(1, (len(items) + page_size - 1) // page_size)
            page_number = min(page_number, pages)
            fulfill(route, {'users': items[(page_number - 1) * page_size:page_number * page_size], 'total': len(items), 'page': page_number, 'pageSize': page_size})

        def reset_fixture(route):
            assert route.request.method == 'POST'
            payload = route.request.post_data_json
            resets.append(payload)
            fulfill(route, {'resetUsers': 1 if payload['scope'] == 'user' else len(records), 'windows': ['5h', '1d', '7d'] if payload['window'] == 'all' else [payload['window']], 'resetAt': datetime.now(timezone.utc).isoformat()})

        context.route('**/api/**', guard)
        context.route('**/api/admin/users**', users_fixture)
        context.route('**/api/admin/quotas/reset', reset_fixture)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(BASE + '/admin?tab=users', wait_until='networkidle')
        ready(page)
        rows = page.locator('.admin-users-table tbody tr')
        expect(rows).to_have_count(50)
        expect(page.locator('.admin-user-directory .admin-count')).to_have_text('1,005')
        expect(page.get_by_role('combobox', name=session['username'] + ' 的账户权限', exact=True)).to_be_disabled()
        current_row = rows.filter(has=page.get_by_role('button', name=session['username'] + ' 的 AI 配额', exact=True))
        expect(current_row.get_by_role('button', name='停用', exact=True)).to_be_disabled()
        page.get_by_role('button', name='下一页用户', exact=True).click()
        ready(page)
        expect(rows).to_have_count(50)
        assert queries[-1]['page'] == 2
        page.get_by_role('button', name='上一页用户', exact=True).click()
        ready(page)
        assert queries[-1]['page'] == 1
        no_overflow(page)
        page.screenshot(path=str(OUT / 'users-paginated-desktop.png'))
        log('A 1,005-user directory paginates on the server; self-demotion and self-disable remain unavailable.')

        search = page.get_by_role('searchbox', name='搜索用户', exact=True)
        search.fill('  ' + oldest['id'] + '  ')
        ready(page)
        expect(rows).to_have_count(1)
        assert queries[-1]['query'] == oldest['id'] and queries[-1]['page'] == 1
        expect(rows.first).to_contain_text(oldest['username'])
        choose(page, oldest['username'] + ' 的账户权限', '管理员')
        ready(page)
        expect(page.get_by_role('combobox', name=oldest['username'] + ' 的账户权限', exact=True)).to_have_text('管理员')
        choose(page, oldest['username'] + ' 的账户权限', '普通用户')
        ready(page)
        expect(page.get_by_role('combobox', name=oldest['username'] + ' 的账户权限', exact=True)).to_have_text('普通用户')
        rows.first.get_by_role('button', name='停用', exact=True).click()
        ready(page)
        expect(rows.first).to_contain_text('已停用')
        rows.first.get_by_role('button', name='启用', exact=True).click()
        ready(page)
        expect(rows.first).to_contain_text('正常')
        patch_status = 409
        rows.first.get_by_role('button', name='停用', exact=True).click()
        expect(page.locator('.admin-user-directory [role=alert]')).to_contain_text('至少需要保留一位')
        expect(rows.first.get_by_role('button', name='停用', exact=True)).to_be_enabled()
        patch_status = 200
        page.get_by_role('button', name=oldest['username'] + ' 的 AI 配额', exact=True).click()
        editor = page.get_by_role('dialog', name='调整用户配额')
        editor.locator('#user-quota-1d').fill('33')
        choose(page, '1 天配额开关', '启用')
        editor.get_by_role('button', name='保存配额', exact=True).click()
        expect(editor).not_to_be_visible()
        ready(page)
        assert oldest['quota1d'] == 33 and oldest['quota1dEnabled'] is True
        log('An account outside the latest 1,000 is searchable by ID and supports repeated role/status changes, server errors and quota editing.')

        search.fill(oldest['email'].upper())
        ready(page)
        expect(rows).to_have_count(1)
        search.fill('不存在的账户')
        expect(page.get_by_role('heading', name='没有找到匹配的用户', exact=True)).to_be_visible()
        get_status = 503
        page.get_by_role('button', name='刷新用户', exact=True).click()
        expect(page.locator('.admin-user-directory [role=alert]')).to_contain_text('用户搜索测试失败')
        expect(page.get_by_role('button', name='下一页用户', exact=True)).to_be_disabled()
        get_status = 200
        page.get_by_role('button', name='重新加载用户', exact=True).click()
        expect(page.get_by_role('heading', name='没有找到匹配的用户', exact=True)).to_be_visible()
        with page.expect_request(lambda request: 'query=slow-stale-query' in request.url):
            search.fill('slow-stale-query')
        search.fill(oldest['username'])
        ready(page)
        expect(rows).to_have_count(1)
        assert held, 'The intentionally delayed query must be observed'
        for route in held:
            try:
                fulfill(route, {'users': [records[1]], 'total': 1, 'page': 1, 'pageSize': 50})
            except Error as error:
                assert 'closed' in str(error).lower() or 'handled' in str(error).lower() or 'aborted' in str(error).lower(), str(error)
        page.wait_for_timeout(300)
        expect(rows.first).to_contain_text(oldest['username'])
        log('Name/email/ID search, empty results and retry work; an obsolete delayed response cannot replace the current query.')

        page.get_by_role('button', name='重置使用量', exact=True).click()
        dialog = page.get_by_role('dialog', name='重置对话用量')
        expect(dialog.locator('.quota-reset-user-search')).to_have_attribute('aria-busy', 'false')
        expect(dialog.get_by_role('button', name='下一组重置用户', exact=True)).to_be_enabled()
        dialog.get_by_role('button', name='下一组重置用户', exact=True).click()
        expect(dialog.locator('.quota-reset-user-search')).to_have_attribute('aria-busy', 'false')
        assert queries[-1]['page'] == 2
        reset_search = dialog.get_by_role('searchbox', name='搜索重置用户', exact=True)
        reset_search.fill(oldest['email'])
        expect(dialog.locator('.quota-reset-search-status')).to_contain_text('找到 1 位用户')
        choose(page, '选择重置用户', re.compile('^' + re.escape(oldest['username'])))
        dialog.get_by_role('button', name='查看重置确认', exact=True).click()
        expect(dialog.locator('.quota-reset-confirm')).to_contain_text(oldest['email'])
        dialog.get_by_role('button', name='返回选择', exact=True).click()
        reset_search.fill('user0001')
        expect(dialog.get_by_role('button', name='查看重置确认', exact=True)).to_be_disabled()
        expect(dialog.locator('.quota-reset-search-status')).to_contain_text('找到 1 位用户')
        expect(dialog.get_by_role('combobox', name='选择重置用户', exact=True)).to_have_text('选择需要重置的用户')
        get_status = 503
        reset_search.fill('触发错误')
        expect(dialog.locator('.quota-reset-search-error')).to_contain_text('用户搜索测试失败')
        expect(dialog.get_by_role('button', name='查看重置确认', exact=True)).to_be_disabled()
        get_status = 200
        dialog.get_by_role('button', name='重新搜索用户', exact=True).click()
        expect(dialog.locator('.quota-reset-search-status')).to_contain_text('没有找到匹配的用户')
        reset_search.fill(oldest['id'])
        expect(dialog.locator('.quota-reset-search-status')).to_contain_text('找到 1 位用户')
        page.set_viewport_size({'width': 390, 'height': 844})
        choose(page, '选择重置用户', re.compile('^' + re.escape(oldest['username'])))
        choose(page, '重置时间窗口', '1 天')
        no_overflow(page)
        dialog.screenshot(path=str(OUT / 'users-reset-search-mobile.png'))
        dialog.get_by_role('button', name='查看重置确认', exact=True).click()
        expect(dialog.locator('.quota-reset-confirm')).to_contain_text(oldest['email'])
        dialog.get_by_role('button', name='确认重置使用量', exact=True).click()
        expect(dialog).not_to_be_visible()
        ready(page)
        assert resets == [{'scope': 'user', 'userId': oldest['id'], 'window': '1d'}], resets
        no_overflow(page)
        page.screenshot(path=str(OUT / 'users-search-mobile.png'), full_page=True)
        log('Reset selection searches and pages across all users, clears stale targets, retries errors and confirms the exact mobile selection.')

        legacy = True
        search.fill('')
        ready(page)
        expect(rows).to_have_count(2)
        expect(page.get_by_role('button', name='下一页用户', exact=True)).to_be_disabled()
        assert not errors, errors
        assert not unexpected_writes, unexpected_writes
        assert len(mutations) == 6
        log('Legacy users-only fixtures remain usable; all six mutations and the reset stayed in browser fixtures; no JavaScript errors or server writes.')
    finally:
        context.close()
        browser.close()
