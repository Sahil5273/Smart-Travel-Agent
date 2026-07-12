import { useState } from 'react';
import { runAgent, respondToAgent } from './api';
import './AgentDashboard.css';

const DEMO_GOAL = 'Plan a 4-day trip from Delhi to Jaipur under ₹18,000';

const LOG_ICONS = {
  thought: '💭',
  action: '⚡',
  observation: '👁',
  user_input: '✋',
  system: '⚙️',
};

function formatCost(amount) {
  if (!amount && amount !== 0) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}

function TravelRoutingCard({ plan, tripParams }) {
  const t = plan?.transitLogistics;
  if (!t) return null;

  return (
    <div className="routing-card">
      <div className="routing-header">
        <span className="routing-icon">🛤️</span>
        <div>
          <h3>Travel & Routing</h3>
          <p className="routing-route">
            {plan.origin || tripParams?.origin} → {plan.destination || tripParams?.destination}
          </p>
        </div>
      </div>

      <div className="routing-grid">
        <div className="routing-stat">
          <span className="stat-label">Mode</span>
          <span className="stat-value">{t.mode}</span>
        </div>
        <div className="routing-stat">
          <span className="stat-label">Route</span>
          <span className="stat-value">{t.route}</span>
        </div>
        <div className="routing-stat">
          <span className="stat-label">Distance</span>
          <span className="stat-value">{t.distanceKm} km</span>
        </div>
        <div className="routing-stat">
          <span className="stat-label">Transit time</span>
          <span className="stat-value">{t.durationHours}h</span>
        </div>
        <div className="routing-stat">
          <span className="stat-label">Transit cost</span>
          <span className="stat-value">{formatCost(t.estimatedCostINR)}</span>
        </div>
      </div>

      <p className="routing-details">{t.details}</p>
    </div>
  );
}

function DaySlot({ label, items }) {
  if (!items?.length) return null;
  return (
    <div className="time-slot">
      <h4>{label}</h4>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

export default function AgentDashboard() {
  const [goal, setGoal] = useState(DEMO_GOAL);
  const [sessionId, setSessionId] = useState(null);
  const [status, setStatus] = useState('idle');
  const [tripParams, setTripParams] = useState(null);
  const [logs, setLogs] = useState([]);
  const [conflictReason, setConflictReason] = useState('');
  const [pendingOptions, setPendingOptions] = useState([]);
  const [finalPlan, setFinalPlan] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handlePlanTrip() {
    if (!goal.trim()) return;
    setLoading(true);
    setError('');
    setFinalPlan(null);
    setPendingOptions([]);
    setConflictReason('');
    setTripParams(null);
    setLogs([]);

    const newSessionId = `session-${Date.now()}`;
    setSessionId(newSessionId);

    try {
      const data = await runAgent({
        userId: 'demo-user',
        sessionId: newSessionId,
        userGoal: goal.trim(),
      });

      setStatus(data.status);
      setLogs(data.logs || []);
      if (data.tripParams) setTripParams(data.tripParams);

      if (data.status === 'AWAITING_USER_INPUT') {
        setConflictReason(data.conflictReason || '');
        setPendingOptions(data.pendingOptions || []);
      } else if (data.status === 'COMPLETED') {
        setFinalPlan(data.finalPlan);
      }
    } catch (err) {
      setError(err.message);
      setStatus('error');
    } finally {
      setLoading(false);
    }
  }

  async function handleChooseOption(optionId) {
    if (!sessionId) return;
    setLoading(true);
    setError('');

    try {
      const data = await respondToAgent({ sessionId, userChoice: optionId });
      setStatus(data.status);
      setLogs(data.logs || []);
      setPendingOptions([]);
      setFinalPlan(data.finalPlan);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="dashboard">
      <header className="header">
        <div className="header-badge">Agentic AI · Point-to-Point Routing</div>
        <h1>Smart Travel Agent</h1>
        <p>Gemini structured extraction + tool calling + human-in-the-loop</p>
      </header>

      <main className="layout">
        <section className="panel input-panel">
          <label htmlFor="goal">Your travel goal</label>
          <textarea
            id="goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Plan a trip from Delhi to Udaipur under ₹15,000 for 3 days"
            rows={3}
            disabled={loading}
          />
          <button
            className="btn-primary"
            onClick={handlePlanTrip}
            disabled={loading || !goal.trim()}
          >
            {loading && status === 'idle' ? 'Agent running…' : 'Plan Trip'}
          </button>
          {sessionId && (
            <p className="session-meta">Session: <code>{sessionId}</code></p>
          )}
          {tripParams && (
            <div className="extracted-params">
              <span>{tripParams.origin} → {tripParams.destination}</span>
              <span>{formatCost(tripParams.budget)}</span>
              <span>{tripParams.durationDays} days</span>
            </div>
          )}
        </section>

        <section className="panel output-panel">
          {error && <div className="alert error">{error}</div>}

          {status === 'idle' && !error && (
            <div className="empty-state">
              <span className="empty-icon">🗺️</span>
              <p>Try: "Plan a trip from Mumbai to Goa under ₹12,000 for 3 days"</p>
            </div>
          )}

          {logs.length > 0 && (
            <div className="logs-section">
              <h2>Agent Activity</h2>
              <ul className="log-list">
                {logs.map((log, i) => (
                  <li key={i} className={`log-item log-${log.type}`}>
                    <span className="log-icon">{LOG_ICONS[log.type] || '•'}</span>
                    <div>
                      <span className="log-type">{log.type}</span>
                      <p>{log.message}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {status === 'AWAITING_USER_INPUT' && pendingOptions.length > 0 && (
            <div className="options-section">
              <h2>Decision Required</h2>
              <p className="conflict-reason">{conflictReason}</p>
              <div className="options-grid">
                {pendingOptions.map((opt) => (
                  <button
                    key={opt.id}
                    className="option-card"
                    onClick={() => handleChooseOption(opt.id)}
                    disabled={loading}
                  >
                    <strong>{opt.label}</strong>
                    <p>{opt.description}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {finalPlan && (
            <div className="plan-section">
              <h2>Your Itinerary</h2>
              {finalPlan.summary && <p className="plan-summary">{finalPlan.summary}</p>}

              <div className="plan-meta">
                <span>{finalPlan.origin} → {finalPlan.destination}</span>
                <span>{finalPlan.durationDays} days</span>
                <span>{formatCost(finalPlan.estimatedCostINR)}</span>
                <span className="plan-source">via {finalPlan.generatedBy}</span>
              </div>

              <TravelRoutingCard plan={finalPlan} tripParams={tripParams} />

              <div className="daily-itinerary">
                <h3>Day-by-Day Breakdown</h3>
                {finalPlan.dailyItinerary?.map((day) => (
                  <div key={day.day} className="day-card-detailed">
                    <h4>Day {day.day}</h4>
                    <div className="day-slots">
                      <DaySlot label="🌅 Morning" items={day.morning} />
                      <DaySlot label="☀️ Afternoon" items={day.afternoon} />
                      <DaySlot label="🌙 Evening" items={day.evening} />
                    </div>
                  </div>
                ))}
              </div>

              {finalPlan.localTransport?.length > 0 && (
                <div className="extras">
                  <h4>Local Transport</h4>
                  <ul>
                    {finalPlan.localTransport.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}

              {finalPlan.weatherPackingList?.length > 0 && (
                <div className="extras">
                  <h4>Weather & Packing</h4>
                  <ul>
                    {finalPlan.weatherPackingList.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
