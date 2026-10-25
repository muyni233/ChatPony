import { Heart, Star } from 'lucide-react';

/**
 * The dashboard's still life: a postcard tucked behind an envelope, a Ponyville postmark
 * and a star sticker. Purely decorative and drawn with theme tokens, so it follows the
 * night-journal palette without its own dark variant.
 */
export function JournalArt() {
  return (
    <div className="journal-art" aria-hidden="true">
      <div className="art-postcard">
        <span className="art-postcard-tape" />
        <span className="postcard-lines" />
        <div className="postcard-stamp">
          <svg viewBox="0 0 66 84" width="33" height="42">
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
        <Heart size={14} strokeWidth={1.6} className="postcard-heart" />
      </div>
      <div className="art-envelope">
        <div className="envelope-fold" />
        <div className="envelope-seal">
          <Heart size={14} strokeWidth={2} />
        </div>
      </div>
      <div className="art-postmark">
        <svg viewBox="0 0 176 176" width="88" height="88">
          <circle cx="88" cy="88" r="80" fill="none" stroke="currentColor" strokeWidth="3" />
          <circle cx="88" cy="88" r="66" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <text
            x="88"
            y="62"
            textAnchor="middle"
            fontFamily="Georgia, serif"
            fontSize="14"
            textLength="104"
            lengthAdjust="spacingAndGlyphs"
            fill="currentColor"
          >
            PONYVILLE
          </text>
          <path d="M40 80h96M40 96h96" stroke="currentColor" strokeWidth="1.6" />
          <text
            x="88"
            y="93"
            textAnchor="middle"
            fontFamily="Georgia, serif"
            fontSize="13"
            fontStyle="italic"
            fill="currentColor"
          >
            post
          </text>
          <text
            x="88"
            y="126"
            textAnchor="middle"
            fontFamily="Georgia, serif"
            fontSize="12"
            textLength="78"
            lengthAdjust="spacingAndGlyphs"
            fill="currentColor"
          >
            WITH LOVE
          </text>
        </svg>
      </div>
      <Star className="art-star" size={36} strokeWidth={1.2} />
      <span className="art-caption">a letter to a new beginning</span>
    </div>
  );
}
