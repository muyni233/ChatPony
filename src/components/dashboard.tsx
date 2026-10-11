'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  BookHeart,
  Check,
  ChevronRight,
  Compass,
  Flower2,
  Heart,
  MessageCircle,
  Pin,
  Plus,
  Sparkles,
  Users,
} from 'lucide-react';
import { useApp } from './app-provider';
import { Avatar, Badge, Button } from './ui';
import { JournalArt } from './journal-art';
import { NewChat } from './new-chat';
import { QuotaCard } from './quota-card';
import { dateLabel } from '@/lib/client';
import { visibleMessage } from '@/lib/display';
import { useToday } from '@/lib/use-today';

export function Dashboard() {
  const { data, openAuth } = useApp();
  const [newChat, setNewChat] = useState<'private' | 'group' | null>(null);
  const date = useToday();
  function start(kind: 'private' | 'group') {
    if (!data?.user) openAuth();
    else setNewChat(kind);
  }
  const announcement = data?.announcements[0];
  return (
    <div className="dashboard page-enter">
      <div className="page-heading">
        <div>
          <span className="eyebrow">
            <span className="tiny-dot" />
            YOUR LITTLE CORNER OF EQUESTRIA
          </span>
          <h1>
            {data?.user
              ? `很高兴，又见到你${data.user.name.length < 9 ? `，${data.user.name}` : ''}。`
              : '很高兴，在这里遇见你。'}
            <span className="heading-spark">✳</span>
          </h1>
          <p>{data?.settings.siteDescription || '放慢一点，和熟悉的朋友，聊些喜欢的事。'}</p>
        </div>
        <div className="date-badge">
          <span>{date?.toLocaleDateString('en', { month: 'short' }).toUpperCase() || '—'}</span>
          <strong>{date?.getDate().toString().padStart(2, '0') || '—'}</strong>
          <small>{date?.toLocaleDateString('zh-CN', { weekday: 'long' }) || '今天'}</small>
        </div>
      </div>
      <section className="welcome-card">
        <div className="welcome-content">
          <span className="welcome-label">
            <Sparkles size={14} />
            一点日常，一点魔法
          </span>
          <h2>
            让故事，
            <br />
            从一句<span className="hand-underline">「你好」</span>开始。
          </h2>
          <p>
            在小马利亚，与你喜爱的角色相遇。
            <br />
            让每一次对话，成为友谊的新篇章。
          </p>
          <Button onClick={() => start('private')}>
            开启一段对话
            <ArrowRight size={17} />
          </Button>
          <span className="welcome-footnote">A new page. A new connection.</span>
        </div>
        <JournalArt />
        <span className="welcome-corner">
          CHAPTER 01 <ArrowDownRight size={17} />
        </span>
      </section>
      <div className="quick-actions">
        <button onClick={() => start('private')}>
          <span className="quick-icon mint">
            <MessageCircle size={21} strokeWidth={1.6} />
          </span>
          <span>
            <strong>和 TA 单独聊聊</strong>
            <small>专属于你们的对话空间</small>
          </span>
          <ArrowUpRight size={18} />
        </button>
        <button onClick={() => start('group')}>
          <span className="quick-icon peach">
            <Users size={21} strokeWidth={1.6} />
          </span>
          <span>
            <strong>邀请朋友，一起聊</strong>
            <small>@ 角色，让更多故事发生</small>
          </span>
          <ArrowUpRight size={18} />
        </button>
        <Link href="/memories">
          <span className="quick-icon lavender">
            <BookHeart size={21} strokeWidth={1.6} />
          </span>
          <span>
            <strong>那些被记住的小事</strong>
            <small>让每一次相遇都不陌生</small>
          </span>
          <ArrowUpRight size={18} />
        </Link>
      </div>
      <div className="dashboard-columns">
        <div className="dashboard-main-column">
          <section className="recent-section">
            <div className="section-heading">
              <h2>
                <MessageCircle size={19} />
                最近的对话<span className="section-subtitle">CONTINUE YOUR STORY</span>
              </h2>
              <Link href="/conversations">
                全部对话
                <ChevronRight size={15} />
              </Link>
            </div>
            {data?.conversations.length ? (
              <div className="paper-card recent-list">
                {data.conversations.slice(0, 3).map((c) => {
                  const character = data.characters.find((ch) => ch.id === c.characterIds[0]);
                  return (
                    <Link className="recent-item" href={`/chat/${c.id}`} key={c.id}>
                      <Avatar
                        name={c.kind === 'group' ? '群' : character?.name || c.title}
                        src={c.kind === 'private' ? character?.avatar : undefined}
                        color={character?.color}
                      />
                      <div>
                        <strong>
                          {c.title}
                          {c.kind === 'group' && <Badge>群聊</Badge>}
                        </strong>
                        <p>
                          {visibleMessage(c.lastMessage, data.settings) ||
                            '故事刚刚开始，打个招呼吧。'}
                        </p>
                      </div>
                      <time>{dateLabel(c.updatedAt)}</time>
                      <ChevronRight size={15} />
                    </Link>
                  );
                })}
              </div>
            ) : (
              <div className="recent-empty paper-card">
                <div className="empty-chat-art">
                  <span />
                  <MessageCircle size={30} strokeWidth={1.1} />
                  <Sparkles size={17} />
                </div>
                <div>
                  <h3>这里，留给你们的第一句话</h3>
                  <p>开启一段对话，之后随时回来继续。</p>
                  <button className="text-button" onClick={() => start('private')}>
                    开始我的第一段对话
                    <ArrowRight size={14} />
                  </button>
                </div>
                <span className="empty-corner-line" />
              </div>
            )}
          </section>
          <section className="characters-section">
            <div className="section-heading">
              <h2>
                <Compass size={19} />
                等待相遇<span className="section-subtitle">MEET YOUR FRIENDS</span>
              </h2>
              <Link href="/characters">
                角色广场
                <ChevronRight size={15} />
              </Link>
            </div>
            {data?.characters.length ? (
              <div className="mini-character-grid">
                {data.characters.slice(0, 3).map((c) => (
                  <Link href="/characters" className="mini-character paper-card" key={c.id}>
                    <Avatar name={c.name} src={c.avatar} color={c.color} size="large" />
                    <h3>{c.name}</h3>
                    <p>{c.description}</p>
                    <span>
                      认识一下
                      <ArrowUpRight size={13} />
                    </span>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="character-coming paper-card">
                <div className="coming-art">
                  <span className="coming-card one">
                    <Flower2 size={27} strokeWidth={1.2} />
                  </span>
                  <span className="coming-card two">
                    <Sparkles size={28} strokeWidth={1.2} />
                  </span>
                  <span className="coming-card three">
                    <Heart size={26} strokeWidth={1.2} />
                  </span>
                </div>
                <h3>下一位朋友，正在路上</h3>
                <p>
                  角色发布后，会在这里与你见面。
                  <br />
                  每一份独特的性格，都值得一场特别的相遇。
                </p>
                {data?.user?.role === 'admin' ? (
                  <Link className="text-button" href="/admin">
                    添加第一位角色
                    <Plus size={14} />
                  </Link>
                ) : (
                  <span className="coming-tag">
                    <span className="tiny-dot" />
                    期待新的相遇
                  </span>
                )}
              </div>
            )}
          </section>
        </div>
        <aside className="dashboard-aside">
          <QuotaCard />
          <section className="notice-card">
            <span className="tape tape-pink" />
            <div className="card-heading">
              <h3>
                <Pin size={17} />
                公告栏
              </h3>
              <Link href="/announcements" aria-label="查看所有公告">
                <ArrowUpRight size={17} />
              </Link>
            </div>
            {announcement ? (
              <>
                <Badge tone={announcement.pinned ? 'pink' : 'green'}>
                  {announcement.pinned ? '置顶公告' : '平台动态'}
                </Badge>
                <h4>{announcement.title}</h4>
                <p>{announcement.content.slice(0, 110)}</p>
                <Link href="/announcements" className="notice-date">
                  {dateLabel(announcement.createdAt)}
                  <ArrowRight size={14} />
                </Link>
              </>
            ) : (
              <>
                <Badge tone="green">一切就绪，等待新故事</Badge>
                <h4>欢迎来到 ChatPony</h4>
                <p>
                  平台动态与更新会在这里发布。
                  <br />
                  现在，先熟悉一下你的新空间吧。
                </p>
                <Link href="/announcements" className="notice-date">
                  查看公告中心
                  <ArrowRight size={14} />
                </Link>
              </>
            )}
          </section>
          <div className="little-note">
            <span className="little-note-star">✧</span>
            <p>
              不必有特别的话题，
              <br />
              你在这里，就很好。
            </p>
            <span>just be yourself.</span>
          </div>
        </aside>
      </div>
      <div className="dashboard-bottom">
        <span>
          <Check size={13} />
          对话与记忆，按账户独立保存
        </span>
        <span>
          <Flower2 size={14} />
          在这里，每个平凡日常都可以有一点魔法
        </span>
      </div>
      {newChat && <NewChat open initialKind={newChat} onClose={() => setNewChat(null)} />}
    </div>
  );
}
