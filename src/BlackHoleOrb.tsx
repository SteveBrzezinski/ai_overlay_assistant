import { useId } from 'react';
import './blackHoleOrb.css';

type BlackHoleOrbProps = {
  isVisible: boolean;
  isListening: boolean;
  isThinking: boolean;
  isSpeaking: boolean;
  title: string;
  onClick: () => void;
};

const STAR_POINTS = [
  { x: 50, y: 44, radius: 1.6, delay: '0.2s' },
  { x: 83, y: 35, radius: 1.2, delay: '1.3s' },
  { x: 166, y: 38, radius: 1.5, delay: '0.7s' },
  { x: 196, y: 69, radius: 1.8, delay: '1.8s' },
  { x: 211, y: 120, radius: 1.4, delay: '0.5s' },
  { x: 192, y: 179, radius: 1.5, delay: '1.1s' },
  { x: 145, y: 213, radius: 1.1, delay: '1.6s' },
  { x: 95, y: 218, radius: 1.5, delay: '0.9s' },
  { x: 45, y: 193, radius: 1.3, delay: '1.9s' },
  { x: 28, y: 141, radius: 1.7, delay: '0.1s' },
  { x: 36, y: 90, radius: 1.2, delay: '1.4s' },
  { x: 127, y: 23, radius: 1.3, delay: '0.4s' },
];

function joinClassNames(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ');
}

export default function BlackHoleOrb({
  isVisible,
  isListening,
  isThinking,
  isSpeaking,
  title,
  onClick,
}: BlackHoleOrbProps) {
  const idBase = useId().replace(/:/g, '');
  const outerGlowId = `${idBase}-outer-glow`;
  const accretionGradientId = `${idBase}-accretion-gradient`;
  const accretionRingId = `${idBase}-accretion-ring`;
  const accretionRingGlowId = `${idBase}-accretion-ring-glow`;
  const coreGlowId = `${idBase}-core-glow`;
  const rimGradientId = `${idBase}-rim-gradient`;
  const blurFilterId = `${idBase}-blur`;
  const shimmerFilterId = `${idBase}-shimmer`;
  const ringBlurId = `${idBase}-ring-blur`;

  return (
    <button
      type="button"
      className={joinClassNames('black-hole-orb', !isVisible && 'black-hole-orb--hidden')}
      onClick={onClick}
      title={title}
      aria-label="AI voice overlay"
    >
      <div
        className={joinClassNames(
          'black-hole-stage',
          isListening && 'black-hole-stage--listening',
          isThinking && 'black-hole-stage--thinking',
          isSpeaking && 'black-hole-stage--speaking',
        )}
      >
        <span className="black-hole-hitbox" />
        <span className="black-hole-ripple black-hole-ripple--outer" />
        <span className="black-hole-ripple black-hole-ripple--inner" />

        <svg className="black-hole-svg" viewBox="0 0 240 240" aria-hidden="true">
          <defs>
            <radialGradient id={outerGlowId} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--orb-stop-outer-1)" />
              <stop offset="58%" stopColor="var(--orb-stop-outer-2)" />
              <stop offset="82%" stopColor="var(--orb-stop-outer-3)" />
              <stop offset="100%" stopColor="var(--orb-stop-outer-4)" />
            </radialGradient>

            <radialGradient id={accretionGradientId} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--orb-stop-disk-1)" />
              <stop offset="46%" stopColor="var(--orb-stop-disk-2)" />
              <stop offset="74%" stopColor="var(--orb-stop-disk-3)" />
              <stop offset="100%" stopColor="var(--orb-stop-disk-4)" />
            </radialGradient>

            <linearGradient id={accretionRingId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="var(--orb-ring-main-start)" />
              <stop offset="18%" stopColor="var(--orb-ring-main-mid-a)" />
              <stop offset="46%" stopColor="var(--orb-ring-main-mid-b)" />
              <stop offset="72%" stopColor="var(--orb-ring-main-mid-c)" />
              <stop offset="100%" stopColor="var(--orb-ring-main-end)" />
            </linearGradient>

            <linearGradient id={accretionRingGlowId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="var(--orb-ring-glow-start)" />
              <stop offset="40%" stopColor="var(--orb-ring-glow-mid-a)" />
              <stop offset="52%" stopColor="var(--orb-ring-glow-mid-b)" />
              <stop offset="70%" stopColor="var(--orb-ring-glow-mid-c)" />
              <stop offset="100%" stopColor="var(--orb-ring-glow-end)" />
            </linearGradient>

            <radialGradient id={coreGlowId} cx="50%" cy="50%" r="50%">
              <stop offset="0%" stopColor="var(--orb-core-stop-1)" />
              <stop offset="62%" stopColor="var(--orb-core-stop-2)" />
              <stop offset="100%" stopColor="var(--orb-core-stop-3)" />
            </radialGradient>

            <linearGradient id={rimGradientId} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="var(--orb-rim-start)" />
              <stop offset="46%" stopColor="var(--orb-rim-mid)" />
              <stop offset="100%" stopColor="var(--orb-rim-end)" />
            </linearGradient>

            <filter id={blurFilterId} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="4.5" />
            </filter>

            <filter id={ringBlurId} x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur stdDeviation="3.8" />
            </filter>

            <filter id={shimmerFilterId} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="1.6" result="blurred" />
              <feMerge>
                <feMergeNode in="blurred" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <circle cx="120" cy="120" r="112" fill={`url(#${outerGlowId})`} />

          <g className="accretion-ring-tilt accretion-ring-tilt--back">
            <ellipse
              className="accretion-ring accretion-ring--back-glow"
              cx="120"
              cy="120"
              rx="93"
              ry="33"
              stroke={`url(#${accretionRingGlowId})`}
              filter={`url(#${ringBlurId})`}
            />
            <ellipse
              className="accretion-ring accretion-ring--back"
              cx="120"
              cy="120"
              rx="89"
              ry="29"
              stroke={`url(#${accretionRingId})`}
            />
          </g>

          {STAR_POINTS.map((star, index) => (
            <circle
              key={`${star.x}-${star.y}`}
              className="black-hole-star"
              cx={star.x}
              cy={star.y}
              r={star.radius}
              style={{ animationDelay: star.delay, opacity: index % 2 === 0 ? 0.9 : 0.55 }}
            />
          ))}

          <g className="ring-rotation ring-rotation--outer">
            <circle
              className="ring-stroke ring-stroke--outer"
              cx="120"
              cy="120"
              r="94"
              pathLength="360"
              strokeDasharray="22 14 38 18 56 28 26 22"
            />
            <circle
              className="ring-stroke ring-stroke--outer-glow"
              cx="120"
              cy="120"
              r="99"
              pathLength="360"
              strokeDasharray="12 26 18 34 20 42"
              filter={`url(#${blurFilterId})`}
            />
          </g>

          <g className="ring-rotation ring-rotation--middle">
            <circle
              className="ring-stroke ring-stroke--middle"
              cx="120"
              cy="120"
              r="76"
              pathLength="360"
              strokeDasharray="16 11 30 16 14 24 48 20"
            />
            <circle
              className="ring-stroke ring-stroke--middle-soft"
              cx="120"
              cy="120"
              r="70"
              pathLength="360"
              strokeDasharray="10 15 18 18 34 16 12 26"
              filter={`url(#${blurFilterId})`}
            />
          </g>

          <g className="ring-rotation ring-rotation--inner">
            <circle
              className="ring-stroke ring-stroke--inner"
              cx="120"
              cy="120"
              r="57"
              pathLength="360"
              strokeDasharray="14 12 16 18 18 12 22 16 26 18"
            />
            <path
              className="event-arc event-arc--a"
              d="M 60 120 A 60 60 0 0 1 180 120"
              filter={`url(#${shimmerFilterId})`}
            />
            <path
              className="event-arc event-arc--b"
              d="M 178 122 A 58 58 0 0 1 62 122"
              filter={`url(#${shimmerFilterId})`}
            />
          </g>

          <circle className="accretion-disk" cx="120" cy="120" r="84" fill={`url(#${accretionGradientId})`} />
          <circle className="core-lens" cx="120" cy="120" r="53" fill={`url(#${coreGlowId})`} />
          <circle className="core-rim" cx="120" cy="120" r="44" stroke={`url(#${rimGradientId})`} />
          <circle className="core-shadow" cx="120" cy="120" r="39" />
          <circle className="core" cx="120" cy="120" r="33" />

          <g className="accretion-ring-tilt accretion-ring-tilt--front">
            <path
              className="accretion-front-arc accretion-front-arc--glow"
              d="M 33 129 C 61 150, 97 160, 120 160 C 143 160, 179 150, 207 129"
              stroke={`url(#${accretionRingGlowId})`}
              filter={`url(#${ringBlurId})`}
            />
            <path
              className="accretion-front-arc accretion-front-arc--main"
              d="M 36 128 C 63 147, 99 156, 120 156 C 141 156, 177 147, 204 128"
              stroke={`url(#${accretionRingId})`}
            />
          </g>
        </svg>
      </div>
    </button>
  );
}
