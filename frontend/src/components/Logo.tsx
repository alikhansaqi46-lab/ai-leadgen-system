import React from 'react';

interface LogoProps {
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  alt?: string;
}

const Logo: React.FC<LogoProps> = ({ size = 56, className = '', style = {}, alt = 'LeadFlow AI' }) => {
  return (
    <img
      src="/leadflow.png"
      alt={alt}
      className={`lf-logo ${className}`}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        borderRadius: 12,
        display: 'block',
        ...style,
      }}
      draggable={false}
    />
  );
};

export default Logo;
