"""Read-only QA for the administrator request-audit workspace.

Reads the real endpoint, then exercises filters, pagination and error states
with local browser response fixtures. No audit or site records are written.
"""

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

BASE = os.environ.get('CHATPONY_QA_URL', 'http://127.0.0.1:3210').rstrip('/')
OUT = Path('test-results')
OUT.mkdir(exist_ok=True)
writes = []
errors = []
requests = []


def guard(route):
    if route.request.method not in ('GET', 'HEAD', 'OPTIONS'):
        writes.append(f'{route.request.method} {urlparse(route.request.url).path}')
        route.abort('blockedbyclient')
    else:
        route.continue_()


def log(message):
    print('PASS ' + message, flush=True)


def no_overflow(page):
    assert not page.evaluate('document.documentElement.scrollWidth > innerWidth')


def choose(page, name, value):
    page.get_by_role('combobox', name=name).click()
    page.get_by_role('option', name=value, exact=True).click()
    expect(page.locator('.audit-page')).to_have_attribute('aria-busy', 'false')


now = datetime.now(timezone.utc)
statuses = ('success', 'error', 'cancelled', 'rejected', 'replayed', 'pending')
records = []
for index in range(21):
    status = statuses[index % len(statuses)]
    records.append({
        'id': f'ui-audit-{index:03d}',
        'time': (now - timedelta(minutes=index * 7)).isoformat(),
        'finishedAt': None if status == 'pending' else (now - timedelta(minutes=index * 7) + timedelta(seconds=2)).isoformat(),
        'status': status, 'userId': f'ui-user-{index % 2}', 'username': 'user-alpha' if index % 2 == 0 else 'user-beta',
        'conversationId': f'ui-conversation-{index}', 'conversationTitle': '浏览器内的审计示例', 'kind': 'direct' if index % 2 == 0 else 'group',
        'providerId': 'ui-provider', 'providerName': '浏览器测试接口', 'protocol': 'openai-responses', 'model': 'model-alpha',
        'characterNames': ['测试角色甲', '测试角色乙'] if index % 2 else ['测试角色甲'],
        'durationMs': None if status == 'pending' else 0,
        'replyCount': 2 if status == 'success' else 0, 'outputCharacters': 150 if status == 'success' else 0,
        'quotaCharged': 1 if status == 'success' else 0,
        'errorCode': 'PROVIDER_UNAVAILABLE' if status == 'error' else None,
        'errorMessage': '模型服务暂时不可用，请稍后重试。' if status == 'error' else None,
        'unexpectedRawBody': 'UI_FIXTURE_BODY_MUST_NOT_RENDER', 'unexpectedApiKey': 'UI_FIXTURE_KEY_MUST_NOT_RENDER',
    })

fixture_status = 200
retention_days = 7


def fixture(route):
    assert route.request.method == 'GET'
    parameters = parse_qs(urlparse(route.request.url).query)
    requested_days = int(parameters.get('days', ['7'])[0])
    days = min(retention_days, requested_days)
    status = parameters.get('status', ['all'])[0]
    query = parameters.get('query', [''])[0]
    page = int(parameters.get('page', ['1'])[0])
    page_size = int(parameters.get('pageSize', ['20'])[0])
    requests.append({'days': requested_days, 'status': status, 'query': query, 'page': page})
    if fixture_status != 200:
        route.fulfill(status=fixture_status, content_type='application/json', body=json.dumps({'error': {'message': '审计读取测试失败', 'code': 'AUDIT_TEST_ERROR'}}))
        return
    items = [entry for entry in records if (status == 'all' or entry['status'] == status) and query.lower() in ' '.join([entry['username'], entry['conversationTitle'], entry['model'], entry['providerName'], entry['id'], *entry['characterNames']]).lower()]
    counts = {key: sum(entry['status'] == key for entry in items) for key in statuses}
    daily = [
        {'date': (now - timedelta(days=2)).strftime('%Y-%m-%d'), 'requests': len(items) // 3, 'success': counts['success'] // 2, 'error': counts['error'] // 2},
        {'date': (now - timedelta(days=1)).strftime('%Y-%m-%d'), 'requests': len(items) // 3, 'success': counts['success'] - counts['success'] // 2, 'error': counts['error'] - counts['error'] // 2},
        {'date': now.strftime('%Y-%m-%d'), 'requests': len(items) - 2 * (len(items) // 3), 'success': 0, 'error': 0},
    ] if items else []
    result = {
        'entries': {'items': items[(page - 1) * page_size:page * page_size], 'total': len(items), 'page': page, 'pageSize': page_size},
        'stats': {'requests': len(items), **counts, 'chargedTurns': counts['success'], 'replies': counts['success'] * 2, 'averageDurationMs': 0, 'daily': daily, 'timeZone': 'UTC'},
        'filters': {'days': days, 'status': status, 'query': query}, 'retentionDays': retention_days,
    }
    route.fulfill(content_type='application/json', body=json.dumps(result, ensure_ascii=False))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(channel='msedge', headless=True)
    try:
        context = browser.new_context(storage_state=str(OUT / 'admin-state.json'), viewport={'width': 1440, 'height': 1000})
        context.route('**/api/**', guard)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        live = context.request.get(BASE + '/api/admin/audit?days=7&status=all&page=1&pageSize=20')
        assert live.ok, live.text()
        live_data = live.json()
        assert {'entries', 'stats', 'filters', 'retentionDays'} <= live_data.keys()
        page.goto(BASE + '/admin?tab=audit', wait_until='networkidle')
        expect(page.get_by_role('heading', name='请求审计', exact=True)).to_be_visible()
        expect(page.locator('.audit-page')).to_have_attribute('aria-busy', 'false')
        expect(page.locator('.audit-page .admin-notice.is-error')).to_have_count(0)
        no_overflow(page)
        page.screenshot(path=str(OUT / 'audit-live-desktop.png'), full_page=True)
        log('The audit tab loads the real authenticated API, UTC chart label, and retained-record metadata.')

        context.route('**/api/admin/audit?*', fixture)
        page.get_by_role('button', name='刷新记录', exact=True).click()
        expect(page.locator('.audit-table tbody tr')).to_have_count(20)
        expect(page.locator('.audit-stat').filter(has=page.get_by_text('平均耗时', exact=True)).locator('strong')).to_have_text('0 ms')
        expect(page.locator('.audit-stat').filter(has=page.get_by_text('请求总数', exact=True)).locator('strong')).to_have_text('21')
        page.screenshot(path=str(OUT / 'audit-desktop.png'), full_page=True)
        page.get_by_role('button', name='下一页请求').click()
        expect(page.locator('.audit-table tbody tr')).to_have_count(1)
        assert requests[-1]['page'] == 2, requests[-1]
        page.get_by_role('button', name='上一页请求').click()
        expect(page.locator('.audit-table tbody tr')).to_have_count(20)
        log('Pagination uses 20 rows and preserves a legitimate 0 ms average.')

        choose(page, '审计请求状态', '失败')
        expected_errors = sum(entry['status'] == 'error' for entry in records)
        expect(page.locator('.audit-table tbody tr')).to_have_count(expected_errors)
        assert all(text == '失败' for text in page.locator('.audit-table .audit-status').all_text_contents())
        page.locator('.audit-table button[aria-label^="查看请求"]').first.click()
        dialog = page.get_by_role('dialog', name='请求详情', exact=True)
        expect(dialog).to_be_visible()
        expect(dialog.get_by_text('模型服务暂时不可用，请稍后重试。', exact=True)).to_be_visible()
        expect(dialog.get_by_text('PROVIDER_UNAVAILABLE', exact=True)).to_be_visible()
        assert 'UI_FIXTURE_BODY_MUST_NOT_RENDER' not in dialog.inner_text()
        assert 'UI_FIXTURE_KEY_MUST_NOT_RENDER' not in dialog.inner_text()
        page.screenshot(path=str(OUT / 'audit-detail-desktop.png'))
        page.keyboard.press('Escape')
        expect(dialog).not_to_be_visible()
        log('Status filters select matching records; details show sanitized metadata without rendering unknown body / key fields.')

        choose(page, '审计请求状态', '全部状态')
        search = page.get_by_role('searchbox', name='搜索请求')
        search.fill('  user-beta  ')
        expect(page.locator('.audit-table tbody tr')).to_have_count(10)
        assert requests[-1]['query'] == 'user-beta', requests[-1]
        search.fill('没有这个角色')
        expect(page.get_by_role('heading', name='暂无匹配的请求', exact=True)).to_be_visible()
        search.fill('')
        expect(page.locator('.audit-table tbody tr')).to_have_count(20)
        choose(page, '审计时间范围', '近 30 天')
        expect(page.locator('.audit-range-note')).to_contain_text('当前仅保留 7 天记录')
        choose(page, '审计时间范围', '近 24 小时')
        assert requests[-1]['days'] == 1, requests[-1]
        fixture_status = 503
        page.get_by_role('button', name='刷新记录', exact=True).click()
        expect(page.locator('.audit-page .admin-notice[role="alert"]')).to_contain_text('审计读取测试失败')
        fixture_status = 200
        page.locator('.audit-page .admin-notice').get_by_role('button', name='重新加载').click()
        expect(page.locator('.audit-page .admin-notice[role="alert"]')).to_have_count(0)
        expect(page.locator('.audit-table tbody tr')).to_have_count(20)
        log('Search trims queries, empty results are clear, retention limits are explained, and failed reads can be retried.')

        page.set_viewport_size({'width': 390, 'height': 844})
        page.wait_for_function("() => { const bar=document.querySelector('.sidebar'); return !bar || (bar.getBoundingClientRect().right <= 0 && getComputedStyle(bar).visibility === 'hidden'); }")
        no_overflow(page)
        page.screenshot(path=str(OUT / 'audit-mobile.png'), full_page=True)
        trigger = page.get_by_role('combobox', name='审计请求状态')
        trigger.click()
        popup = page.locator('[data-pony-select-menu][data-state="open"]')
        expect(popup).to_be_visible()
        page.wait_for_function("() => document.querySelector('[data-pony-select-menu][data-state=open]').getAnimations().every(a => a.playState === 'finished')")
        box = popup.bounding_box()
        assert box and box['x'] >= 10 and box['x'] + box['width'] <= 380, box
        page.screenshot(path=str(OUT / 'audit-filter-mobile.png'))
        page.keyboard.press('Escape')
        page.locator('.audit-table button[aria-label^="查看请求"]').first.click()
        dialog = page.get_by_role('dialog', name='请求详情', exact=True)
        expect(dialog).to_be_visible()
        no_overflow(page)
        page.screenshot(path=str(OUT / 'audit-detail-mobile.png'))
        dialog.get_by_role('button', name='关闭详情', exact=True).click()
        expect(dialog).not_to_be_visible()
        log('Mobile filters, summary cards, scrolling record table, and metadata dialog stay inside the viewport.')
        assert not writes, writes
        assert not errors, errors
        log('No API writes or JavaScript errors; all additional records existed only in browser fixtures.')
        context.close()
    finally:
        browser.close()
