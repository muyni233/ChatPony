import { Asterisk, Heart, Sparkles, Star } from 'lucide-react';

export function JournalArt() {
  return (
    <div className="journal-art" aria-hidden="true">
      <div className="art-orbit" />
      <span className="art-twinkle art-twinkle-one">✳</span>
      <Sparkles className="art-twinkle-two" size={26} strokeWidth={1.2} />
      <div className="art-postcard">
        <span className="postcard-lines" />
        <div className="postcard-stamp">
          <svg viewBox="0 0 66 84" width="33" height="42" aria-hidden="true">
            <path
              d="m33 8 7.4 15 16.6 2.4-12 11.7 2.8 16.5L33 45.8l-14.8 7.8L21 37.1 9 25.4 25.6 23Z"
              fill="currentColor"
            />
            <text
              x="33"
              y="73"
              textAnchor="middle"
              fontFamily="Georgia, serif"
              fontSize="12"
              textLength="48"
              lengthAdjust="spacingAndGlyphs"
              fill="currentColor"
            >
              EQUESTRIA
            </text>
          </svg>
        </div>
        <span className="postcard-handwriting">Dear friend,</span>
        <span className="postcard-scribble" />
        <span className="postcard-scribble short" />
        <span className="postcard-scribble" />
        <Heart size={15} className="postcard-heart" />
      </div>
      <div className="art-envelope">
        <div className="envelope-fold" />
        <div className="envelope-seal">
          <Asterisk size={23} strokeWidth={1.6} />
        </div>
      </div>
      <div className="art-stamp-circle">
        <svg viewBox="0 0 176 176" width="88" height="88" aria-hidden="true">
          <text
            x="88"
            y="57"
            textAnchor="middle"
            fontFamily="Georgia, serif"
            fontSize="14"
            textLength="124"
            lengthAdjust="spacingAndGlyphs"
            fill="currentColor"
          >
            PONYVILLE POST
          </text>
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="2.8"
            strokeLinejoin="round"
            strokeLinecap="round"
          >
            <path d="M88 69 93 82 106 87 93 92 88 105 83 92 70 87 83 82Z" />
            <path d="M109 65v13m-6.5-6.5h13M66 103v9m-4.5-4.5h9" />
          </g>
          <text
            x="88"
            y="128"
            textAnchor="middle"
            fontFamily="Georgia, serif"
            fontSize="12"
            textLength="82"
            lengthAdjust="spacingAndGlyphs"
            fill="currentColor"
          >
            WITH LOVE
          </text>
        </svg>
      </div>
      <div className="rainbow-sticker">
        <span />
        <span />
        <span />
        <span />
      </div>
      <Star className="art-star" size={41} fill="#e9c979" stroke="#cdb15f" strokeWidth={1} />
      <span className="art-caption">a letter to a new beginning</span>
    </div>
  );
}
