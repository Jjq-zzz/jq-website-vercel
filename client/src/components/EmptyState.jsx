import BrandMark from './BrandMark.jsx';

/** 温和明确的空状态（不带营销文案）。 */
export default function EmptyState({ title, description, action }) {
  return (
    <div className="empty-block">
      <BrandMark className="empty-mark" />
      <div className="empty-copy">
        <p className="empty-title">{title}</p>
        {description && <p className="empty-desc">{description}</p>}
      </div>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
