import React from 'react';
import { browser } from 'wxt/browser';
import type { VehicleHistory, VehicleSnapshot, VehiclePassage } from '@vpauto/shared';
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

  const ev = history.evolution;
  const lastDisplayedPrice = ev.lastEffectivePrice;

  // Display semantics: price went UP = red (diff-negative for buyer);
  // price went DOWN = green (diff-positive for buyer); equal = neutral.
  const diffClass =
    ev.evolutionDirection === 'up' ? 'diff-negative' :
    ev.evolutionDirection === 'down' ? 'diff-positive' :
    ev.evolutionDirection === 'stable' ? 'diff-neutral' : '';
  const diffArrow =
    ev.evolutionDirection === 'up' ? '↑' :
    ev.evolutionDirection === 'down' ? '↓' :
    ev.evolutionDirection === 'stable' ? '=' : '';
  const diffText = ev.evolutionAmount != null
    ? `${diffArrow} ${ev.evolutionAmount > 0 ? '+' : ev.evolutionAmount < 0 ? '−' : ''}${Math.abs(ev.evolutionAmount).toLocaleString('fr-FR')} €`
    : '–';

  const lastPassageLabel = ev.lastPassageSold ? 'Adjugé' : 'Dernière MAP';

  return (
    <>
      {/* Summary banner — only when this vehicle has history beyond a first single MAP-only passage */}
      {ev.totalPassages >= 2 && (
        <div className="vpa-history-banner">
          <div className="vpa-history-banner-title">
            📜 Ce véhicule a déjà été vu <strong>{ev.totalPassages} fois</strong>
            {ev.soldCount > 0 && <> · adjugé {ev.soldCount} fois</>}
            {ev.unsoldCount > 0 && <> · invendu {ev.unsoldCount} fois</>}
          </div>
          <ul className="vpa-history-banner-list">
            {history.passages.map((p) => (
              <li key={p.snapshotId}>
                <strong>Passage {p.passageNumber}</strong> – {formatDate(p.date)}, {p.city} :{' '}
                <PassagePriceSummary p={p} />{' '}
                <a
                  href={historyPassageHref(p)}
                  target="_blank"
                  rel="noreferrer"
                  className="vpa-history-banner-link"
                  title={p.openMode === 'vpauto' ? 'Voir la fiche VPauto de ce passage' : 'Voir la fiche historique de ce passage'}
                >
                  {p.openMode === 'vpauto' ? '🔗 fiche VPauto' : '🔗 fiche locale'}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Single-passage sold-above-MAP highlight */}
      {ev.totalPassages === 1 && ev.lastPassageSold && ev.evolutionAmount != null && ev.evolutionAmount > 0 && (
        <div className="vpa-history-banner">
          <div className="vpa-history-banner-title">
            🏷️ Adjugé <strong>{Math.abs(ev.evolutionAmount).toLocaleString('fr-FR')} €</strong> au-dessus de la mise à prix
          </div>
        </div>
      )}

      {/* Stats strip */}
      <div className="vpa-stats">
        <div className="vpa-stat">
          <div className="vpa-stat-value">{ev.totalPassages}</div>
          <div className="vpa-stat-label">{ev.totalPassages > 1 ? 'Passages' : 'Passage'}</div>
        </div>
        <div className="vpa-stat">
          <div className="vpa-stat-value">
            {lastDisplayedPrice != null ? `${lastDisplayedPrice.toLocaleString('fr-FR')} €` : '–'}
          </div>
          <div className="vpa-stat-label">{lastPassageLabel}</div>
        </div>
        <div className="vpa-stat">
          <div className={`vpa-stat-value ${diffClass}`}>{diffText}</div>
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
              <span className="vpa-passage-date">
                <span className="vpa-passage-num">P{p.passageNumber}</span> {formatDate(p.date)}
              </span>
              <span className="vpa-passage-city">📍 {p.city}{p.center ? ` – ${p.center}` : ''}</span>
              <span className={`vpa-passage-status status-${p.status}`}>{statusLabel(p.status)}</span>
            </div>
            <div className="vpa-passage-fields">
              {p.mileage > 0 && <span>🛣️ {p.mileage.toLocaleString('fr-FR')} km</span>}
              {p.startingPrice != null && <span>💶 MAP : {p.startingPrice.toLocaleString('fr-FR')} €</span>}
              {p.soldPrice != null && <span>✅ Adjugé : {p.soldPrice.toLocaleString('fr-FR')} €</span>}
              {p.technicalCheckUrl && (
                <a className="vpa-ct-link" href={p.technicalCheckUrl} target="_blank" rel="noreferrer">
                  📄 CT
                </a>
              )}
            </div>
            {p.observations && <div className="vpa-passage-obs">{p.observations}</div>}
            {p.snapshotId && (
              <div style={{ marginTop: 5 }}>
                <a
                  href={historyPassageHref(p)}
                  target="_blank"
                  rel="noreferrer"
                  className="vpa-passage-link"
                >
                  {p.openMode === 'vpauto' ? '🔗 Voir la fiche VPauto' : '🔗 Voir la fiche historique'}
                </a>
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function PassagePriceSummary({ p }: { p: VehiclePassage }) {
  if (p.status === 'sold' && p.soldPrice != null) {
    return (
      <>
        adjugé à <strong>{p.soldPrice.toLocaleString('fr-FR')} €</strong>
        {p.startingPrice != null && <> (MAP {p.startingPrice.toLocaleString('fr-FR')} €)</>}
      </>
    );
  }
  if (p.status === 'unsold') {
    return (
      <>
        invendu, MAP <strong>{p.startingPrice != null ? `${p.startingPrice.toLocaleString('fr-FR')} €` : '–'}</strong>
      </>
    );
  }
  return (
    <>
      {statusLabel(p.status)}, MAP <strong>{p.startingPrice != null ? `${p.startingPrice.toLocaleString('fr-FR')} €` : '–'}</strong>
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

function historyPassageHref(p: VehiclePassage): string {
  if (p.openMode === 'vpauto' && p.sourceUrl) {
    return p.sourceUrl;
  }

  return browser.runtime.getURL(`/history-snapshot.html?snapshotId=${p.snapshotId}`);
}
