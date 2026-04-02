import React from 'react';
import type { VehicleHistory, VehicleSnapshot } from '@vpauto/shared';
import PriceChart from './PriceChart';

interface Props {
  history: VehicleHistory | null;
  snapshot: VehicleSnapshot;
  vehicleId: number | null;
}

export default function TabHistory({ history, snapshot, vehicleId }: Props) {
  if (!history || history.totalPassages === 0) {
    return (
      <div className="vpa-status">
        <div className="vpa-status-icon">📭</div>
        <div className="vpa-status-title">Premier passage détecté</div>
        <div className="vpa-status-sub">Ce véhicule n'a pas d'historique connu. Il vient d'être enregistré.</div>
      </div>
    );
  }

  const lastPrice = history.priceHistory.at(-1)?.price;
  const firstPrice = history.priceHistory[0]?.price;
  const priceDiff = lastPrice && firstPrice ? lastPrice - firstPrice : null;

  return (
    <>
      {/* Stats strip */}
      <div className="vpa-stats">
        <div className="vpa-stat">
          <div className="vpa-stat-value">{history.totalPassages}</div>
          <div className="vpa-stat-label">Passages</div>
        </div>
        <div className="vpa-stat">
          <div className="vpa-stat-value">
            {lastPrice ? `${lastPrice.toLocaleString('fr-FR')} €` : '–'}
          </div>
          <div className="vpa-stat-label">Dernière MAP</div>
        </div>
        <div className="vpa-stat">
          <div className={`vpa-stat-value ${priceDiff !== null ? (priceDiff < 0 ? 'diff-positive' : priceDiff > 0 ? 'diff-negative' : 'diff-neutral') : ''}`}>
            {priceDiff !== null ? `${priceDiff > 0 ? '+' : ''}${priceDiff.toLocaleString('fr-FR')} €` : '–'}
          </div>
          <div className="vpa-stat-label">Évolution prix</div>
        </div>
      </div>

      {/* Price chart */}
      {history.priceHistory.length >= 2 && (
        <div className="vpa-section">
          <div className="vpa-section-title">📈 Évolution du prix</div>
          <div className="vpa-chart">
            <PriceChart data={history.priceHistory} />
          </div>
        </div>
      )}

      {/* CT link */}
      {snapshot.technicalCheckUrl && (
        <div className="vpa-section">
          <div className="vpa-section-title">🔧 Contrôle technique</div>
          <a className="vpa-ct-link" href={snapshot.technicalCheckUrl} target="_blank" rel="noreferrer">
            📄 Voir le CT
          </a>
        </div>
      )}

      {/* Observations */}
      {snapshot.observations && (
        <div className="vpa-section">
          <div className="vpa-section-title">⚠️ Observations</div>
          <div className="vpa-passage-obs">{snapshot.observations}</div>
        </div>
      )}

      {/* Passages timeline */}
      <div className="vpa-section">
        <div className="vpa-section-title">📅 Historique des passages</div>
        {[...history.passages].reverse().map((p) => (
          <div key={p.snapshotId} className="vpa-passage">
            <div className="vpa-passage-header">
              <span className="vpa-passage-date">{formatDate(p.date)}</span>
              <span className="vpa-passage-city">📍 {p.city}</span>
              <span className={`vpa-passage-status status-${p.status}`}>{statusLabel(p.status)}</span>
            </div>
            <div className="vpa-passage-fields">
              {p.mileage > 0 && <span>🛣️ {p.mileage.toLocaleString('fr-FR')} km</span>}
              {p.startingPrice && <span>💶 MAP : {p.startingPrice.toLocaleString('fr-FR')} €</span>}
              {p.soldPrice && <span>✅ Vendu : {p.soldPrice.toLocaleString('fr-FR')} €</span>}
              {p.technicalCheckUrl && (
                <a className="vpa-ct-link" href={p.technicalCheckUrl} target="_blank" rel="noreferrer">
                  📄 CT
                </a>
              )}
            </div>
            {p.observations && <div className="vpa-passage-obs">{p.observations}</div>}
            {p.sourceUrl && (
              <div style={{ marginTop: 5 }}>
                <a href={p.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: '#1e40af' }}>
                  🔗 Voir la fiche
                </a>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function formatDate(d: string) {
  if (!d) return '–';
  try {
    return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(d));
  } catch {
    return d;
  }
}

function statusLabel(s: string) {
  switch (s) {
    case 'available': return 'Disponible';
    case 'sold': return 'Vendu';
    case 'unsold': return 'Invendu';
    case 'removed': return 'Retiré';
    case 'auction_live': return '🔴 En cours';
    default: return s;
  }
}
