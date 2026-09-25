import React from 'react';

interface ShadowKycLogoProps {
  width?: number | string;
  height?: number | string;
  className?: string;
  style?: React.CSSProperties;
}

export const ShadowKycLogo: React.FC<ShadowKycLogoProps> = ({
  width = 32,
  height = 32,
  className,
  style,
}) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      width={width}
      height={height}
      fill="none"
      className={className}
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
      aria-label="Shadow-KYC Logo"
      role="img"
    >
      <defs>
        {/* Background Shield Shadow / Off-chain Facet */}
        <linearGradient id="sk-comp-shadow" x1="7" y1="4" x2="24" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#312e81" stopOpacity="0.95" />
          <stop offset="50%" stopColor="#1e1b4b" stopOpacity="0.98" />
          <stop offset="100%" stopColor="#0a091e" stopOpacity="1" />
        </linearGradient>

        {/* Public / Verified ZK Facet */}
        <linearGradient id="sk-comp-light" x1="24" y1="4" x2="41" y2="44" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#9333ea" />
          <stop offset="40%" stopColor="#7c3aed" />
          <stop offset="85%" stopColor="#6366f1" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>

        {/* Outer Rim Precision Stroke */}
        <linearGradient id="sk-comp-rim" x1="24" y1="3" x2="24" y2="45" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#e9d5ff" />
          <stop offset="25%" stopColor="#c084fc" />
          <stop offset="65%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>

        {/* Zero-Knowledge Orbit Ring Gradient */}
        <linearGradient id="sk-comp-zk" x1="14" y1="13" x2="34" y2="33" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="45%" stopColor="#67e8f9" />
          <stop offset="85%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>

        {/* Compliance Verified Checkmark Gradient */}
        <linearGradient id="sk-comp-check" x1="18.5" y1="18" x2="29.5" y2="27" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#34d399" />
          <stop offset="60%" stopColor="#10b981" />
          <stop offset="100%" stopColor="#06b6d4" />
        </linearGradient>

        {/* Ambient Glow */}
        <radialGradient id="sk-comp-glow" cx="24" cy="23" r="14" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Ambient Backdrop Glow */}
      <circle cx="24" cy="23" r="14" fill="url(#sk-comp-glow)" />

      {/* Left Facet: Shadow / Zero PII Off-Chain */}
      <path
        d="M24 4.5 L8.5 11 C8.5 24 14.5 36.5 24 43.5 Z"
        fill="url(#sk-comp-shadow)"
      />

      {/* Right Facet: ZK Proof / Compliant On-Chain */}
      <path
        d="M24 4.5 L39.5 11 C39.5 24 33.5 36.5 24 43.5 Z"
        fill="url(#sk-comp-light)"
      />

      {/* Central Seam Dividing Shadow & Light */}
      <line x1="24" y1="4.5" x2="24" y2="43.5" stroke="rgba(255, 255, 255, 0.22)" strokeWidth="0.8" />

      {/* Outer High-Tech Shield Contour Rim */}
      <path
        d="M24 3.5 L41 10.5 C41 24.5 34.5 37.5 24 44.5 C13.5 37.5 7 24.5 7 10.5 Z"
        fill="none"
        stroke="url(#sk-comp-rim)"
        strokeWidth="1.85"
        strokeLinejoin="round"
      />

      {/* Zero-Knowledge Aperture Core (Dark Void with Orbit Stroke) */}
      <circle
        cx="24"
        cy="23"
        r="9.5"
        fill="#080c1a"
        fillOpacity="0.9"
        stroke="url(#sk-comp-zk)"
        strokeWidth="1.8"
      />

      {/* KYC / AML Compliance Verified Checkmark */}
      <path
        d="M19.2 23 L22.6 26.4 L29 19.5"
        fill="none"
        stroke="url(#sk-comp-check)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Zero-Knowledge Cryptographic Nodes */}
      <circle cx="24" cy="8.5" r="1.3" fill="#c084fc" />
      <circle cx="24" cy="37.5" r="1.3" fill="#06b6d4" />
    </svg>
  );
};

export default ShadowKycLogo;
