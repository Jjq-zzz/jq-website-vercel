/** 书页与折角组成的品牌符号，使用同一套线条比例。 */
export default function BrandMark({ className = 'brand-mark' }) {
  return (
    <span className={className} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <path d="M8 6h12l5 5v15H8a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z" />
        <path d="M10 6v20M19 6v6h6M14 17h7M14 21h5" />
      </svg>
    </span>
  );
}
