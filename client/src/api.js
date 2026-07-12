const API_BASE = '';

export async function runAgent({ userId, sessionId, userGoal }) {
  const res = await fetch(`${API_BASE}/api/agent/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, sessionId, userGoal }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Agent run failed');
  return data;
}

export async function respondToAgent({ sessionId, userChoice }) {
  const res = await fetch(`${API_BASE}/api/agent/respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, userChoice }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Agent respond failed');
  return data;
}
