"use client";

import React, { useEffect, useRef, useState } from 'react';
import { DEMO_PAUSED_EVENT, RATE_LIMIT_EVENT } from '@/lib/api';

/**
 * Showcase rate-limit CTA modal (shown on HTTP 429) and the distinct
 * "demo paused" notice (shown on HTTP 503 from the rate-limit kill switch).
 */

export const PROJECT_CTA = {
  name: 'EquityLens AI Investment Analyst',
  emoji: '📈',
  accentColor: '#D4A84F',
  headline: "You've worked the research desk!",
  description:
    'This demo ran {count} live AI analyses for you. Want to build source-grounded AI tools like this? Join us, or keep going with the manual copy/paste flow.',
  programme: 'AI Lodge',
  programmeLink: 'https://www.smubia.com/ai-lodge',
  githubLink: 'https://github.com/smubia-projects/ail-ay2627-s1-jon-ai-investment-analyst',
  showcaseLink: 'https://www.smubia.com/showcase',
};

interface RateLimitCTAProps {
  queriesMade: number;
  onDismiss: () => void;
}

const ctaButtonStyle: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  padding: '14px 44px',
  borderRadius: '14px',
  fontWeight: 700,
  fontSize: '13px',
  textDecoration: 'none',
  transition: 'transform 0.15s ease, opacity 0.15s ease',
};

const arrowStyle: React.CSSProperties = {
  position: 'absolute',
  right: '18px',
};

export function RateLimitCTA({ queriesMade, onDismiss }: RateLimitCTAProps) {
  const cardRef = useRef<HTMLDivElement>(null);
  const project = PROJECT_CTA;

  // Basic focus trap while the modal is open
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const focusables = card.querySelectorAll<HTMLElement>('a, button');
    focusables[0]?.focus();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
      if (e.key !== 'Tab' || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onDismiss]);

  const description = project.description.replace('{count}', String(queriesMade));

  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
        backdropFilter: 'blur(12px)',
        animation: 'rlcta-fade-in 0.5s ease both',
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={`${project.name} rate limit reached`}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(420px, calc(100vw - 32px))',
          borderRadius: '24px',
          overflow: 'hidden',
          background: '#111113',
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
          animation: 'rlcta-slide-up 0.6s cubic-bezier(0.22, 1.2, 0.36, 1) both',
        }}
      >
        {/* Top banner */}
        <div
          style={{
            position: 'relative',
            padding: '32px 28px',
            background: `linear-gradient(135deg, ${project.accentColor}, ${project.accentColor}66)`,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              position: 'absolute',
              top: '-40px',
              right: '-40px',
              width: '140px',
              height: '140px',
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.12)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              bottom: '-50px',
              left: '-30px',
              width: '120px',
              height: '120px',
              borderRadius: '50%',
              background: 'rgba(255,255,255,0.08)',
            }}
          />
          <div style={{ fontSize: '36px', marginBottom: '10px' }}>{project.emoji}</div>
          <div style={{ fontSize: '20px', fontWeight: 800, color: '#fff', marginBottom: '8px' }}>
            {project.headline}
          </div>
          <div style={{ fontSize: '13px', color: 'rgba(255,255,255,0.85)', lineHeight: 1.5 }}>
            {description}
          </div>
        </div>

        {/* CTA body */}
        <div style={{ padding: '24px 28px 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <a
            href={project.programmeLink}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              ...ctaButtonStyle,
              background: `linear-gradient(135deg, ${project.accentColor}, ${project.accentColor}AA)`,
              color: '#fff',
            }}
          >
            Join {project.programme}
            <span style={arrowStyle}>→</span>
          </a>
          <a
            href={project.githubLink}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              ...ctaButtonStyle,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#e5e5e5',
            }}
          >
            Self-host from GitHub
            <span style={arrowStyle}>→</span>
          </a>
          <a
            href={project.showcaseLink}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              ...ctaButtonStyle,
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: '#e5e5e5',
            }}
          >
            Explore other projects
            <span style={arrowStyle}>→</span>
          </a>
        </div>

        <div style={{ padding: '0 28px 22px', textAlign: 'center' }}>
          <button
            onClick={onDismiss}
            style={{
              background: 'none',
              border: 'none',
              color: '#777',
              fontSize: '12px',
              fontWeight: 600,
              cursor: 'pointer',
              padding: '8px',
            }}
          >
            Maybe later
          </button>
        </div>
      </div>

      <style>{`
        @keyframes rlcta-fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes rlcta-slide-up {
          from { transform: translateY(24px) scale(0.95); opacity: 0; }
          to { transform: translateY(0) scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

interface DemoPausedNoticeProps {
  message: string;
  onDismiss: () => void;
}

// Operator paused the demo (503 from the kill switch) — a friendly notice,
// deliberately distinct from the recruitment CTA above.
export function DemoPausedNotice({ message, onDismiss }: DemoPausedNoticeProps) {
  return (
    <div
      onClick={onDismiss}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
        backdropFilter: 'blur(8px)',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Demo paused"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(380px, calc(100vw - 32px))',
          borderRadius: '20px',
          background: '#111113',
          border: '1px solid rgba(255,255,255,0.08)',
          padding: '28px',
          textAlign: 'center',
          boxShadow: '0 24px 80px rgba(0,0,0,0.6)',
        }}
      >
        <div style={{ fontSize: '32px', marginBottom: '12px' }}>⏸️</div>
        <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff', marginBottom: '8px' }}>
          Demo temporarily paused
        </div>
        <div style={{ fontSize: '13px', color: '#aaa', lineHeight: 1.5, marginBottom: '20px' }}>
          {message || 'This demo is temporarily paused. Check back soon.'}
        </div>
        <button
          onClick={onDismiss}
          style={{
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.1)',
            color: '#e5e5e5',
            fontSize: '12px',
            fontWeight: 600,
            cursor: 'pointer',
            padding: '10px 24px',
            borderRadius: '12px',
          }}
        >
          Got it
        </button>
      </div>
    </div>
  );
}

// Mounted once in the app shell: listens for the events lib/api.ts dispatches on
// 429 (rate limit) and 503 (kill switch) and renders the matching overlay.
export function RateLimitGate() {
  const [queriesUsed, setQueriesUsed] = useState<number | null>(null);
  const [pausedMessage, setPausedMessage] = useState<string | null>(null);

  useEffect(() => {
    const onLimit = (event: Event) => setQueriesUsed((event as CustomEvent<{ queriesUsed: number }>).detail?.queriesUsed ?? 0);
    const onPaused = (event: Event) => setPausedMessage((event as CustomEvent<{ message: string }>).detail?.message ?? '');
    window.addEventListener(RATE_LIMIT_EVENT, onLimit);
    window.addEventListener(DEMO_PAUSED_EVENT, onPaused);
    return () => {
      window.removeEventListener(RATE_LIMIT_EVENT, onLimit);
      window.removeEventListener(DEMO_PAUSED_EVENT, onPaused);
    };
  }, []);

  return (
    <>
      {queriesUsed !== null && <RateLimitCTA queriesMade={queriesUsed} onDismiss={() => setQueriesUsed(null)} />}
      {pausedMessage !== null && <DemoPausedNotice message={pausedMessage} onDismiss={() => setPausedMessage(null)} />}
    </>
  );
}
