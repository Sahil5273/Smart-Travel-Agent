import { useState } from 'react';
import { runAgent, respondToAgent } from './api';
import './App.css';

const DEMO_GOAL = 'Plan a trip to Jaipur under ₹15,000';

const LOG_ICONS = {
  thought: '💭',
  action: '⚡',
  observation: '👁',
  user_input: '✋',
  system: '⚙️',
};

function formatCost(amount) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amount);
}

export default function App() {
  const [goal, setGoal] = useState(DEMO_GOAL);
  const [sessionId, setSessionId] = useState(null);
  const [status, setStatus] = useState('idle');
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
      const data = await respondToAgent({
        sessionId,
        userChoice: optionId,
      });

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
    <div className="app">
      <header className="header">
        <div className="header-badge">MERN · Agentic AI</div>
        <h1>Smart Travel Agent</h1>
        <p>Plan optimized trips with human-in-the-loop decision making</p>
      </header>

      <main className="layout">
        <section className="panel input-panel">
          <label htmlFor="goal">Your travel goal</label>
          <textarea
            id="goal"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="e.g. Plan a trip to Udaipur under ₹15,000"
            rows={3}
            disabled={loading}
          />
          <button
            className="btn-primary"
            onClick={handlePlanTrip}
            disabled={loading || !goal.trim()}
          >
            {loading && status === 'idle' ? 'Planning…' : 'Plan Trip'}
          </button>

          {sessionId && (
            <p className="session-meta">
              Session: <code>{sessionId}</code>
            </p>
          )}
        </section>

        <section className="panel output-panel">
          {error && <div className="alert error">{error}</div>}

          {status === 'idle' && !error && (
            <div className="empty-state">
              <span className="empty-icon">🗺️</span>
              <p>Enter a goal and click Plan Trip to start the agent.</p>
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
                <span>{finalPlan.destination}</span>
                <span>{finalPlan.durationDays} days</span>
                <span>{formatCost(finalPlan.estimatedCostINR)}</span>
                <span className="plan-source">via {finalPlan.generatedBy}</span>
              </div>

              <div className="itinerary">
                {finalPlan.itinerary?.map((day) => (
                  <div key={day.day} className="day-card">
                    <h3>Day {day.day}</h3>
                    <ul>
                      {day.activities.map((activity) => (
                        <li key={activity}>{activity}</li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>

              {finalPlan.highlights?.length > 0 && (
                <div className="extras">
                  <h4>Highlights</h4>
                  <ul>
                    {finalPlan.highlights.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                </div>
              )}

              {finalPlan.packingTips?.length > 0 && (
                <div className="extras">
                  <h4>Packing Tips</h4>
                  <ul>
                    {finalPlan.packingTips.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </div>
              )}

              {finalPlan.notes?.length > 0 && (
                <div className="notes">
                  {finalPlan.notes.map((note) => (
                    <p key={note}>ℹ️ {note}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
