import React from 'react';
import type { VehicleSnapshot } from '@vpauto/shared';

interface Props {
  items: { vehicleId: number; snapshot: VehicleSnapshot }[];
  current: VehicleSnapshot;
}

export default function TabSameModel({ items, current }: Props) {
  if (items.length === 0) {
    return (
      <div className="vpa-status">
        <div className="vpa-status-icon">🗂️</div>
        <div className="vpa-status-title">Aucun historique de ce modèle</div>
        <div className="vpa-status-sub">
          Aucun autre {current.brand} {current.model} n'a encore été enregistré.
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="vpa-section-title" style={{ marginBottom: 8 }}>
        🚗 {items.length} {current.brand} {current.model} dans la base
      </div>

      {/* Comparison table header */}
      <table className="vpa-compare-table" style={{ marginBottom: 12 }}>
        <thead>
          <tr>
            <th>Critère</th>
            <th>Ce véhicule</th>
            <th>Moyenne base</th>
          </tr>
        </thead>
        <tbody>
          <AverageRow label="Année" current={current.year} items={items.map((i) => i.snapshot.year)} format={(v) => String(v)} higherBetter />
          <AverageRow label="Kilométrage" current={current.mileage} items={items.map((i) => i.snapshot.mileage)} format={(v) => `${v.toLocaleString('fr-FR')} km`} higherBetter={false} />
          <AverageRow label="Mise à prix" current={current.startingPrice ?? 0} items={items.map((i) => i.snapshot.startingPrice ?? 0)} format={(v) => v > 0 ? `${v.toLocaleString('fr-FR')} €` : '–'} higherBetter={false} />
        </tbody>
      </table>

      {/* Vehicle cards */}
      <div className="vpa-section-title">Détail des véhicules du même modèle</div>
      {items.map(({ vehicleId, snapshot: s }) => (
        <div key={vehicleId} className="vpa-similar-card">
          {s.photoUrls?.[0] && (
            <img className="vpa-similar-photo" src={s.photoUrls[0]} alt={s.model} />
          )}
          <div className="vpa-similar-body">
            <div className="vpa-similar-title">{s.brand} {s.version || s.model}</div>
            <div className="vpa-similar-meta">
              <span>📅 {s.year}</span>
              <span>🛣️ {s.mileage?.toLocaleString('fr-FR')} km</span>
              <span>📍 {s.city}</span>
              {s.startingPrice && <span>💶 {s.startingPrice.toLocaleString('fr-FR')} €</span>}
              <span>{s.fuel}</span>
              <span>{s.transmission}</span>
              {s.color && <span>🎨 {s.color}</span>}
            </div>
            {s.sourceUrl && (
              <a href={s.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: '#1e40af', marginTop: 3, display: 'inline-block' }}>
                🔗 Voir la fiche
              </a>
            )}
          </div>
        </div>
      ))}
    </>
  );
}

function AverageRow({
  label, current, items, format, higherBetter,
}: {
  label: string;
  current: number;
  items: number[];
  format: (v: number) => string;
  higherBetter: boolean;
}) {
  const valid = items.filter((v) => v > 0);
  if (valid.length === 0) return null;
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const better = higherBetter ? current > avg : current < avg;
  const cls = current === avg ? 'compare-neutral' : better ? 'compare-better' : 'compare-worse';

  return (
    <tr>
      <td>{label}</td>
      <td className={cls}>{format(current)}</td>
      <td className="compare-neutral">{format(Math.round(avg))}</td>
    </tr>
  );
}
