import React, { useEffect, useState, useCallback } from 'react';
import type { VehicleSnapshot, VehicleHistory, VehicleBadge, MatchResult } from '@vpauto/shared';
import { api } from '../lib/api';
import TabHistory from './TabHistory';
import TabSameModel from './TabSameModel';
import TabSimilar from './TabSimilar';

type Tab = 'history' | 'model' | 'similar';

interface CurrentVehicle {
  snapshot: VehicleSnapshot;
  vehicleId: number | null;
  isNew: boolean;
}

export default function SidePanel() {
  const [tab, setTab] = useState<Tab>('history');
  const [current, setCurrent] = useState<CurrentVehicle | null>(null);
  const [history, setHistory] = useState<VehicleHistory | null>(null);
  const [badges, setBadges] = useState<VehicleBadge[]>([]);
  const [sameModel, setSameModel] = useState<{ vehicleId: number; snapshot: VehicleSnapshot }[]>([]);
  const [similar, setSimilar] = useState<MatchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [apiOk, setApiOk] = useState<boolean | null>(null);

  // Check API health on mount
  useEffect(() => {
    api.healthCheck().then((r) => setApiOk(r?.status === 'ok' ?? false));
  }, []);

  // Listen for vehicle detection from content script
  useEffect(() => {
    const handler = (msg: { type: string; payload: unknown }) => {
      if (msg.type === 'VEHICLE_DETECTED') {
        setCurrent(msg.payload as CurrentVehicle);
        setHistory(null);
        setBadges([]);
        setSameModel([]);
        setSimilar([]);
        setTab('history');
      }
    };
    browser.runtime.onMessage.addListener(handler);
    return () => browser.runtime.onMessage.removeListener(handler);
  }, []);

  // Also load from storage on mount (in case we missed the message)
  useEffect(() => {
    browser.storage.local.get('currentVehicle').then((data) => {
      if (data.currentVehicle) {
        setCurrent(data.currentVehicle as CurrentVehicle);
      }
    });
  }, []);

  // Load data when current vehicle changes
  useEffect(() => {
    if (!current?.vehicleId) return;
    setLoading(true);
    const vid = current.vehicleId;

    Promise.all([
      api.getHistory(vid),
      api.getBadges(vid),
      api.getSameModel(current.snapshot.brand, current.snapshot.model, vid),
      api.findSimilar(current.snapshot, vid),
    ]).then(([h, b, sm, sim]) => {
      setHistory(h);
      setBadges(b ?? []);
      setSameModel(sm ?? []);
      setSimilar((sim ?? []).filter((m) => m.level !== 'exact'));
      setLoading(false);
    });
  }, [current?.vehicleId]);

  return (
    <div className="vpa-panel">
      <Header snapshot={current?.snapshot} />

      {apiOk === false && (
        <div className="vpa-offline">
          ⚠️ Backend non disponible — démarrez <code>npm run dev</code> dans <code>packages/backend</code>
        </div>
      )}

      {!current ? (
        <div className="vpa-status" style={{ flex: 1 }}>
          <div className="vpa-status-icon">🔍</div>
          <div className="vpa-status-title">Aucun véhicule détecté</div>
          <div className="vpa-status-sub">
            Naviguez vers une fiche véhicule VPauto pour voir son historique et ses comparaisons.
          </div>
        </div>
      ) : (
        <>
          <IdentityCard snapshot={current.snapshot} badges={badges} isNew={current.isNew} />

          <div className="vpa-tabs">
            <button className={`vpa-tab${tab === 'history' ? ' active' : ''}`} onClick={() => setTab('history')}>
              📋 Historique
            </button>
            <button className={`vpa-tab${tab === 'model' ? ' active' : ''}`} onClick={() => setTab('model')}>
              🚗 Même modèle{sameModel.length > 0 ? ` (${sameModel.length})` : ''}
            </button>
            <button className={`vpa-tab${tab === 'similar' ? ' active' : ''}`} onClick={() => setTab('similar')}>
              🔗 Similaires{similar.length > 0 ? ` (${similar.length})` : ''}
            </button>
          </div>

          <div className="vpa-content">
            {loading ? (
              <div className="vpa-loading">
                <div className="vpa-spinner" />
                Chargement…
              </div>
            ) : (
              <>
                {tab === 'history' && <TabHistory history={history} snapshot={current.snapshot} vehicleId={current.vehicleId} />}
                {tab === 'model' && <TabSameModel items={sameModel} current={current.snapshot} />}
                {tab === 'similar' && <TabSimilar items={similar} current={current.snapshot} />}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Header({ snapshot }: { snapshot?: VehicleSnapshot }) {
  return (
    <div className="vpa-header">
      <div className="vpa-header-logo">🏎️</div>
      <div className="vpa-header-title">
        <h1>VPauto Assistant</h1>
        <p>{snapshot ? `${snapshot.brand} ${snapshot.model}` : 'En attente d\'un véhicule…'}</p>
      </div>
    </div>
  );
}

function IdentityCard({ snapshot, badges, isNew }: { snapshot: VehicleSnapshot; badges: VehicleBadge[]; isNew: boolean }) {
  const photo = snapshot.photoUrls?.[0];
  return (
    <div className="vpa-identity">
      {photo && <img className="vpa-identity-photo" src={photo} alt={snapshot.model} />}
      <div className="vpa-identity-body">
        <div className="vpa-identity-title">{snapshot.brand} {snapshot.version || snapshot.model}</div>
        <div className="vpa-identity-sub">
          {snapshot.year} · {snapshot.mileage?.toLocaleString('fr-FR')} km · {snapshot.city}
          {snapshot.startingPrice && ` · Mise à prix : ${snapshot.startingPrice.toLocaleString('fr-FR')} €`}
        </div>
        <div className="vpa-badges">
          {isNew && <span className="vpa-badge vpa-badge-new">🆕 Nouveau</span>}
          {badges.map((b, i) => (
            <span key={i} className={`vpa-badge vpa-badge-${b.type === 'new' ? 'new' : b.type === 'seen' ? 'seen' : b.type === 'price_drop' ? 'drop' : b.type === 'price_up' ? 'up' : 'again'}`}>
              {b.type === 'price_drop' ? '↓' : b.type === 'price_up' ? '↑' : ''} {b.label}{b.detail ? ` ${b.detail}` : ''}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
