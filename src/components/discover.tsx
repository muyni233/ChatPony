'use client';
import { Select } from '@/components/select';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowRight,
  ArrowUpRight,
  Bookmark,
  Check,
  Compass,
  Heart,
  MessageCircle,
  Search,
  SlidersHorizontal,
  Sparkles,
  UsersRound,
} from 'lucide-react';
import { api, announceConversationChange } from '@/lib/client';
import { useSession } from './session-provider';
import { CharacterAvatar, Modal, Spinner } from './ui';
import type { Character, Conversation } from '@/lib/types';
import { splitBubbles } from '@/lib/message-display';

export function Discover() {
  const { user, site, bootstrapRequired } = useSession();
  const router = useRouter();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [favoriteRecords, setFavorites] = useState<string[]>([]);
  const favorites = useMemo(() => (user ? favoriteRecords : []), [user, favoriteRecords]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'all' | 'favorites'>('all');
  const [sort, setSort] = useState('default');
  const [detail, setDetail] = useState<Character | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    api<{ characters: Character[] }>('/api/characters')
      .then((data) => {
        if (active) setCharacters(data.characters);
      })
      .catch((error) => {
        if (active) setError(error.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (user)
      api<{ characterIds: string[] }>('/api/favorites')
        .then((data) => setFavorites(data.characterIds))
        .catch(() => {});
  }, [user]);
  const filtered = useMemo(
    () =>
      characters
        .filter(
          (character) =>
            (tab === 'all' || favorites.includes(character.id)) &&
            `${character.name} ${character.englishName} ${character.tags.join(' ')} ${character.description}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') : a.order - b.order,
        ),
    [characters, favorites, query, sort, tab],
  );
  async function start(character: Character) {
    if (!user) {
      router.push('/login');
      return;
    }
    setStarting(character.id);
    setError('');
    try {
      const { conversation } = await api<{ conversation: Conversation }>('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ kind: 'direct', characterIds: [character.id] }),
      });
      announceConversationChange();
      router.push(`/chat/${conversation.id}`);
    } catch (error) {
      setError((error as Error).message);
      setStarting(null);
    }
  }
  async function favorite(id: string) {
    if (!user) {
      router.push('/login');
      return;
    }
    try {
      const exists = favorites.includes(id);
      await api(exists ? `/api/favorites/${id}` : '/api/favorites', {
        method: exists ? 'DELETE' : 'POST',
        ...(exists ? {} : { body: JSON.stringify({ characterId: id }) }),
      });
      setFavorites((value) => (exists ? value.filter((item) => item !== id) : [...value, id]));
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <div className="discover-page page-enter">
      <div className="discovery-heading">
        <div className="eyebrow">
          <span className="tiny-cross">✦</span> A PLACE TO MEET, A WORLD TO IMAGINE
        </div>
        <span className="issue-number">
          VOL. 01 <span>—</span> FRIENDSHIP IS MAGIC
        </span>
      </div>
      <section className="welcome-paper">
        <div className="hero-copy">
          <div className="hero-label">
            <span /> 欢迎来到 {site?.name || 'ChatPony'}
          </div>
          <h1>
            每一次相遇，
            <br />
            都是
            <span className="underlined-word">
              故事的开始
              <svg viewBox="0 0 300 16" preserveAspectRatio="none" aria-hidden="true">
                <path
                  d="M3 11c68-10 158-12 292-5M8 15c82-8 189-10 264-3"
                  stroke="currentColor"
                  strokeWidth="2"
                  fill="none"
                />
              </svg>
            </span>
            。
          </h1>
          <p>
            {site?.description || '在小马利亚的一隅，与熟悉的灵魂相遇。'}
            <br />
            聊聊今天的心情，或一起去往想象中的远方。
          </p>
          <a href="#characters" className="hero-link">
            寻找你的对话伙伴 <ArrowRight size={18} />
          </a>
          <div className="hero-footnote">
            <span className="little-star">✳</span> 为每一种天马行空，留一个位置。
          </div>
        </div>
        <div className="hero-art" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <span className="art-spark spark-one">✧</span>
          <span className="art-spark spark-two">✦</span>
          <span className="art-spark spark-three">✳</span>
          <div className="postcard-back" />
          <div className="postcard">
            <div className="paper-tape" />
            <div className="postcard-top">
              <span>A NOTE FOR YOU</span>
              <span className="postage-stamp">
                CP<span>✦</span>
              </span>
            </div>
            <p>
              Good stories
              <br />
              begin with
              <br />
              <em>a little hello.</em>
            </p>
            <div className="postcard-bottom">
              <span className="postcard-line" />
              <Heart size={19} strokeWidth={1.2} />
              <span className="postcard-line" />
            </div>
            <span className="postcard-signature">With love, ChatPony</span>
          </div>
          <div className="art-caption">
            <span>↖</span> 下一段故事，等你开启
          </div>
        </div>
      </section>
      <div className="section-heading" id="characters">
        <div>
          <span className="eyebrow">MEET YOUR COMPANIONS</span>
          <h2>
            遇见，新的朋友 <span className="heading-spark">✧</span>
          </h2>
        </div>
        <div className="section-meta">
          {characters.length
            ? `${characters.length} 位角色，${characters.length} 种可能`
            : '每一段好故事，都从认识彼此开始'}
        </div>
      </div>
      <div className="character-toolbar">
        <div className="tabs" role="tablist" aria-label="角色分类">
          <button
            role="tab"
            aria-selected={tab === 'all'}
            className={tab === 'all' ? 'selected' : ''}
            onClick={() => setTab('all')}
          >
            <Compass size={15} />
            全部角色 <span>{characters.length}</span>
          </button>
          <button
            role="tab"
            aria-selected={tab === 'favorites'}
            className={tab === 'favorites' ? 'selected' : ''}
            onClick={() => setTab('favorites')}
          >
            <Heart size={15} />
            我的收藏{favorites.length > 0 && <span>{favorites.length}</span>}
          </button>
        </div>
        <div className="filter-controls">
          <label className="search-input">
            <Search size={16} />
            <input
              aria-label="搜索角色"
              placeholder="寻找名字、性格或关键词"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="sort-select">
            <SlidersHorizontal size={15} />
            <Select
              aria-label="角色排序"
              value={sort}
              onValueChange={setSort}
              variant="minimal"
              align="end"
            >
              <option value="default">推荐排序</option>
              <option value="name">姓名排序</option>
            </Select>
          </label>
        </div>
      </div>
      {error && (
        <div className="error-message" role="alert">
          {error}
        </div>
      )}
      {loading ? (
        <Spinner label="正在寻找对话伙伴…" />
      ) : filtered.length ? (
        <div className="character-grid">
          {filtered.map((character, index) => (
            <article
              key={character.id}
              className="character-card"
              style={
                {
                  '--character-color': character.color,
                  '--card-delay': `${index * 50}ms`,
                } as React.CSSProperties
              }
            >
              <div className="character-card-top">
                <CharacterAvatar character={character} size="large" />
                <button
                  className={`icon-button favorite-button ${favorites.includes(character.id) ? 'is-favorite' : ''}`}
                  aria-label={`${favorites.includes(character.id) ? '取消收藏' : '收藏'}${character.name}`}
                  onClick={() => void favorite(character.id)}
                >
                  <Heart
                    size={18}
                    fill={favorites.includes(character.id) ? 'currentColor' : 'none'}
                  />
                </button>
              </div>
              <span className="character-english">{character.englishName || 'YOUR COMPANION'}</span>
              <button className="character-name" onClick={() => setDetail(character)}>
                {character.name}
                <ArrowUpRight size={15} />
              </button>
              <p className="character-subtitle">{character.subtitle}</p>
              <p className="character-description">{character.description}</p>
              <div className="character-tags">
                {character.tags.slice(0, 3).map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
              <button
                className="character-chat-button"
                disabled={starting !== null}
                onClick={() => void start(character)}
              >
                <MessageCircle size={15} />
                {starting === character.id ? '正在开启…' : '开始对话'}
                <ArrowRight size={16} />
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="characters-empty">
          <div className="empty-notecard">
            <MessageCircle size={29} strokeWidth={1.2} />
            <span className="empty-mini-spark">✧</span>
          </div>
          <h3>
            {query
              ? '还没有找到这位朋友'
              : tab === 'favorites'
                ? '把喜欢的角色，留在这里'
                : '新朋友，正在等待登场'}
          </h3>
          <p>
            {query
              ? '试试其他名字或关键词。'
              : tab === 'favorites'
                ? '点击角色旁的爱心，下次见面就更方便了。'
                : '管理员发布角色后，就可以在这里认识他们、开始对话。'}
          </p>
          {user?.role === 'admin' && !query && tab === 'all' ? (
            <Link href="/admin?tab=characters" className="button button-secondary">
              配置第一个角色 <ArrowUpRight size={15} />
            </Link>
          ) : !user && !query && tab === 'all' ? (
            <Link href="/register" className="empty-link">
              {bootstrapRequired ? '创建管理员账号' : '先创建一个账号'} <ArrowRight size={15} />
            </Link>
          ) : query ? (
            <button className="empty-link" onClick={() => setQuery('')}>
              清除搜索 <ArrowRight size={15} />
            </button>
          ) : null}
          <span className="empty-page-number">— 01 —</span>
        </div>
      )}
      <div className="discovery-bottom">
        <Link href="/groups" className="feature-strip">
          <div className="feature-icon terracotta">
            <UsersRound size={22} strokeWidth={1.4} />
          </div>
          <div>
            <span className="eyebrow">MORE FRIENDS, MORE POSSIBILITIES</span>
            <h3>好故事，也可以一起发生。</h3>
            <p>邀请多位角色，开启属于你们的群聊场景。</p>
          </div>
          <span className="feature-arrow">
            <ArrowUpRight size={21} />
          </span>
        </Link>
        <Link href="/memories" className="feature-strip memory-feature">
          <div className="feature-icon sage">
            <Bookmark size={21} strokeWidth={1.4} />
          </div>
          <div>
            <span className="eyebrow">LITTLE THINGS THAT MATTER</span>
            <h3>每一点记忆，都算数。</h3>
            <p>让重要的偏好与约定，延续到下一次对话。</p>
          </div>
          <span className="feature-arrow">
            <ArrowUpRight size={21} />
          </span>
        </Link>
      </div>
      {detail && (
        <Modal title={detail.name} onClose={() => setDetail(null)}>
          <div className="character-detail">
            <CharacterAvatar character={detail} size="large" />
            <span className="eyebrow">{detail.englishName}</span>
            <p className="serif detail-subtitle">{detail.subtitle}</p>
            <p>{detail.description}</p>
            <div className="character-tags">
              {detail.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
            {detail.greeting && (
              <blockquote>
                <Sparkles size={17} />
                {splitBubbles(
                  detail.greeting,
                  site?.bubbleSeparator,
                  site?.hiddenOutputMarkers,
                ).join('\n\n')}
              </blockquote>
            )}
            <button
              className="button button-primary full-width"
              disabled={starting !== null}
              onClick={() => void start(detail)}
            >
              {starting ? '正在开启…' : '和 TA 聊聊'}
              <ArrowRight size={17} />
            </button>
            <span className="small muted">
              <Check size={12} /> 对话与记忆仅对你的账号可见
            </span>
          </div>
        </Modal>
      )}
    </div>
  );
}
