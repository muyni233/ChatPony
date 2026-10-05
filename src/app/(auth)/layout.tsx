import Link from 'next/link';
import { ArrowRight, Sparkles, Star } from 'lucide-react';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-layout">
      <section className="auth-story" aria-label="关于 ChatPony">
        <Link className="auth-brand" href="/login">
          <span className="auth-brand-symbol">
            <Sparkles size={24} strokeWidth={1.6} />
          </span>
          <span>
            ChatPony<small>A LITTLE MAGIC, EVERY DAY.</small>
          </span>
        </Link>
        <div className="auth-story-body">
          <span className="auth-kicker">
            <span /> FRIENDSHIP BEGINS WITH A HELLO
          </span>
          <h2>
            每次对话，
            <br />
            都让故事
            <br />
            <em>靠近一点。</em>
          </h2>
          <p>
            在小马利亚的灵感里相遇。
            <br />
            聊聊日常、展开想象，让友谊在对话中生长。
          </p>
          <div className="auth-paper-note">
            <Star size={19} strokeWidth={1.4} />
            <span>
              每一个被记住的细节，
              <br />
              都是下一段故事的开始。
            </span>
            <span className="auth-note-number">01</span>
          </div>
        </div>
        <div className="auth-story-footer">
          <span>LET THE CONVERSATION BLOOM.</span>
          <Link href="/preview">
            预览 <ArrowRight size={15} />
          </Link>
        </div>
      </section>
      <section className="auth-content">
        {children}
        <footer className="auth-content-footer">
          <span>ChatPony</span>
          <span>为相遇，留一页空白。</span>
          <Link className="auth-mobile-preview" href="/preview">
            预览 <ArrowRight size={12} />
          </Link>
        </footer>
      </section>
    </main>
  );
}
