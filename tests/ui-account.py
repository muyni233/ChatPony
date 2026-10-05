"""Normal account lifecycle, management permissions, and auth error UI QA.

Requires the dedicated QA database initialized by ui-admin.py. No external
email or model requests are made. The temporary normal user is deleted.
"""

import json
from pathlib import Path
import secrets

from playwright.sync_api import expect, sync_playwright

OUT = Path('test-results')
ADMIN = json.loads((OUT / 'admin-credentials.json').read_text(encoding='utf-8'))
BASE = ADMIN['url']
USER = {'email': f'qa-user-{secrets.token_hex(3)}@example.test', 'password': 'QaUser!' + secrets.token_urlsafe(18)}


def login(page, email, password):
    page.goto(BASE + '/login')
    page.wait_for_load_state('networkidle')
    page.get_by_label('邮箱地址').fill(email)
    page.locator('#password').fill(password)
    page.get_by_role('button', name='登录 ChatPony').click()


def choose_option(page, trigger, label):
    trigger.click()
    page.get_by_role('option', name=label, exact=True).click()


with sync_playwright() as p:
    browser = p.chromium.launch(channel='msedge', headless=True)
    admin_context = browser.new_context(storage_state=str(OUT / 'admin-state.json'), viewport={'width': 1440, 'height': 1000})
    admin = admin_context.new_page()
    user_context = browser.new_context(viewport={'width': 1440, 'height': 1000})
    user = user_context.new_page()
    errors = []
    admin.on('pageerror', lambda error: errors.append(str(error)))
    user.on('pageerror', lambda error: errors.append(str(error)))

    user.goto(BASE + '/register')
    user.wait_for_load_state('networkidle')
    expect(user.get_by_role('heading', name='从这里，开启对话')).to_be_visible()
    user.get_by_label('你的昵称').fill('QA普通用户')
    user.get_by_label('邮箱地址').fill(USER['email'])
    user.locator('#password').fill(USER['password'])
    user.locator('#confirmPassword').fill(USER['password'])
    user.get_by_role('button', name='创建账户', exact=True).click()
    user.wait_for_url(BASE + '/')
    session = user_context.request.get(BASE + '/api/session').json()
    assert session['user']['role'] == 'user'
    user.goto(BASE + '/admin')
    expect(user.get_by_role('heading', name='这里需要管理员权限')).to_be_visible()
    assert user_context.request.get(BASE + '/api/admin/users').status == 403
    print('PASS ordinary registration, admin UI gate and server authorization', flush=True)

    admin.goto(BASE + '/admin?tab=users')
    expect(admin.get_by_role('heading', name='平台用户', exact=False)).to_be_visible()
    row = admin.get_by_role('row').filter(has_text=USER['email'])
    choose_option(admin, row.get_by_role('combobox'), '管理员')
    expect(admin.locator('.admin-notice')).to_contain_text('用户权限已更新')
    expect(row.get_by_role('combobox')).to_contain_text('管理员')
    choose_option(admin, row.get_by_role('combobox'), '普通用户')
    expect(row.get_by_role('combobox')).to_contain_text('普通用户')
    row.get_by_role('button', name='停用', exact=True).click()
    expect(row.get_by_text('已停用', exact=True)).to_be_visible()
    login(user, USER['email'], USER['password'])
    expect(user.locator('.error-message[role="alert"]')).to_be_visible()
    row.get_by_role('button', name='启用', exact=True).click()
    expect(row.get_by_text('正常', exact=True)).to_be_visible()
    login(user, USER['email'], USER['password'])
    user.wait_for_url(BASE + '/')
    own_row = admin.get_by_role('row').filter(has_text=ADMIN['email'])
    expect(own_row.get_by_role('combobox')).to_be_disabled()
    expect(own_row.get_by_role('button', name='停用', exact=True)).to_be_disabled()
    admin.screenshot(path=str(OUT / 'admin-users.png'), full_page=True)
    print('PASS promote/demote, disable/re-enable, own-admin protections', flush=True)

    user.goto(BASE + '/settings')
    user.locator('#settings-username').fill('QA资料已更新')
    user.get_by_role('button', name='保存昵称', exact=True).click()
    expect(user.locator('.success-message')).to_contain_text('昵称已保存')
    old_state = user_context.storage_state()
    new_password = 'QaChanged!' + secrets.token_urlsafe(18)
    user.locator('#current-password').fill(USER['password'])
    user.locator('#new-password').fill(new_password)
    user.locator('#confirm-new-password').fill(new_password)
    user.get_by_role('button', name='更新密码', exact=True).click()
    expect(user.locator('.success-message')).to_contain_text('密码已更新')
    stale = browser.new_context(storage_state=old_state)
    assert stale.request.get(BASE + '/api/session').json()['user'] is None
    stale.close()
    user.get_by_role('button', name='退出登录', exact=True).click()
    user.wait_for_url('**/login')
    login(user, USER['email'], USER['password'])
    expect(user.locator('.error-message[role="alert"]')).to_be_visible()
    login(user, USER['email'], new_password)
    user.wait_for_url(BASE + '/')
    USER['password'] = new_password
    print('PASS password update, old sessions revoked, old password rejected, new password works', flush=True)

    user.goto(BASE + '/settings')
    user.locator('#settings-email').fill('changed@example.test')
    user.locator('#email-password').fill('wrong-password')
    user.get_by_role('button', name='更新邮箱', exact=True).click()
    expect(user.locator('.error-message[role="alert"]')).to_be_visible()
    user.get_by_text('注销账户', exact=True).click()
    user.get_by_role('button', name='申请注销', exact=True).click()
    dialog = user.get_by_role('dialog')
    expect(dialog).to_be_visible()
    user.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    user.get_by_role('button', name='申请注销', exact=True).click()
    dialog.get_by_role('button', name='保留账户', exact=True).click()
    expect(dialog).not_to_be_visible()
    user.get_by_role('button', name='申请注销', exact=True).click()
    dialog.locator('#delete-password').fill('wrong-password')
    dialog.get_by_role('button', name='永久注销账户', exact=True).click()
    expect(dialog.locator('.error-message')).to_be_visible()
    dialog.locator('#delete-password').fill(USER['password'])
    dialog.get_by_role('button', name='永久注销账户', exact=True).click()
    user.wait_for_url('**/login')
    assert user_context.request.get(BASE + '/api/session').json()['user'] is None
    print('PASS email-change password validation, dialog Escape/cancel, deletion requires password and clears account', flush=True)

    user.goto(BASE + '/forgot-password')
    user.get_by_label('邮箱地址').fill('unregistered@example.test')
    user.get_by_role('button', name='发送重置邮件').click()
    expect(user.locator('.error-message')).to_contain_text('邮件')
    user.goto(BASE + '/reset-password?token=invalid')
    user.locator('#password').fill('QaReset!123456789')
    user.locator('#confirmPassword').fill('QaReset!123456789')
    user.get_by_role('button', name='重置密码', exact=True).click()
    expect(user.locator('.error-message')).to_be_visible()
    user.goto(BASE + '/verify-email?token=invalid')
    user.get_by_role('button', name='确认并验证邮箱').click()
    expect(user.locator('.error-message')).to_be_visible()
    user.goto(BASE + '/login')
    user.wait_for_load_state('networkidle')
    user.screenshot(path=str(OUT / 'login-desktop.png'), full_page=True)
    user.set_viewport_size({'width': 390, 'height': 844})
    user.screenshot(path=str(OUT / 'login-mobile.png'), full_page=True)
    assert user.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    print('PASS unconfigured mail feedback, invalid reset/verify token feedback, login desktop/mobile', flush=True)

    admin.goto(BASE + '/admin?tab=providers')
    admin.get_by_role('button', name='添加接口', exact=True).click()
    dialog = admin.get_by_role('dialog')
    expect(dialog).to_be_visible()
    admin.screenshot(path=str(OUT / 'provider-dialog-desktop.png'), full_page=False)
    dialog.get_by_role('button', name='取消', exact=True).click()
    expect(dialog).not_to_be_visible()
    admin.set_viewport_size({'width': 390, 'height': 844})
    admin.get_by_role('button', name='添加接口', exact=True).click()
    expect(dialog).to_be_visible()
    admin.screenshot(path=str(OUT / 'provider-dialog-mobile.png'), full_page=False)
    assert admin.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    dialog.locator('#provider-temp').scroll_into_view_if_needed()
    admin.screenshot(path=str(OUT / 'provider-dialog-mobile-bottom.png'), full_page=False)
    admin.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    admin.emulate_media(reduced_motion='reduce')
    admin.get_by_role('button', name='添加接口', exact=True).click()
    expect(dialog).to_be_visible()
    assert dialog.evaluate('(el) => el.getAnimations().length') == 0
    admin.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    print('PASS polished modal desktop/mobile, cancel/Escape, reduced-motion behavior', flush=True)
    assert not errors, errors
    print('PASS no uncaught browser exceptions', flush=True)
    browser.close()
