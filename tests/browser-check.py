"""Real-browser integration against an isolated ChatPony server and local mock model.

Run: python tests/browser-check.py --url http://localhost:3217
Requires test-results/admin-credentials.json with email/password for that test DB.
No external model calls. Test records live only in the explicitly supplied server.
"""
import argparse
import json
import math
import os
import re
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect


parser = argparse.ArgumentParser()
parser.add_argument('--url', required=True)
args = parser.parse_args()
base = args.url.rstrip('/')
if not re.fullmatch(r'http://(?:localhost|127\.0\.0\.1):\d+', base):
    raise RuntimeError('Use an explicitly isolated local test server.')
credentials = ({'email': os.environ['CHATPONY_E2E_ADMIN_EMAIL'], 'password': os.environ['CHATPONY_E2E_ADMIN_PASSWORD']}
               if os.environ.get('CHATPONY_E2E_ADMIN_EMAIL') and os.environ.get('CHATPONY_E2E_ADMIN_PASSWORD')
               else json.loads(Path('test-results/admin-credentials.json').read_text(encoding='utf-8-sig')))
suffix = uuid.uuid4().hex[:7]
slug_a, slug_b = f'willow-{suffix}', f'ember-{suffix}'
requests = []


class ModelServer(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
        requests.append({'path': self.path, 'body': body})
        if self.path.endswith('/embeddings'):
            inputs = body.get('input', '')
            texts = inputs if isinstance(inputs, list) else [inputs]
            values = []
            for i, text in enumerate(texts):
                tea = bool(re.search(r'茶|tea', str(text), re.I))
                values.append({'index': i, 'embedding': [1.0, 0.0, 0.0] if tea else [0.0, 1.0, 0.0]})
            result = {'data': values, 'model': body.get('model')}
        elif self.path.endswith(':embedContent'):
            text = json.dumps(body.get('content'), ensure_ascii=False)
            result = {'embedding': {'values': [1.0, 0.0, 0.0] if '茶' in text else [0.0, 1.0, 0.0]}}
        elif self.path.endswith(':batchEmbedContents'):
            result = {'embeddings': [{'values': [1.0, 0.0, 0.0] if '茶' in json.dumps(item.get('content'), ensure_ascii=False) else [0.0, 1.0, 0.0]} for item in body.get('requests', [])]}
        else:
            messages = body.get('messages', [])
            last = str(messages[-1].get('content', '')) if messages else ''
            if 'force-error' in last:
                self.send_response(503)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"error":{"message":"mock upstream unavailable"}}')
                return
            system = str(messages[0].get('content', '')) if messages else ''
            target = slug_b if 'E2E Willow' in system.split('角色设定：')[0] else slug_a
            result = {'choices': [{'message': {'content': f'*这是本地测试模型的回复。*||| @{target} 你也来分享吧。'}, 'finish_reason': 'stop'}]}
        payload = json.dumps(result, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


mock = ThreadingHTTPServer(('127.0.0.1', 0), ModelServer)
threading.Thread(target=mock.serve_forever, daemon=True).start()
model_url = f'http://127.0.0.1:{mock.server_port}/v1'
errors = []
provider_ids = []
supplier_ids = []
character_ids = []


def api(context, path, method='GET', body=None):
    response = context.request.fetch(base + '/api' + path, method=method, data=body,
                                     headers={'Content-Type': 'application/json'}, timeout=60000)
    result = response.json()
    assert response.ok, (path, response.status, result)
    return result['data']


with sync_playwright() as p:
    bundled = Path('C:/Users/Server/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe')
    executable = os.environ.get('CHATPONY_CHROMIUM') or (str(bundled) if bundled.exists() else None)
    browser = p.chromium.launch(headless=True, **({'executable_path': executable} if executable else {}))
    admin = browser.new_context()
    api(admin, '/auth/login', 'POST', {'email': credentials['email'], 'password': credentials['password']})
    old_embedding = api(admin, '/admin/embeddings')
    old_settings = api(admin, '/admin/settings')
    try:
        api(admin, '/admin/settings', 'PATCH', {'bubbleDelimiter': '|||', 'hiddenSymbols': ['*'], 'memorySummaryInterval': 1, 'memorySummaryModelId': '', 'automaticMemoryEnabled': True})
        supplier = api(admin, '/admin/suppliers', 'POST', {
            'name': 'Browser supplier ' + suffix, 'protocol': 'openai-completions', 'baseUrl': model_url, 'apiKey': '', 'active': True,
        })
        supplier_ids.append(supplier['id'])
        provider = api(admin, '/admin/models', 'POST', {
            'name': 'Browser mock ' + suffix, 'kind': 'language', 'supplierId': supplier['id'],
            'model': 'e2e-chat', 'active': True, 'contextWindow': 32768,
            'maxOutput': 1024, 'temperature': None,
        })
        provider_ids.append(provider['id'])
        embedding = api(admin, '/admin/models', 'POST', {'name': 'Browser embedding ' + suffix,
            'kind': 'embedding', 'supplierId': supplier['id'], 'model': 'e2e-embedding', 'active': True})
        provider_ids.append(embedding['id'])
        for name, slug in [('E2E Willow', slug_a), ('E2E Ember', slug_b)]:
            char = api(admin, '/admin/characters', 'POST', {
                'name': name, 'slug': slug, 'description': '浏览器自动化验证专用角色',
                'personality': f'你是{name}，用于本地集成测试。', 'greeting': '',
                'avatar': '', 'color': '#dce8d1', 'tags': ['测试'], 'providerId': provider['id'], 'active': True,
            })
            character_ids.append(char['id'])
        api(admin, '/admin/embeddings', 'PATCH', {'enabled': True, 'modelId': embedding['id'], 'topK': 6, 'minSimilarity': 0.3})
        api(admin, '/admin/embeddings/test', 'POST', {})
        context = browser.new_context(viewport={'width': 1440, 'height': 1000})
        # Exercise the same fallbacks needed on non-HTTPS local network addresses.
        context.add_init_script("Object.defineProperty(crypto, 'randomUUID', {value: undefined, configurable: true}); Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true});")
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(base, wait_until='networkidle')
        page.get_by_role('button', name='登录 / 注册', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_role('button', name='注册账户', exact=True).click()
        dialog.get_by_label('昵称', exact=True).fill('浏览器测试用户')
        dialog.get_by_label('邮箱', exact=True).fill(f'browser-{suffix}@example.test')
        dialog.get_by_label('密码', exact=True).fill('Test-only-Password-2026!')
        dialog.get_by_role('button', name='创建账户', exact=True).click()
        expect(dialog).not_to_be_visible(timeout=15000)
        page.get_by_role('button', name=re.compile('开启新对话')).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_role('button', name=re.compile(f'E2E Willow.*{slug_a}')).click()
        dialog.get_by_role('button', name='开始对话', exact=True).click()
        page.wait_for_url('**/chat/**')
        page.get_by_label('消息内容').fill('你好，我喜欢喝红茶。')
        page.get_by_role('button', name='发送', exact=True).click()
        expect(page.locator('.message-assistant')).to_have_count(1, timeout=45000)
        expect(page.locator('.message-assistant .message-bubble')).to_have_count(2)
        assert '*' not in page.locator('.message-assistant').inner_text()
        assert '|||' not in page.locator('.message-assistant').inner_text()
        expect(page.get_by_role('button', name='发送', exact=True)).to_be_visible(timeout=30000)
        assert api(context, '/quota')['fiveHour']['used'] == 1
        page.screenshot(path='test-results/chat-desktop.png', full_page=True)
        page.locator('.message-assistant').get_by_role('button', name='复制消息').click()
        expect(page.get_by_role('status').filter(has_text='消息已复制。')).to_be_visible()
        private_id = page.url.rsplit('/', 1)[-1]
        # Vectors are persisted and semantically indexed through real HTTP mocks.
        memories = api(context, '/memories')
        assert memories, 'Successful exchanges should produce episode memories.'
        assert any(m.get('vectorStatus') == 'ready' for m in memories), memories
        # Reload verifies persistence, and export exercises a real browser download.
        page.reload(wait_until='networkidle')
        expect(page.locator('.message-assistant')).to_have_count(1)
        with page.expect_download() as download:
            page.get_by_role('button', name='导出对话').click()
        assert download.value.suggested_filename.endswith('.md')
        # Failed upstream call must preserve user message, never add an AI response or quota.
        page.get_by_label('消息内容').fill('force-error')
        page.get_by_role('button', name='发送', exact=True).click()
        expect(page.locator('.chat-error')).to_be_visible(timeout=30000)
        expect(page.get_by_role('button', name='重新生成', exact=True)).to_be_visible(timeout=30000)
        assert api(context, '/quota')['fiveHour']['used'] == 1
        saved_messages = api(context, f'/conversations/{private_id}')['messages']
        assert len(saved_messages) == 3
        assert '*这是' in saved_messages[1]['content'] and '|||' in saved_messages[1]['content']
        # Group without mentions adds only a user message, then a bounded @ chain runs.
        group = api(context, '/conversations', 'POST', {'kind': 'group', 'title': '浏览器群聊测试',
                                                     'characterIds': character_ids, 'maxRounds': 3})
        page.goto(base + '/chat/' + group['id'], wait_until='networkidle')
        page.get_by_label('消息内容').fill('先记下今天的计划。')
        page.get_by_role('button', name='发送', exact=True).click()
        expect(page.locator('.message-user')).to_have_count(1)
        expect(page.get_by_role('button', name='发送', exact=True)).to_be_visible(timeout=30000)
        assert len(api(context, '/conversations/' + group['id'])['messages']) == 1
        page.get_by_label('消息内容').fill('@' + slug_a + ' 大家一起聊聊吧。')
        page.get_by_role('button', name='发送', exact=True).click()
        expect(page.locator('.message-assistant')).to_have_count(3, timeout=45000)
        expect(page.get_by_role('button', name='发送', exact=True)).to_be_visible(timeout=30000)
        assert api(context, '/quota')['fiveHour']['used'] == 4
        # Gemini native embedding protocol through the same actual server adapter.
        gemini_supplier = api(admin, '/admin/suppliers', 'POST', {'name': 'Gemini test '+suffix,
            'protocol':'gemini','baseUrl':model_url.replace('/v1','/v1beta'),'apiKey':'','active':True})
        supplier_ids.append(gemini_supplier['id'])
        gemini_embedding = api(admin, '/admin/models', 'POST', {'name': 'Gemini embedding '+suffix,
            'supplierId':gemini_supplier['id'],'model':'gemini-embedding-fixture','kind':'embedding','active':True})
        provider_ids.append(gemini_embedding['id'])
        api(admin, '/admin/embeddings', 'PATCH', {'enabled': True, 'modelId':gemini_embedding['id'],'topK': 6, 'minSimilarity': 0.3})
        api(admin, '/admin/embeddings/test', 'POST', {})
        indexed = api(context, '/memories/reindex', 'POST', {})
        assert indexed['indexed'] > 0 and indexed['failed'] == 0, indexed
        assert any(r['path'].endswith(':batchEmbedContents') for r in requests)
        for req in requests:
            if req['path'].endswith((':embedContent', ':batchEmbedContents')):
                assert 'generationConfig' not in json.dumps(req['body'])
        page.goto(base + '/memories', wait_until='networkidle')
        expect(page.get_by_text('已建立向量索引').first).to_be_visible()
        page.screenshot(path='test-results/memories-desktop.png', full_page=True)
        # Mobile nav, layouts, focus trap, and OS motion preference.
        mobile = browser.new_context(viewport={'width': 390, 'height': 844}, is_mobile=True,
                                     has_touch=True, reduced_motion='reduce')
        mobile_page = mobile.new_page()
        mobile_page.on('pageerror', lambda error: errors.append(str(error)))
        mobile_page.goto(base, wait_until='networkidle')
        assert mobile_page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile horizontal overflow'
        mobile_page.screenshot(path='test-results/home-mobile.png', full_page=True)
        mobile_page.get_by_role('button', name='打开导航', exact=True).click()
        expect(mobile_page.locator('.sidebar')).to_have_class(re.compile('sidebar-open'))
        mobile_page.get_by_role('navigation', name='主导航').get_by_role('link', name='角色广场', exact=True).click()
        expect(mobile_page.get_by_role('heading', name='角色广场', exact=True)).to_be_visible()
        assert mobile_page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        mobile.close()
        assert not errors, errors
        print(json.dumps({'ok': True, 'browser_errors': errors, 'checks': [
            'registration', 'private chat', 'persistence', 'download', 'failure refund',
            'unmentioned group', 'bounded group chain', 'vector memory', 'Gemini embedding',
            'bubble segmentation', 'display symbol stripping', 'original message preservation',
            'mobile nav', 'reduced motion', 'no horizontal overflow'], 'mock_requests': len(requests)}, ensure_ascii=True))
        context.close()
    finally:
        for char_id in character_ids:
            api(admin, '/admin/characters/' + char_id, 'DELETE')
        for provider_id in provider_ids:
            api(admin, '/admin/models/' + provider_id, 'DELETE')
        for supplier_id in supplier_ids:
            api(admin, '/admin/suppliers/' + supplier_id, 'DELETE')
        api(admin, '/admin/embeddings', 'PATCH', {key:old_embedding[key] for key in ['enabled','modelId','topK','minSimilarity']})
        api(admin, '/admin/settings', 'PATCH', {key:old_settings[key] for key in ['bubbleDelimiter','hiddenSymbols','memorySummaryInterval','memorySummaryModelId','automaticMemoryEnabled']})
        admin.close()
        browser.close()
        mock.shutdown()
