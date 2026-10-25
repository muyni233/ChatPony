'use client';

import Link from 'next/link';
import { useState } from 'react';
import { ChevronRight, MessageCircle, Pin, Plus, Users } from 'lucide-react';
import { useApp } from './app-provider';
import { prefetchConversation } from '@/lib/conversation-cache';
import { Avatar, Badge, Button, EmptyState, Skeleton } from './ui';
import { NewChat } from './new-chat';
import { QuotaCard } from './quota-card';
import { dateLabel } from '@/lib/client';
import { visibleMessage } from '@/lib/display';
import { useToday } from '@/lib/use-today';

function greeting(date: Date | null) {
  if (!date) return '你好';
  const h = date.getHours();
  if (h < 5) return '晚上好';
  if (h < 11) return '早上好';
  if (h < 13) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}

/** Today shows the time, this year shows month and day, older entries add the year. */
function entryDate(value: string, today: Date | null) {
  const date = new Date(value);
  if (today && date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  if (today && date.getFullYear() !== today.getFullYear()) {
    return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' });
  }
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function Dashboard() {
  const { data, loading, openAuth } = useApp();
  const [newChat, setNewChat] = useState<{
    kind: 'private' | 'group';
    character?: string;
  } | null>(null);
  const today = useToday();
  function start(kind: 'private' | 'group', character?: string) {
    if (!data?.user) openAuth();
    else setNewChat({ kind, character });
  }
  const user = data?.user;
  const characters = data?.characters || [];
  const publicCharacters = characters.filter((c) => !c.ownerId);
  const suggested = (publicCharacters.length ? publicCharacters : characters).slice(0, 4);
  const announcements = (data?.announcements || []).slice(0, 3);
  return (
    <div className="dashboard page-enter">
      <header className="home-header">
        <div className="home-header-text">
          <h1>{user ? `${greeting(today)}，${user.name}` : 'ChatPony'}</h1>
          {user ? (
            <p className="home-stats">
              <Link href="/conversations">{data.stats.conversations} 个对话</Link>
              <span>{data.stats.messages} 条消息</span>
              <Link href="/memories">{data.stats.memories} 条记忆</Link>
            </p>
          ) : (
            <p>{data?.settings.siteDescription || 'MLP 主题的 AI 角色对话平台。'}</p>
          )}
        </div>
        {user && (
          <div className="home-actions">
            <Button className="home-action-new" onClick={() => start('private')}>
              <Plus size={16} />
              新建对话
            </Button>
            <Button variant="secondary" onClick={() => start('group')}>
              <Users size={16} />
              新建群聊
            </Button>
          </div>
        )}
      </header>

      <div className="dashboard-columns">
        <div className="dashboard-main-column">
          <section aria-labelledby="recent-title">
            <div className="section-heading">
              <h2 id="recent-title">最近对话</h2>
              {!!data?.conversations.length && (
                <Link href="/conversations" className="card-link">
                  全部
                  <ChevronRight size={15} />
                </Link>
              )}
            </div>
            <div className="ruled-sheet recent-sheet">
              {loading ? (
                <div className="list-skeleton">
                  {[0, 1, 2].map((i) => (
                    <div className="list-skeleton-row" key={i}>
                      <Skeleton width={44} height={30} radius={4} />
                      <span>
                        <Skeleton width="34%" height={12} />
                        <Skeleton width="72%" height={10} />
                      </span>
                    </div>
                  ))}
                </div>
              ) : data?.conversations.length ? (
                <ol className="recent-list">
                  {data.conversations.slice(0, 6).map((c) => {
                    const character = data.characters.find((ch) => ch.id === c.characterIds[0]);
                    return (
                      <li key={c.id}>
                        <Link
                          className="recent-entry"
                          href={`/chat/${c.id}`}
                          onMouseEnter={() => prefetchConversation(data?.user?.id, c.id)}
                          onFocus={() => prefetchConversation(data?.user?.id, c.id)}
                          onTouchStart={() => prefetchConversation(data?.user?.id, c.id)}
                        >
                          <Avatar
                            name={c.kind === 'group' ? '群' : character?.name || c.title}
                            src={c.kind === 'private' ? character?.avatar : undefined}
                            color={character?.color}
                            size="small"
                          />
                          <span className="recent-body">
                            <strong>
                              <span className="recent-title">{c.title}</span>
                              {c.kind === 'group' && <Badge>群聊</Badge>}
                            </strong>
                            <span className="recent-excerpt">
                              {visibleMessage(c.lastMessage, data.settings) || '暂无消息'}
                            </span>
                          </span>
                          <time className="recent-time" dateTime={c.updatedAt}>
                            {entryDate(c.updatedAt, today)}
                          </time>
                        </Link>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <EmptyState
                  compact
                  icon={<MessageCircle size={22} strokeWidth={1.6} />}
                  title={user ? '暂无对话' : '登录后查看对话'}
                  action={
                    user ? (
                      <Button variant="secondary" size="sm" onClick={() => start('private')}>
                        新建对话
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </div>
          </section>

          <section aria-labelledby="suggested-title">
            <div className="section-heading">
              <h2 id="suggested-title">推荐角色</h2>
              <Link href="/characters" className="card-link">
                角色广场
                <ChevronRight size={15} />
              </Link>
            </div>
            {loading ? (
              <div className="suggested-list">
                {[0, 1, 2, 3].map((i) => (
                  <div className="suggested-item" key={i}>
                    <Skeleton width={36} height={36} radius={8} />
                    <span>
                      <Skeleton width="40%" height={12} />
                      <Skeleton width="80%" height={10} />
                    </span>
                  </div>
                ))}
              </div>
            ) : suggested.length ? (
              <ul className="suggested-list">
                {suggested.map((c) => (
                  <li key={c.id} className="suggested-item">
                    <Avatar name={c.name} src={c.avatar} color={c.color} size="small" />
                    <span className="suggested-body">
                      <strong>{c.name}</strong>
                      <span>{c.description || '暂无简介'}</span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => start('private', c.id)}
                      aria-label={`与${c.name}对话`}
                    >
                      对话
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="card">
                <EmptyState
                  compact
                  icon={<Users size={22} strokeWidth={1.6} />}
                  title="暂无角色"
                  action={
                    user?.role === 'admin' ? (
                      <Link className="button button-secondary button-sm" href="/admin">
                        <Plus size={14} />
                        添加角色
                      </Link>
                    ) : undefined
                  }
                />
              </div>
            )}
          </section>
        </div>

        <aside className="dashboard-aside" aria-label="额度与公告">
          {user && <QuotaCard />}
          <section className="card notice-card" aria-labelledby="notice-title">
            <div className="card-heading">
              <h3 id="notice-title">公告</h3>
              {!!announcements.length && (
                <Link href="/announcements" className="card-link" aria-label="查看全部公告">
                  全部
                  <ChevronRight size={15} />
                </Link>
              )}
            </div>
            {announcements.length ? (
              <ul className="notice-list">
                {announcements.map((a) => (
                  <li key={a.id}>
                    <Link href="/announcements" className="notice-item">
                      <span className="notice-title">
                        {a.pinned && <Pin size={12} className="notice-pin" aria-label="置顶" />}
                        {a.title}
                      </span>
                      <time dateTime={a.createdAt}>{dateLabel(a.createdAt)}</time>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="notice-empty">暂无公告</p>
            )}
          </section>
        </aside>
      </div>
      {newChat && (
        <NewChat
          open
          initialKind={newChat.kind}
          initialCharacter={newChat.character}
          onClose={() => setNewChat(null)}
        />
      )}
    </div>
  );
}
