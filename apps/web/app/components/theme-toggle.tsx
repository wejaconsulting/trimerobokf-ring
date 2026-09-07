'use client';

import { useEffect, useState } from 'react';

type Choice = 'system' | 'light' | 'dark';

const ORDER: Choice[] = ['system', 'light', 'dark'];

const LABEL: Record<Choice, string> = {
  system: 'Systemets tema',
  light: 'Ljust tema',
  dark: 'Mörkt tema',
};

/**
 * Cycles system → light → dark.
 *
 * "System" is a real third state, not a synonym for light: it leaves the root
 * element unstamped so `prefers-color-scheme` decides. The stamp is applied by
 * the inline script in the layout before first paint, so this component only
 * has to keep the two in sync afterwards.
 */
export function ThemeToggle() {
  const [choice, setChoice] = useState<Choice>('system');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem('trimeros-theme');
    setChoice(stored === 'light' || stored === 'dark' ? stored : 'system');
    setReady(true);
  }, []);

  function apply(next: Choice) {
    setChoice(next);
    const root = document.documentElement;
    if (next === 'system') {
      root.removeAttribute('data-theme');
      window.localStorage.removeItem('trimeros-theme');
    } else {
      root.setAttribute('data-theme', next);
      window.localStorage.setItem('trimeros-theme', next);
    }
  }

  const next = ORDER[(ORDER.indexOf(choice) + 1) % ORDER.length] ?? 'system';

  return (
    <button
      type="button"
      className="btn icon-btn"
      onClick={() => apply(next)}
      title={`${LABEL[choice]} — växla till ${LABEL[next].toLowerCase()}`}
      aria-label={`${LABEL[choice]}. Växla till ${LABEL[next].toLowerCase()}`}
    >
      {/* An inline SVG rather than a glyph: the half-circle characters are
          missing from several system fallback fonts and render as a sliver. */}
      <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none">
        <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
        {ready && choice !== 'light' ? (
          <path
            d="M8 2a6 6 0 0 0 0 12z"
            fill="currentColor"
            opacity={choice === 'dark' ? 1 : 0.55}
          />
        ) : null}
        {ready && choice === 'dark' ? <circle cx="8" cy="8" r="6" fill="currentColor" /> : null}
      </svg>
    </button>
  );
}
