import React from 'react';
import type { MatchResult, VehicleSnapshot } from '@vpauto/shared';

interface Props {
  items: MatchResult[];
  current: VehicleSnapshot;
}

export default function TabSimilar({ items, current }: Props) {
  if (items.length === 0) {
    return (
      <div className="vpa-status">
        <div className="vpa-status-icon">🔍</div>
        <div className="vpa-status-title">Aucun véhicule similaire</div>
        <div className="vpa-status-sub">
          Aucun véhicule comparable n'a encore été enregistré dans la base.
        </div>
      </div>
    );
  }

  const byLevel = {
    same_model: items.filter((m) => m.level === 'same_model'),
    similar: items.filter((m) => m.level === 'similar'),
  };

  return (
    <>
      {byLevel.same_model.length > 0 && (
        <div className="vpa-section">
          <div className="vpa-section-title">🎯 Même modèle ({byLevel.same_model.length})</div>
          {byLevel.same_model.map((m) => <SimilarCard key={m.vehicleId} match={m} current={current} />)}
        </div>
      )}
      {byLevel.similar.length > 0 && (
        <div className="vpa-section">
          <div className="vpa-section-title">🔗 Similaires ({byLevel.similar.length})</div>
          {byLevel.similar.map((m) => <SimilarCard key={m.vehicleId} match={m} current={current} />)}
        </div>
      )}
    </>
  );
}

function SimilarCard({ match, current }: { match: MatchResult; current: VehicleSnapshot }) {
  const s = match.snapshot;
  const scoreClass = match.score >= 80 ? 'score-high' : match.score >= 60 ? 'score-medium' : 'score-low';

  const kmDiff = s.mileage && current.mileage ? s.mileage - current.mileage : null;
  const priceDiff = s.startingPrice && current.startingPrice ? s.startingPrice - current.startingPrice : null;

  return (
    <div className="vpa-similar-card">
      {s.photoUrls?.[0] && (
        <img className="vpa-similar-photo" src={s.photoUrls[0]} alt={s.model} />
      )}
      <div className="vpa-similar-body">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
          <div className="vpa-similar-title">{s.brand} {s.version || s.model}</div>
          <span className={`vpa-score ${scoreClass}`}>{match.score}%</span>
        </div>
        <div className="vpa-similar-meta">
          <span>📅 {s.year}</span>
          <span className={kmDiff !== null ? (kmDiff < 0 ? 'diff-positive' : kmDiff > 0 ? 'diff-negative' : '') : ''}>
            🛣️ {s.mileage?.toLocaleString('fr-FR')} km{kmDiff !== null && kmDiff !== 0 ? ` (${kmDiff > 0 ? '+' : ''}${kmDiff.toLocaleString('fr-FR')})` : ''}
          </span>
          <span>📍 {s.city}</span>
          {s.startingPrice && (
            <span className={priceDiff !== null ? (priceDiff < 0 ? 'diff-positive' : priceDiff > 0 ? 'diff-negative' : '') : ''}>
              💶 {s.startingPrice.toLocaleString('fr-FR')} €{priceDiff !== null && priceDiff !== 0 ? ` (${priceDiff > 0 ? '+' : ''}${priceDiff.toLocaleString('fr-FR')})` : ''}
            </span>
          )}
        </div>
        <div style={{ fontSize: 10, color: '#888', marginTop: 3 }}>
          {match.reasons.slice(0, 3).join(' · ')}
        </div>
        {s.sourceUrl && (
          <a href={s.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: 10, color: '#1e40af', marginTop: 3, display: 'inline-block' }}>
            🔗 Voir la fiche
          </a>
        )}
      </div>
    </div>
  );
}
