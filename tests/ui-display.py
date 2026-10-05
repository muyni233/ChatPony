"""Display settings and real streaming via a temporary local SSE fixture, never a paid API."""
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

BASE = 'http://127.0.0.1:3210'
OUT = Path('test-results')
CHUNKS = ['†你好，', '<cont', 'rol>很高兴见到你。', '||', '|', '第二个气泡。', '|||', '第三个气泡。']
RAW = ''.join(CHUNKS)


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers.get('Content-Length', '0')))
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream; charset=utf-8')
        self.send_header('Cache-Control', 'no-cache')
        self.end_headers()
        for chunk in CHUNKS:
            self.wfile.write(('data: ' + json.dumps({'choices': [{'delta': {'content': chunk}, 'finish_reason': None}]}) + '\n\n').encode())
            self.wfile.flush()
            time.sleep(.22)
        self.wfile.write(b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        self.wfile.flush()


server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    context = browser.new_context(storage_state=str(OUT / 'admin-state.json'), viewport={'width':1440,'height':1000})
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    request = context.request
    original = request.get(BASE + '/api/admin/settings').json()['settings']
    created = {}

    def mutate(path, data=None, method='POST'):
        response = request.fetch(BASE + path, method=method, data=data, headers={'Origin': BASE, 'Content-Type': 'application/json'})
        assert response.ok, (path, response.status, response.text())
        return response.json()

    try:
        page.goto(BASE + '/admin?tab=settings', wait_until='networkidle')
        page.locator('#site-bubble-separator').fill('|||')
        page.locator('#site-hidden-markers').fill('<control>\n†')
        expect(page.locator('.admin-preview-bubbles p')).to_have_count(2)
        expect(page.locator('.admin-preview-bubbles')).not_to_contain_text('<control>')
        page.locator('.admin-display-preview').screenshot(path=str(OUT / 'display-settings-preview.png'))
        page.get_by_role('button', name='保存站点设置').click()
        expect(page.get_by_role('status')).to_contain_text('设置已保存')
        page.reload(wait_until='networkidle')
        expect(page.locator('#site-hidden-markers')).to_have_value('<control>\n†')
        page.locator('#site-bubble-separator').fill('\\n\\n')
        expect(page.locator('.admin-preview-bubbles p')).to_have_count(2)
        page.locator('#site-bubble-separator').fill('')
        expect(page.locator('.admin-preview-bubbles p')).to_have_count(1)
        print('PASS administrator display settings / persistence / live preview / empty and newline separators', flush=True)

        mutate('/api/admin/settings', {'allowPrivateApiUrls': True}, 'PATCH')
        provider = mutate('/api/admin/providers', {'name':'QA display stream', 'protocol':'openai-chat', 'baseUrl':f'http://127.0.0.1:{server.server_port}/v1', 'apiKey':'local-fixture-only', 'model':'fixture', 'contextWindow':32000, 'maxOutputTokens':2048, 'temperature':.7, 'enabled':True, 'isDefault':False})['provider']
        created['provider'] = provider['id']
        character = mutate('/api/admin/characters', {'name':'气泡显示验证', 'englishName':'', 'subtitle':'仅在隔离数据库中验证', 'description':'用于消息显示回归。', 'personality':'你是本地测试角色。', 'greeting':'†一起聊聊吧。|||先从今天的心情开始。<control>', 'color':'#718d79', 'avatar':'', 'tags':[], 'published':True, 'order':99})['character']
        created['character'] = character['id']
        conversation = mutate('/api/conversations', {'kind':'direct', 'characterIds':[character['id']], 'providerId':provider['id']})['conversation']
        created['conversation'] = conversation['id']
        page.goto(BASE + '/chat/' + conversation['id'], wait_until='networkidle')
        expect(page.locator('.theirs .message-bubble')).to_have_count(2)
        expect(page.locator('.theirs')).not_to_contain_text('<control>')
        user_text = '保留我的|||与<control>符号。'
        page.get_by_role('textbox', name='输入消息').fill(user_text)
        page.get_by_role('button', name='发送消息', exact=True).click()
        expect(page.get_by_role('button', name='停止生成')).to_be_visible()
        # Returning to the tab / refreshing the same session must not abort a reply.
        page.evaluate("window.dispatchEvent(new Event('chatpony:session'))")
        snapshots = []
        deadline = time.monotonic() + 20
        while page.get_by_role('button', name='停止生成').is_visible() and time.monotonic() < deadline:
            snapshots.extend(page.locator('.theirs .message-bubble').all_text_contents())
            page.wait_for_timeout(25)
        expect(page.get_by_role('button', name='停止生成')).not_to_be_visible()
        assert snapshots and all('|' not in text and '<' not in text and '†' not in text for text in snapshots), snapshots
        expect(page.locator('.theirs').last.locator('.message-bubble')).to_have_text(['你好，很高兴见到你。', '第二个气泡。', '第三个气泡。'])
        expect(page.locator('.mine .message-bubble')).to_have_text(user_text)
        saved = request.get(BASE + '/api/conversations/' + conversation['id']).json()['messages']
        assert saved[-1]['content'] == RAW
        page.screenshot(path=str(OUT / 'im-bubbles-desktop.png'), full_page=True)
        with page.expect_download() as exported:
            page.get_by_role('button', name='导出对话').click()
        exported.value.save_as(str(OUT / 'display-export.json'))
        document = json.loads((OUT / 'display-export.json').read_text(encoding='utf-8'))
        assert document['messages'][-1]['bubbles'] == ['你好，很高兴见到你。', '第二个气泡。', '第三个气泡。']
        assert document['messages'][-2]['content'] == user_text
        page.locator('.remember-message').last.click()
        expect(page.get_by_role('dialog').locator('textarea')).to_have_value('你好，很高兴见到你。\n\n第二个气泡。\n\n第三个气泡。')
        page.keyboard.press('Escape')
        page.set_viewport_size({'width':390,'height':844})
        page.wait_for_function("document.querySelector('.sidebar').getBoundingClientRect().right <= 0")
        page.screenshot(path=str(OUT / 'im-bubbles-mobile.png'), full_page=True)
        assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
        assert page.evaluate('document.documentElement.scrollHeight <= innerHeight + 1')
        page.goto(BASE + '/conversations', wait_until='networkidle')
        row = page.locator('.conversation-card').filter(has_text='气泡显示验证')
        expect(row).to_contain_text('你好，很高兴见到你。 · 第二个气泡。 · 第三个气泡。')
        expect(row).not_to_contain_text('<control>')
        assert not errors, errors
        print('PASS real SSE bubbles / no partial marker flashes / unchanged user text and raw history / display export and memory / list preview / mobile', flush=True)
    finally:
        if 'conversation' in created:
            mutate('/api/conversations/' + created['conversation'], method='DELETE')
        for kind in ['character', 'provider']:
            if kind in created:
                mutate('/api/admin/' + kind + 's/' + created[kind], method='DELETE')
        mutate('/api/admin/settings', {key:original[key] for key in ['bubbleSeparator','hiddenOutputMarkers','allowPrivateApiUrls']}, 'PATCH')
        context.close()
        browser.close()
        server.shutdown()
        server.server_close()
