import React from 'react';
import logoImg from './assets/logo.png';

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
    <img
      src={logoImg}
      alt="Shadow-KYC Logo"
      width={width}
      height={height}
      className={className}
      style={{
        display: 'inline-block',
        verticalAlign: 'middle',
        flexShrink: 0,
        objectFit: 'contain',
        ...style,
      }}
    />
  );
};

export default ShadowKycLogo;

