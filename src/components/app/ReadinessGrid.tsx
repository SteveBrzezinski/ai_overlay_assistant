import { useTranslation } from 'react-i18next';

type ReadinessItem = {
  label: string;
  value: string;
};

type ReadinessGridProps = {
  items: ReadinessItem[];
};

export function ReadinessGrid({ items }: ReadinessGridProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <section className="panel-grid" aria-label={t('readiness.ariaLabel')}>
      {items.map((item) => (
        <article className="info-card" key={item.label}>
          <span className="info-label">{item.label}</span>
          <strong>{item.value}</strong>
        </article>
      ))}
    </section>
  );
}
