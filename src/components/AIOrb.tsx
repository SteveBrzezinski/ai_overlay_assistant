import React, { useEffect, useRef, useState } from 'react';
import outerRingAsset from '../assets/orb/outer.png';
import innerRingAsset from '../assets/orb/inner.png';
import coreRingAsset from '../assets/orb/core.png';
import '../styles/AIOrb.css';

interface AIOrbProps {
  isVisible?: boolean;
  isSpeaking?: boolean;
  isListening?: boolean;
  isMuted?: boolean;
  onMuteToggle?: () => void;
  onChatOpen?: () => void;
  onVoiceToggle?: () => void;
  onSettingsOpen?: () => void;
}

type OrbFrame = {
  outerRotation: number;
  innerRotation: number;
  coreRotation: number;
  shellScale: number;
  centerScale: number;
  glowOpacity: number;
};

export const AIOrb: React.FC<AIOrbProps> = ({
  isVisible = true,
  isSpeaking = false,
  isListening = false,
  isMuted = false,
  onMuteToggle,
  onChatOpen,
  onVoiceToggle,
  onSettingsOpen,
}) => {
  const [isHovering, setIsHovering] = useState(false);
  const [frame, setFrame] = useState<OrbFrame>({
    outerRotation: 0,
    innerRotation: 0,
    coreRotation: 0,
    shellScale: 1,
    centerScale: 1,
    glowOpacity: 0.72,
  });
  const animationRef = useRef<number>();
  const startTimeRef = useRef<number | null>(null);
  const isListeningRef = useRef(isListening);
  const isSpeakingRef = useRef(isSpeaking);
  const orbState = isSpeaking ? 'speaking' : isListening ? 'listening' : 'idle';

  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  useEffect(() => {
    isSpeakingRef.current = isSpeaking;
  }, [isSpeaking]);

  useEffect(() => {
    const animate = (timestamp: number) => {
      if (startTimeRef.current === null) {
        startTimeRef.current = timestamp;
      }

      const elapsed = (timestamp - startTimeRef.current) / 1000;
      const speaking = isSpeakingRef.current;
      const listening = isListeningRef.current;
      const rotationSpeed = speaking ? 60 : listening ? 32 : 20;
      const pulseFrequency = speaking ? 3 : 1.5;
      const shellPulse = speaking ? 0.022 : listening ? 0.014 : 0.009;
      const centerPulse = speaking ? 0.09 : listening ? 0.045 : 0.02;
      const shellScale = 1 + Math.sin(elapsed * pulseFrequency * Math.PI * 2) * shellPulse;
      const centerScale = 1 + Math.sin((elapsed + 0.23) * pulseFrequency * Math.PI * 2) * centerPulse;
      const glowOpacity = speaking ? 0.96 : listening ? 0.84 : 0.68;

      setFrame({
        outerRotation: elapsed * rotationSpeed,
        innerRotation: elapsed * -rotationSpeed,
        coreRotation: elapsed * rotationSpeed * 0.5,
        shellScale,
        centerScale,
        glowOpacity,
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      startTimeRef.current = null;
    };
  }, []);

  return (
    <div
      className={`ai-orb-container${isVisible ? '' : ' ai-orb-container--hidden'}`}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <div className={`action-bar ${isHovering ? 'visible' : ''}`}>
        <button className="action-btn mute-btn" onClick={onMuteToggle} title={isMuted ? 'Unmute' : 'Mute'}>
          <span className="icon">{isMuted ? 'Off' : 'On'}</span>
          <span className="label">Mute</span>
        </button>

        <button className="action-btn chat-btn" onClick={onChatOpen} title="Open window">
          <span className="icon">UI</span>
          <span className="label">Open</span>
        </button>

        <button className="action-btn voice-btn" onClick={onVoiceToggle} title="Voice" disabled={isMuted}>
          <span className="icon">Mic</span>
          <span className="label">Voice</span>
        </button>

        <button className="action-btn settings-btn" onClick={onSettingsOpen} title="Settings">
          <span className="icon">Cfg</span>
          <span className="label">Settings</span>
        </button>

      </div>

      <div className={`ai-orb ${orbState}`} style={{ transform: `translateY(-50%) scale(${frame.shellScale})` }}>
        <div
          className="sigil-layer sigil-layer--outer"
          style={{
            ['--orb-mask' as string]: `url(${outerRingAsset})`,
            transform: `rotate(${frame.outerRotation}deg)`,
          }}
        />

        <div
          className="sigil-layer sigil-layer--inner"
          style={{
            ['--orb-mask' as string]: `url(${innerRingAsset})`,
            transform: `rotate(${frame.innerRotation}deg)`,
          }}
        />

        <div
          className="sigil-layer sigil-layer--core"
          style={{
            ['--orb-mask' as string]: `url(${coreRingAsset})`,
            transform: `rotate(${frame.coreRotation}deg) scale(${0.92 + (frame.centerScale - 1) * 0.4})`,
          }}
        />

        <div className="center-core" style={{ transform: `scale(${frame.centerScale})` }}>
          <div className="center-glow" style={{ opacity: frame.glowOpacity }} />
          <div className="center-dot" />
        </div>

        {isSpeaking ? <div className="speaking-pulse" /> : null}
      </div>
    </div>
  );
};
